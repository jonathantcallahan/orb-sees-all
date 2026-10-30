import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { claudeSessionUrl, resumeSessionUrl, sessionPrompt, startPrompt } from "../openInClaude";
import { clearAssessment, clearTaskCheck, setPriorityOverride, saveDescriptionOverride, setTaskState, updateManualTask, type StoredPlan, type StoredTaskCheck } from "../db";
import { assessPendingTasks, checkTask, planTask } from "../jobs";
import type { Assessment, Automation, FollowUp, ManualAssessment, Priority, ProjectPriority } from "../schema";
import { ago, formatMinutes, taskPriority, type EffectivePriority, type TaskStatus } from "../tasks";
import { useJobStatus } from "../useAppData";
import { localDate } from "../scheduler";
import { CloseIcon, ExternalLink, Spinner } from "./common";
import { linkSession, useSessionProgress, type SessionLink, type SessionProgress, type StepProgress, type StepState } from "../sessions";
import { LinkChips } from "./LinkChips";
import { CLAUDE_ICON } from "../linkIcons";
import { collectLinks } from "../links";

export interface CardTask {
  id: string;
  title: string;
  description?: string | null;
  link?: string | null;
  due?: string | null;
  requester?: string | null;
  follow_up?: FollowUp | null;
  source: "manual" | "slack" | "email" | "project";
  status: TaskStatus;
  /** YYYY-MM-DD the task was planned for, if it's in Today. */
  todayOn: string | null;
  /** Set when the task was planned for an earlier day and is still open. */
  carriedFrom?: string | null;
  project?: { id: string; name: string };
  /** The task is holding its project up. */
  blocking?: boolean;
  /** The Orb recommends doing this today to move a P0 project forward. */
  recommended?: boolean;
  /** A local repo for the task's project, so Open in Claude starts there. */
  repoFolder?: string | null;
  /** Priority of the project the task belongs to; tasks in P0 projects are critical. */
  projectPriority?: ProjectPriority | null;
  /** Links from other sources of the same task, folded into this card. */
  aliasLinks?: string[];
  /** From the refresh that found the task; the user's own tasks are assessed separately. */
  assessment?: Assessment | null;
  done: boolean;
}

const SOURCE_LABEL = { manual: null, slack: "Slack", email: "Email", project: null } as const;

/** The full plan in a centered modal; long plans scroll inside it. Esc or the backdrop closes it. */
function PlanModal({ title, stored, actions, onClose }: { title: string; stored: StoredPlan; actions?: ReactNode; onClose: () => void }) {
  const { plan } = stored;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Rendered into <body> so the scrolling column can't clip or offset it.
  return createPortal(
    <div className="modal-backdrop plan-modal-backdrop" onClick={onClose}>
      <div className="modal plan-modal" role="dialog" aria-label={`Plan for ${title}`} onClick={(e) => e.stopPropagation()}>
        <header className="column-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} title="Close" aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        <p className="plan-approach">{plan.approach}</p>
        <ol className="plan-modal-steps">
          {plan.steps.map((step, i) => (
            <li key={i}>
              <StepCircle />
              <div>
                <ExternalLink href={step.link} className="plan-step-title">
                  {step.title}
                </ExternalLink>
                {step.by === "you" && <span className="step-by you">Human input needed</span>}
                {step.detail && <div className="muted small">{step.detail}</div>}
              </div>
            </li>
          ))}
        </ol>
        {plan.open_questions.length > 0 && (
          <section>
            <h4>Open questions</h4>
            <ul className="small plan-list">
              {plan.open_questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </section>
        )}
        {plan.sources.length > 0 && (
          <section>
            <h4>Sources</h4>
            <div className="chips">
              {plan.sources.map((src) => (
                <ExternalLink key={src.link} href={src.link} className="chip">
                  {src.title}
                </ExternalLink>
              ))}
            </div>
          </section>
        )}
        {actions && <footer className="plan-modal-actions">{actions}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** A description cut to two lines with "…" and More when it runs longer; Less and Edit follow inline. */
/**
 * Longest prefix of `text` that, with "…" and the inline actions after it, fits
 * in two lines of `p`. Measured on a hidden copy at the same width; null if the
 * whole text already fits.
 */
function fitTwoLines(p: HTMLParagraphElement, text: string, actionsHtml: string): number | null {
  const lineHeight = parseFloat(getComputedStyle(p).lineHeight);
  const probe = p.cloneNode(false) as HTMLParagraphElement;
  probe.style.cssText = `position:absolute;visibility:hidden;left:0;top:0;width:${p.clientWidth}px;`;
  p.parentElement!.appendChild(probe);
  const fits = (body: string) => {
    probe.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = body;
    probe.appendChild(span);
    probe.insertAdjacentHTML("beforeend", actionsHtml);
    return probe.offsetHeight <= lineHeight * 2 + 1;
  };
  try {
    if (fits(text)) return null;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(`${text.slice(0, mid).trimEnd()}…`)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  } finally {
    probe.remove();
  }
}

function Description({ text, onEdit, actions }: { text: string; onEdit?: () => void; actions?: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  /** Characters shown when collapsed, or null when the whole text fits. */
  const [cut, setCut] = useState<number | null>(null);

  useLayoutEffect(() => {
    const p = ref.current;
    if (!p || expanded) return;
    const measure = () => setCut(fitTwoLines(p, text, ""));
    measure();
    // Re-fit when the card changes width.
    const observer = new ResizeObserver(measure);
    observer.observe(p);
    return () => observer.disconnect();
  }, [text, expanded]);

  const truncated = !expanded && cut !== null;
  return (
    <>
      <p ref={ref} className="description small">
        <span>{truncated ? `${text.slice(0, cut).trimEnd()}…` : text}</span>
      </p>
      <div className="description-actions small">
        {truncated && (
          <button className="link-button small more-link" onClick={() => setExpanded(true)}>
            More
          </button>
        )}
        {expanded && (
          <button className="link-button small more-link" onClick={() => setExpanded(false)}>
            Less
          </button>
        )}
        {onEdit && (
          <button className="link-button small more-link" onClick={onEdit}>
            Edit
          </button>
        )}
        {actions}
      </div>
    </>
  );
}

/** Edits a task's description in a centered modal. Esc cancels; ⌘↩ saves. */
function DescriptionEditor({
  title,
  initial,
  onSave,
  onCancel,
}: {
  title: string;
  initial: string;
  onSave: (text: string | null) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const save = () => {
    const next = text.trim() || null;
    if (next === (initial.trim() || null)) onCancel();
    else onSave(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop plan-modal-backdrop" onClick={onCancel}>
      <div className="modal plan-modal" role="dialog" aria-label={`Edit description for ${title}`} onClick={(e) => e.stopPropagation()}>
        <header className="column-header">
          <h2>{title}</h2>
        </header>
        <textarea
          autoFocus
          className="description-editor"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
          placeholder="What's involved, who it's for, links…"
        />
        <footer className="plan-modal-actions edit-actions">
          <button className="cta-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="cta-primary" onClick={save} title="Save, then plan again from the new description (⌘↩)">
            Save
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

const PRIORITY_LABEL: Record<EffectivePriority, string> = {
  blocking: "Blocking",
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function RecommendedBadge() {
  return (
    <span
      className="badge recommended icon-only"
      role="img"
      aria-label="Recommended"
      title="Recommended: the Orb suggests doing this today to move a P0 project forward"
    >
      <svg className="sparkle" width="9" height="9" viewBox="0 0 8 8" aria-hidden>
        <path d="M4 0Q4.6 3.4 8 4Q4.6 4.6 4 8Q3.4 4.6 0 4Q3.4 3.4 4 0Z" fill="currentColor" />
      </svg>
    </span>
  );
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
};

const DISMISS = "dismiss";

/** Drag-and-drop payload type for moving tasks in and out of Today. */
export const TASK_DRAG_TYPE = "application/x-orb-task";

const PICKABLE: Priority[] = ["critical", "high", "medium", "low"];
const AUTO = "__auto";

/**
 * The priority badge, with a menu laid over it to set the priority by hand.
 * Blocking can't be overridden, so it stays a plain badge.
 */
function PriorityBadge({
  task,
  priority,
  manual,
  automatic,
  onChange,
}: {
  task: CardTask;
  priority: EffectivePriority | null;
  manual: Priority | undefined;
  automatic: EffectivePriority | null;
  onChange: () => void;
}) {
  if (priority === "blocking") {
    return (
      <span className="badge priority blocking" title="This task is holding its project up, so it's always top priority">
        {PRIORITY_LABEL.blocking}
      </span>
    );
  }
  return (
    <span
      className={`badge priority menu-badge ${priority ?? "unset hover-only"}${manual ? " manual" : ""}`}
      title={manual ? "Priority set by you" : "Set the priority"}
    >
      {priority ? PRIORITY_LABEL[priority] : "Priority"}
      <select
        value={manual ?? AUTO}
        aria-label="Priority"
        onChange={async (e) => {
          await setPriorityOverride(task.id, e.target.value === AUTO ? null : (e.target.value as Priority));
          onChange();
        }}
      >
        {PICKABLE.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABEL[p]}
          </option>
        ))}
        <option disabled>──────</option>
        <option value={AUTO}>Automatic{automatic ? ` (${PRIORITY_LABEL[automatic]})` : ""}</option>
      </select>
    </span>
  );
}

function StatusSelect({ task, onChange }: { task: CardTask; onChange: () => void }) {
  // A badge showing the status, with the native menu laid invisibly over it so it sizes to its text.
  return (
    <span className={`badge status-badge ${task.status}`}>
      {STATUS_LABEL[task.status]}
      <select
        value={task.status}
        aria-label="Status"
        onChange={async (e) => {
          // Dismiss lives in the same menu: it hides the task rather than setting a status.
          await setTaskState(task.id, e.target.value === DISMISS ? { dismissed: true } : { status: e.target.value as TaskStatus });
          onChange();
        }}
      >
        {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
        <option disabled>──────</option>
        <option value={DISMISS}>Dismiss</option>
      </select>
    </span>
  );
}

function carriedLabel(day: string): string {
  const days = Math.round((Date.parse(localDate(new Date())) - Date.parse(day)) / 86_400_000);
  return days === 1 ? "from yesterday" : `from ${days} days ago`;
}

const AUTOMATION_LABEL: Record<Automation, string> = {
  human: "You do it",
  assisted: "Orb can help",
  claude: "Orb can do it",
};

/**
 * A high-level view of the plan: each step's title beside a numbered circle.
 * With no plan yet, the next action stands in as step one. `action` (e.g.
 * Approve & start) sits inside, under the steps.
 */
/** A small dashed ring marking a plan step. */
/** A plan step's marker: dashed when not started, turning while in progress, checked when done. */
function StepCircle({ state }: { state?: StepState }) {
  return (
    <svg className={`step-circle${state ? ` ${state}` : ""}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      {state === "done" ? (
        <>
          <circle cx="6" cy="6" r="5.5" fill="currentColor" />
          <path d="M3.4 6.2 5.2 8l3.4-3.6" fill="none" stroke="var(--bg)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.4 1.8" />
      )}
    </svg>
  );
}

interface OutlineStep {
  title: string;
  /** Who does it; null for older plans that didn't say. */
  by: "claude" | "you" | null;
  /** What the linked Claude session last reported for this step. */
  progress?: StepProgress;
}

function PlanOutline({ steps, action, planning = false }: { steps: OutlineStep[]; action?: ReactNode; planning?: boolean }) {
  if (steps.length === 0 && !action) return null;
  return (
    <div className="plan-outline">
      {/* No steps yet: two placeholder rows where the plan will go; they pulse while it's being written. */}
      {steps.length === 0 && (
        <ol className={`plan-outline-steps skeleton${planning ? " loading" : ""}`} aria-hidden>
          {[72, 54].map((width) => (
            <li key={width}>
              <StepCircle />
              <span className="skeleton-bar" style={{ width: `${width}%` }} />
            </li>
          ))}
        </ol>
      )}
      {steps.length > 0 && (
        <ol className="plan-outline-steps">
          {steps.map((step, i) => (
            <li key={i} className={[step.by && `by-${step.by}`, step.progress && `step-${step.progress.state}`].filter(Boolean).join(" ") || undefined}>
              <StepCircle state={step.progress?.state} />
              <span className="small">
                {step.title}
                {step.by === "you" && <span className="step-by you">Human input needed</span>}
                {step.progress?.state === "waiting" && (
                  <span className="step-waiting">Waiting on you{step.progress.note ? `: ${step.progress.note}` : ""}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {action}
    </div>
  );
}

function AssessmentView({
  assessment,
  steps,
  actions,
  planning,
  onAddDetails,
}: {
  assessment: Assessment;
  /** Plan steps tagged by who does them, shown inside the assessment. */
  steps: OutlineStep[];
  /** Approve & start and Show plan details, under the steps. */
  actions?: ReactNode;
  /** A plan is being written. */
  planning: boolean;
  onAddDetails?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {assessment.needs_details && (
        <div className="needs-details small">
          <strong>Needs more detail.</strong> {assessment.details_question}
          {onAddDetails && (
            <button className="link-button small" onClick={onAddDetails}>
              Add details
            </button>
          )}
        </div>
      )}
      <div className={`automation ${assessment.automation}`}>
        <button className="automation-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="automation-kind">{AUTOMATION_LABEL[assessment.automation]}</span>
          <svg className={`disclosure${open ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <>
            <span className="small suggestion">{assessment.suggestion}</span>
            <PlanOutline steps={steps} action={actions} planning={planning} />
          </>
        )}
      </div>
    </>
  );
}

/** Where the linked Claude session is: still being looked for, or how far it has got. */
function SessionStatus({ progress, steps }: { progress: SessionProgress | null; steps: OutlineStep[] }) {
  if (!progress) return null;
  if (!progress.found) return <span className="timestamp small session-status">Looking for the Claude session…</span>;
  const claudeSteps = steps.filter((st) => st.by !== "you");
  const done = claudeSteps.filter((st) => st.progress?.state === "done").length;
  const waiting = steps.some((st) => st.progress?.state === "waiting");
  return (
    <span className="timestamp small session-status" title="Orb follows the session's progress reports">
      {waiting ? "Session is waiting on you" : `Session: ${done} of ${claudeSteps.length} steps done`}
      {progress.updatedAt && ` · ${ago(new Date(progress.updatedAt).toISOString())}`}
    </span>
  );
}

const CHECK_VERDICT: Record<StoredTaskCheck["verdict"], string> = {
  looks_right: "Looks right",
  already_done: "Already done",
  not_needed: "No longer needed",
  captured_wrong: "Captured wrong",
  duplicate: "Duplicate",
  unclear: "Unclear",
};

/** The result of a double check: verdict, what each check found, evidence, and the fix it points to. */
function TaskCheckResult({
  check,
  onDone,
  onDismiss,
  onApply,
  onHide,
}: {
  check: StoredTaskCheck;
  onDone: () => void;
  onDismiss: () => void;
  onApply: (description: string) => void;
  onHide: () => void;
}) {
  const corrected = check.corrected_description?.trim();
  return (
    <div className={`check-result task-check ${check.verdict}`}>
      <div className="check-head small">
        <span className="check-verdict">{CHECK_VERDICT[check.verdict]}</span>
        <span className="timestamp">checked {ago(check.at)}</span>
      </div>
      <p className="small">{check.summary}</p>
      {check.findings.length > 0 && (
        <ul className="check-findings small">
          {check.findings.map((f) => (
            <li key={f.check} className={f.ok ? "ok" : "flag"}>
              <span className="finding-mark" aria-label={f.ok ? "Passed" : "Flagged"}>{f.ok ? "✓" : "!"}</span>
              <span>
                <span className="finding-check">{f.check}:</span> <span className="muted">{f.finding}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {corrected && <p className="small corrected">Suggested description: {corrected}</p>}
      <div className="check-actions small">
        {check.evidence.map((e) => (
          <ExternalLink key={e.link} href={e.link} className="chip">
            {e.title}
          </ExternalLink>
        ))}
        <span className="check-buttons">
          {corrected && (
            <button className="link-button small" onClick={() => onApply(corrected)} title="Use this description and plan again">
              Apply correction
            </button>
          )}
          {check.verdict === "already_done" && (
            <button className="link-button small" onClick={onDone}>
              Mark done
            </button>
          )}
          {(check.verdict === "not_needed" || check.verdict === "duplicate") && (
            <button className="link-button small" onClick={onDismiss}>
              Dismiss task
            </button>
          )}
          <button className="link-button small muted" onClick={onHide}>
            Hide
          </button>
        </span>
      </div>
    </div>
  );
}

export function TaskCard({
  task,
  plan,
  planning,
  manualAssessment,
  assessing,
  check,
  sessionLink,
  manualPriority,
  openTitles = [],
  compact = false,
  onChange,
}: {
  task: CardTask;
  plan: StoredPlan | undefined;
  planning: boolean;
  /** Claude's assessment of one of the user's own tasks. */
  manualAssessment?: ManualAssessment;
  /** An assessment run is in progress and this task has none yet. */
  assessing: boolean;
  /** Claude's latest double check of the task. */
  check?: StoredTaskCheck;
  /** The Claude Code session Orb opened for this task, if any. */
  sessionLink?: SessionLink;
  /** A priority the user set by hand, overriding Claude's. */
  manualPriority?: Priority;
  /** Titles of the user's other open tasks, for spotting duplicates. */
  openTitles?: string[];
  /** Show a one-line row (title, priority, estimate, status) until clicked. */
  compact?: boolean;
  onChange: () => void;
}) {
  const [showPlan, setShowPlan] = useState(false);
  const planStatus = useJobStatus(`plan:${task.id}`);
  const checkStatus = useJobStatus(`taskcheck:${task.id}`);
  const progress = useSessionProgress(task.id, sessionLink);
  /** A Claude session has picked this task up; the card follows it from now on. */
  const linked = !!sessionLink?.sessionId;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const manual = task.source === "manual";
  const assessment = manual ? manualAssessment : task.assessment;
  const priority = taskPriority(assessment?.priority, task.projectPriority, task.blocking, manualPriority);
  /** What the priority would be without the user's pick. */
  const automaticPriority = taskPriority(assessment?.priority, task.projectPriority, task.blocking);
  // Show the user's own words when there are any; otherwise Claude's draft.
  const draft = manual && !task.description ? manualAssessment?.description : null;
  const description = task.description || draft;
  const openInClaude = async () => {
    if (linked) {
      openUrl(resumeSessionUrl(sessionLink!.sessionId!));
      return;
    }
    const prompt = sessionPrompt(
      { id: task.id, title: task.title, description, link: task.link, requester: task.requester, projectName: task.project?.name },
      plan?.plan ?? null,
      assessment ? { suggestion: assessment.suggestion, steps: assessment.claude_steps ?? [] } : undefined,
    );
    await linkSession(task.id);
    onChange();
    openUrl(claudeSessionUrl(prompt, task.repoFolder));
  };
  // Every plan step, tagged by who does it; with no plan yet, the steps the assessment says Claude can do.
  // They're numbered in this order in the session's prompt, so its "[orb] step N" reports line up.
  const outlineSteps: OutlineStep[] = (
    plan
      ? plan.plan.steps.map((st) => ({ title: st.title, by: st.by ?? null }))
      : (assessment?.claude_steps ?? []).map((title) => ({ title, by: "claude" as const }))
  ).map((st, i) => ({ ...st, progress: progress?.steps[i + 1] }));
  // Approve & start sends the whole sequence; Claude does every step that isn't the user's.
  const hasClaudeSteps = outlineSteps.some((st) => st.by !== "you");
  const approveAndStart = async () => {
    if (!assessment) return;
    await setTaskState(task.id, { status: "in_progress" });
    await linkSession(task.id);
    onChange();
    const prompt = startPrompt(
      { id: task.id, title: task.title, description, link: task.link, requester: task.requester, projectName: task.project?.name },
      assessment.suggestion,
      outlineSteps,
    );
    openUrl(claudeSessionUrl(prompt, task.repoFolder));
  };
  // Planning lives here, in the Orb section: before a plan, Plan steps leads; after, Approve & start.
  const canPlan = !plan && !planning && !linked && !!description;
  const planActions =
    outlineSteps.length > 0 || planning || canPlan || sessionLink ? (
      <div className="plan-actions">
        {canPlan && (
          <button className="cta-primary" onClick={() => runPlan()} title="Have Claude research the task and plan every step, marking which it can do">
            Plan steps
          </button>
        )}
        {hasClaudeSteps && assessment && !linked && (
          <button
            className={canPlan ? "cta-ghost" : "cta-primary"}
            onClick={approveAndStart}
            title="Mark this in progress and open a Claude Code session with the whole plan; Claude does its steps and asks you for yours"
          >
            Approve & start
          </button>
        )}
        {plan && !planning && (
          <button className="cta-ghost" onClick={() => setShowPlan(true)}>
            Show plan details
          </button>
        )}
        {planning && (
          <span className="muted small">
            <Spinner /> {planStatus ?? "Researching a plan"}…
          </span>
        )}
        {sessionLink && <SessionStatus progress={progress} steps={outlineSteps} />}
      </div>
    ) : null;
  /** Saves an edited description, then has Claude plan again from it. */
  /** Saves an edited description. Before work starts, Claude assesses and plans again from it; once a session is linked, the plan stays as the session has it. */
  const saveDescription = async (next: string | null) => {
    setEditing(false);
    if (manual) {
      await updateManualTask(task.id, { title: task.title, description: next });
      if (!linked) {
        // The old assessment was based on the old text; have Claude look again.
        await clearAssessment(task.id);
        assessPendingTasks().catch(() => {});
      }
    } else {
      await saveDescriptionOverride(task.id, next);
    }
    onChange();
    if (next && !linked) runPlan(next);
  };
  const source =
    task.source === "manual"
      ? "the user's own to-do list"
      : task.project
        ? `the "${task.project.name}" project's Slack channel${task.blocking ? " (this task is blocking the project)" : ""}`
        : task.source;
  const runPlan = (descriptionText: string | null = description ?? null) => {
    planTask({
      id: task.id,
      title: task.title,
      description: descriptionText,
      link: task.link ?? null,
      requester: task.requester ?? null,
      source,
    }).catch(() => {});
  };
  const runCheck = () => {
    checkTask(
      task.id,
      {
        title: task.title,
        description: description ?? null,
        source,
        link: task.link ?? null,
        requester: task.requester ?? null,
        due: task.due ?? null,
        priority,
      },
      openTitles.filter((t) => t !== task.title),
    )
      .then(onChange)
      .catch(() => {});
  };
  const links = collectLinks(
    [
      { url: task.link, title: task.requester ? `${task.requester.split(" ")[0]}'s ${task.source === "email" ? "email" : "message"}` : "Original message" },
      // The same task's other sources (a later message, another channel, a merged task).
      ...(task.aliasLinks ?? []).map((url) => ({ url, title: null })),
      ...(plan?.plan.sources ?? []).map((src) => ({ url: src.link, title: src.title })),
      ...(plan?.plan.steps ?? []).map((st) => ({ url: st.link, title: null })),
      ...(check?.evidence ?? []).map((e) => ({ url: e.link, title: e.title })),
    ],
    [description],
  );
  // Double check follows More / Edit / Show links, shown on hover (and while it runs). Last, so its hidden space sits at the end.
  const checkAction = linked ? null : checkStatus ? (
    <span className="muted small checking" title={checkStatus}>
      <Spinner /> {checkStatus}…
    </span>
  ) : (
    <button
      className="link-button small more-link hover-only"
      onClick={runCheck}
      title="Have Claude check the task was captured right, is still needed, and isn't a duplicate"
    >
      Double check
    </button>
  );
  const linksToggle =
    links.length > 0 ? (
      <button className="link-button small more-link" onClick={() => setLinksOpen(!linksOpen)} aria-expanded={linksOpen}>
        {linksOpen ? "Hide links" : `Show links (${links.length})`}
      </button>
    ) : null;
  const descriptionActions = (
    <>
      {linksToggle}
      {checkAction}
    </>
  );
  const setStateAndRefresh = async (patch: Parameters<typeof setTaskState>[1]) => {
    await setTaskState(task.id, patch);
    onChange();
  };

  // Opens the task in Claude, like the Slack icon next to a project's name opens its channel.
  const claudeIcon = (
    <button
      className="claude-link"
      onClick={(e) => {
        e.stopPropagation();
        openInClaude();
      }}
      title={linked ? "Open the Claude Code session working on this task" : "Open this task in a new Claude Code session"}
      aria-label="Open in Claude"
    >
      <img src={CLAUDE_ICON} width={12} height={12} alt="" />
    </button>
  );

  const drag = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
      e.dataTransfer.effectAllowed = "move";
    },
  };

  if (compact && !expanded) {
    return (
      <article
        className={`card task-row status-${task.status}${task.done ? " done" : ""}`}
        {...drag}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("select")) setExpanded(true);
        }}
        title="Click for details"
      >
        <span className="task-title-wrap">
          <span className="task-title" title={task.title}>
            {task.title}
          </span>
        </span>
        {assessment?.estimate_minutes != null && <span className="estimate">~{formatMinutes(assessment.estimate_minutes)}</span>}
        {task.recommended && <RecommendedBadge />}
        <PriorityBadge task={task} priority={priority} manual={manualPriority} automatic={automaticPriority} onChange={onChange} />
        <StatusSelect task={task} onChange={onChange} />
      </article>
    );
  }

  return (
    <article className={`card task-card status-${task.status}${task.done ? " done" : ""}`} {...drag}>
      <header className="task-card-header">
        <span className="task-title-wrap">
          <span className="task-title" title={task.title}>
            {task.title}
          </span>
          {claudeIcon}
        </span>
        {assessment?.estimate_minutes != null && (
          <span className="estimate" title="Estimated total time to finish: your time plus Claude's">
            ~{formatMinutes(assessment.estimate_minutes)}
          </span>
        )}
        {task.recommended && <RecommendedBadge />}
        <PriorityBadge task={task} priority={priority} manual={manualPriority} automatic={automaticPriority} onChange={onChange} />
        <StatusSelect task={task} onChange={onChange} />
      </header>

      {(SOURCE_LABEL[task.source] || task.project || task.requester || task.due) && (
        <div className="muted small task-meta">
          {task.project && <span className="task-project">{task.project.name}</span>}
          {SOURCE_LABEL[task.source] && <span className={`source ${task.source}`}>{SOURCE_LABEL[task.source]}</span>}
          {task.requester && <span>{task.requester}</span>}
          {task.due && <span className="due">due {task.due}</span>}
        </div>
      )}

      {task.carriedFrom && (
        <div className="task-controls">
          <span className="carried">{carriedLabel(task.carriedFrom)}</span>
        </div>
      )}

      {editing && (
        <DescriptionEditor title={task.title} initial={description ?? ""} onSave={saveDescription} onCancel={() => setEditing(false)} />
      )}
      {description ? (
        <Description text={description} onEdit={() => setEditing(true)} actions={descriptionActions} />
      ) : (
        manual && (
          <button className="link-button small muted add-description" onClick={() => setEditing(true)}>
            Add a description…
          </button>
        )
      )}

      {!description && (linksToggle || checkAction) && <div className="description-actions small">{descriptionActions}</div>}
      {linksOpen && <LinkChips links={links} />}

      {assessment ? (
        <AssessmentView
          assessment={assessment}
          steps={outlineSteps}
          onAddDetails={!editing ? () => setEditing(true) : undefined}
          actions={planActions}
          planning={planning}
        />
      ) : (
        <>
          {manual && assessing && (
            <div className="muted small">
              <Spinner /> Claude is reviewing this task…
            </div>
          )}
          {/* No assessment to nest it in yet. */}
          <PlanOutline steps={outlineSteps} action={planActions} planning={planning} />
        </>
      )}

      {check && !checkStatus && (
        <TaskCheckResult
          check={check}
          onDone={() => setStateAndRefresh({ status: "done" })}
          onDismiss={() => setStateAndRefresh({ dismissed: true })}
          onApply={(text) => saveDescription(text)}
          onHide={async () => {
            await clearTaskCheck(task.id);
            onChange();
          }}
        />
      )}

      {compact && (
        <footer className="task-card-actions">
          <button className="link-button small muted" onClick={() => setExpanded(false)}>
            Collapse
          </button>
        </footer>
      )}

      {showPlan && plan && !planning && (
        <PlanModal
          title={task.title}
          stored={plan}
          onClose={() => setShowPlan(false)}
          actions={
            <>
              {hasClaudeSteps && assessment && !linked && (
                <button className="cta-primary" onClick={() => { setShowPlan(false); approveAndStart(); }}>
                  Approve & start
                </button>
              )}
              <button className="link-button small" onClick={openInClaude}>
                Open in Claude
              </button>
            </>
          }
        />
      )}
    </article>
  );
}
