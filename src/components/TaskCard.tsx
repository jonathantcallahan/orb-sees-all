import { openUrl } from "@tauri-apps/plugin-opener";
import { useLayoutEffect, useRef, useState } from "react";
import { claudeSessionUrl, sessionPrompt } from "../openInClaude";
import { clearAssessment, setTaskState, updateManualTask, type StoredPlan } from "../db";
import { assessPendingTasks, planTask } from "../jobs";
import type { Assessment, Automation, FollowUp, FollowUpKind, ManualAssessment, ProjectPriority } from "../schema";
import { formatMinutes, taskPriority, type EffectivePriority, type TaskStatus } from "../tasks";
import { useJobStatus } from "../useAppData";
import { localDate } from "../scheduler";
import { ExternalLink } from "./common";

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
  /** From the refresh that found the task; the user's own tasks are assessed separately. */
  assessment?: Assessment | null;
  done: boolean;
}

const FOLLOW_UP_LABEL: Record<FollowUpKind, string> = {
  reply: "Reply",
  review: "Review",
  decide: "Decide",
  do: "Do",
  schedule: "Schedule",
  share: "Share",
};

const SOURCE_LABEL = { manual: null, slack: "Slack", email: "Email", project: null } as const;

function Plan({ stored }: { stored: StoredPlan }) {
  const { plan } = stored;
  return (
    <div className="plan">
      <p className="small">{plan.approach}</p>
      <ol className="plan-steps small">
        {plan.steps.map((step, i) => (
          <li key={i}>
            <ExternalLink href={step.link} className="plan-step-title">
              {step.title}
            </ExternalLink>
            {step.detail && <div className="muted">{step.detail}</div>}
          </li>
        ))}
      </ol>
      {plan.open_questions.length > 0 && (
        <>
          <h4>Open questions</h4>
          <ul className="small plan-list">
            {plan.open_questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}
      {plan.sources.length > 0 && (
        <div className="chips">
          {plan.sources.map((s) => (
            <ExternalLink key={s.link} href={s.link} className="chip">
              {s.title}
            </ExternalLink>
          ))}
        </div>
      )}
    </div>
  );
}

/** A description clamped to two lines, with More/Less when it runs longer. */
function Description({ text, draft, onEdit }: { text: string; draft: boolean; onEdit?: () => void }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !expanded) setOverflows(el.scrollHeight - el.clientHeight > 4);
  }, [text, expanded]);

  return (
    <div>
      <p ref={ref} className={`description small${expanded ? "" : " clamped"}`}>
        {draft && <span className="draft-label" title="Claude drafted this from Slack, email and Jira. Edit it to correct it.">✦ Claude's draft </span>}
        {text}
      </p>
      {(overflows || onEdit) && (
        <div className="description-actions">
          {overflows && (
            <button className="link-button small" onClick={() => setExpanded((e) => !e)}>
              {expanded ? "Less" : "More"}
            </button>
          )}
          {onEdit && (
            <button className="link-button small muted" onClick={onEdit}>
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DescriptionEditor({ task, initial, onDone }: { task: CardTask; initial: string; onDone: (changed: boolean) => void }) {
  const [text, setText] = useState(initial);
  const save = async () => {
    const next = text.trim() || null;
    const changed = next !== (task.description ?? null);
    if (changed) {
      await updateManualTask(task.id, { title: task.title, description: next });
      // The old assessment was based on the old text; have Claude look again.
      await clearAssessment(task.id);
      assessPendingTasks().catch(() => {});
    }
    onDone(changed);
  };
  return (
    <textarea
      autoFocus
      rows={4}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDone(false);
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
      }}
      placeholder="What's involved, who it's for, links…"
    />
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
    <span className="badge recommended" title="The Orb recommends doing this today to move a P0 project forward">
      ✦ Recommended
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

function StatusSelect({ task, onChange }: { task: CardTask; onChange: () => void }) {
  return (
    <select
      className={`status-select ${task.status}`}
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
  );
}

function carriedLabel(day: string): string {
  const days = Math.round((Date.parse(localDate(new Date())) - Date.parse(day)) / 86_400_000);
  return days === 1 ? "from yesterday" : `from ${days} days ago`;
}

const AUTOMATION_LABEL: Record<Automation, string> = {
  human: "You do it",
  assisted: "Claude can help",
  claude: "Claude can do it",
};

function AssessmentView({ assessment, onAddDetails }: { assessment: Assessment; onAddDetails?: () => void }) {
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
        <span className="automation-kind">{AUTOMATION_LABEL[assessment.automation]}</span>
        <span className="small">{assessment.suggestion}</span>
      </div>
    </>
  );
}

export function TaskCard({
  task,
  plan,
  planning,
  manualAssessment,
  assessing,
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
  /** Show a one-line row (title, priority, estimate, status) until clicked. */
  compact?: boolean;
  onChange: () => void;
}) {
  const [showPlan, setShowPlan] = useState(false);
  const planStatus = useJobStatus(`plan:${task.id}`);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const manual = task.source === "manual";
  const assessment = manual ? manualAssessment : task.assessment;
  const priority = taskPriority(assessment?.priority, task.projectPriority, task.blocking);
  // Show the user's own words when there are any; otherwise Claude's draft.
  const draft = manual && !task.description ? manualAssessment?.description : null;
  const description = task.description || draft;
  // Inbox tasks come with a follow-up; for the rest, the plan's first step is the next action.
  const firstStep = plan?.plan.steps[0];
  const followUp: FollowUp | null = task.follow_up ?? (firstStep ? { kind: "do", action: firstStep.title } : null);
  const openInClaude = () => {
    if (!plan) return;
    const prompt = sessionPrompt(
      { title: task.title, description, link: task.link, requester: task.requester, projectName: task.project?.name },
      plan.plan,
    );
    openUrl(claudeSessionUrl(prompt, task.repoFolder));
  };
  const runPlan = () => {
    setShowPlan(true);
    planTask({
      id: task.id,
      title: task.title,
      description: task.description ?? null,
      link: task.link ?? null,
      requester: task.requester ?? null,
      source:
        task.source === "manual"
          ? "the user's own to-do list"
          : task.project
            ? `the "${task.project.name}" project's Slack channel${task.blocking ? " (this task is blocking the project)" : ""}`
            : task.source,
    }).catch(() => {});
  };

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
        <span className="task-title">{task.title}</span>
        {task.recommended && <RecommendedBadge />}
        {priority && <span className={`badge priority ${priority}`}>{PRIORITY_LABEL[priority]}</span>}
        {assessment?.estimate_minutes != null && <span className="estimate">~{formatMinutes(assessment.estimate_minutes)}</span>}
        <StatusSelect task={task} onChange={onChange} />
      </article>
    );
  }

  return (
    <article className={`card task-card status-${task.status}${task.done ? " done" : ""}`} {...drag}>
      <header className="task-card-header">
        <ExternalLink href={task.link} className="task-title">
          {task.title}
        </ExternalLink>
        {priority && <span className={`badge priority ${priority}`}>{PRIORITY_LABEL[priority]}</span>}
        {assessment?.estimate_minutes != null && (
          <span className="estimate" title="Claude's estimate of your hands-on time">
            ~{formatMinutes(assessment.estimate_minutes)}
          </span>
        )}
        <StatusSelect task={task} onChange={onChange} />
      </header>

      {(SOURCE_LABEL[task.source] || task.project || task.requester || task.due || task.recommended) && (
        <div className="muted small task-meta">
          {task.recommended && <RecommendedBadge />}
          {task.project && <span className="badge project-badge">{task.project.name}</span>}
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

      {editing ? (
        <DescriptionEditor
          task={task}
          initial={task.description ?? ""}
          onDone={(changed) => {
            setEditing(false);
            if (changed) onChange();
          }}
        />
      ) : description ? (
        <Description text={description} draft={!!draft} onEdit={manual ? () => setEditing(true) : undefined} />
      ) : (
        manual && (
          <button className="link-button small muted add-description" onClick={() => setEditing(true)}>
            Add a description…
          </button>
        )
      )}

      {assessment ? (
        <AssessmentView assessment={assessment} onAddDetails={manual && !editing ? () => setEditing(true) : undefined} />
      ) : (
        manual &&
        assessing && (
          <div className="muted small">
            <span className="spin">✦</span> Claude is reviewing this task…
          </div>
        )
      )}

      {followUp && (
        <div className={`follow-up ${followUp.kind}`}>
          <span className="follow-up-kind">{task.follow_up ? FOLLOW_UP_LABEL[followUp.kind] : "Next"}</span>
          <span className="small">{followUp.action}</span>
        </div>
      )}

      <footer className="task-card-actions">
        {compact && (
          <button className="link-button small muted" onClick={() => setExpanded(false)}>
            Collapse
          </button>
        )}
        {planning ? (
          <span className="muted small">
            <span className="spin">↻</span> {planStatus ?? "Researching a plan"}…
          </span>
        ) : plan ? (
          <>
            <button className="link-button small" onClick={() => setShowPlan((s) => !s)}>
              {showPlan ? "Hide plan" : `Show plan (${plan.plan.steps.length} steps)`}
            </button>
            <button className="link-button small" onClick={openInClaude} title="Open a new Claude Code session with this task and its plan filled in">
              Open in Claude
            </button>
            <button className="link-button small muted" onClick={runPlan}>
              Regenerate
            </button>
          </>
        ) : description ? (
          <button className="link-button small" onClick={runPlan}>
            ✦ Plan with Claude
          </button>
        ) : manual ? (
          <button className="link-button small muted" onClick={() => setEditing(true)}>
            Add a description to plan with Claude
          </button>
        ) : (
          <span className="muted small">Plan with Claude needs a description; refresh to get one.</span>
        )}
      </footer>

      {showPlan && plan && !planning && <Plan stored={plan} />}
    </article>
  );
}
