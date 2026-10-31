import { useOrbName } from "../orbLook";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MOD } from "../platform";
import { claudeSessionUrl, discussPrompt, resumeSessionUrl, sessionPrompt, startPrompt } from "../openInClaude";
import { clearAssessment, clearTaskCheck, markCorrectionApplied, markNotDuplicate, mergeTasks, setPriorityOverride, saveDescriptionOverride, setTaskState, updateManualTask, type StoredPlan, type StoredTaskCheck } from "../db";
import { approveDiscussedPlan, assessPendingTasks, checkTask, continueTaskSession, discussTaskPlan, planTask, recheckSessionSteps, sendHandoff, startTaskSession } from "../jobs";
import type { Assessment, Automation, FollowUp, ManualAssessment, Priority, ProjectPriority } from "../schema";
import { ago, formatMinutes, sinceWhen, taskPriority, type EffectivePriority, type TaskStatus } from "../tasks";
import { useJobStatus } from "../useAppData";
import { formatWhen, localDate } from "../scheduler";
import { CloseIcon, Reveal, ScrambleText, Spinner } from "./common";
import { SlackSendModal } from "./SlackPreview";
import { readableReply, GIVE_UP_MS, linkSession, looksOutOfSync, markStepDone, stepState, unsentMessages, useSessionProgress, type ChatMessage, type PendingSend, type SessionLink, type SessionProgress, type StepProgress, type StepState } from "../sessions";
import { LinkChips } from "./LinkChips";
import { useTaskDrag } from "./taskDrag";
import { CLAUDE_ICON } from "../linkIcons";
import { collectLinks, linkKind } from "../links";
import type { DuplicateCandidate } from "../duplicates";

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
            Show more
          </button>
        )}
        {expanded && (
          <button className="link-button small more-link" onClick={() => setExpanded(false)}>
            Show less
          </button>
        )}
        {onEdit && (
          <button className="link-button small more-link" onClick={onEdit}>
            Edit description
          </button>
        )}
        {actions}
      </div>
    </>
  );
}

/** Edits a task's description in a centered modal. Esc cancels; ⌘↩ (Ctrl+↩) saves. */
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
          <button className="cta-primary" onClick={save} title={`Save, then plan again from the new description (${MOD}↩)`}>
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
  blocked: "Blocked",
  done: "Done",
};

const DISMISS = "dismiss";

/** Drag-and-drop payload type for moving tasks in and out of Today. */

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

/** What the orb can do for a task, beside the Plan heading, by its name; nothing for tasks that are all yours. */
const orbRole = (automation: Automation, orb: string): string | null =>
  automation === "assisted" ? `${orb} can help` : automation === "claude" ? `${orb} can complete this task` : null;

/**
 * A high-level view of the plan: each step's title beside a numbered circle.
 * With no plan yet, the next action stands in as step one. `action` (e.g.
 * Approve & start) sits inside, under the steps.
 */
/** A small dashed ring marking a plan step. */
/** Applying a double check's correction: still going (what it's doing), or done (when). */
type CorrectionState = { working: string } | { appliedAt: string };

/** Which task cards you've opened (true) or closed (false) this session, by task id. */
const openCards = new Map<string, boolean>();

/** Whether the user asked for reduced motion; checked on each use, so a change in System Settings applies at once. */
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A plan step's marker: dashed when not started, turning while in progress, amber and still while waiting on you,
 * checked when done, a red bar when blocked on someone else, struck through when skipped.
 */
function StepCircle({ state }: { state?: StepState }) {
  return (
    <svg className={`step-circle${state ? ` ${state}` : ""}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      {state === "skipped" ? (
        <>
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3.2 8.8 8.8 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </>
      ) : state === "blocked" ? (
        <>
          <circle cx="6" cy="6" r="5.5" fill="currentColor" />
          <path d="M3.5 6h5" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : state === "done" ? (
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

/**
 * Shows `text` in a small card under its child while it's hovered (the webview doesn't show native
 * title tooltips). With no text, renders the child alone.
 */
function HoverTip({ text, children }: { text: string | null; children: ReactNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!text) return <>{children}</>;
  return (
    <span className="hover-tip-anchor" onMouseEnter={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} onMouseLeave={() => setAnchor(null)}>
      {children}
      {anchor &&
        createPortal(
          <div className="card meeting-card hover-tip small" role="tooltip" style={{ left: anchor.left, top: anchor.bottom + 6 }}>
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}

interface OutlineStep {
  title: string;
  /** Who does it; null for older plans that didn't say. */
  by: "claude" | "you" | null;
  /** What the linked Claude session last reported for this step. */
  progress?: StepProgress;
}

function PlanOutline({
  steps,
  action,
  planning = false,
  onMarkDone,
  onRemind,
}: {
  steps: OutlineStep[];
  action?: ReactNode;
  planning?: boolean;
  /** Marks a step done by hand (once a session is under way): for work the session didn't see, like a message sent from Slack. */
  onMarkDone?: (index: number) => void;
  /** Has the session draft a reminder to whoever a blocked step is waiting on. */
  onRemind?: (index: number) => void;
}) {
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
              {onMarkDone && step.progress?.state !== "done" && step.progress?.state !== "skipped" ? (
                <button className="step-circle-button" onClick={() => onMarkDone(i)} aria-label={`Mark "${step.title}" done`}>
                  <StepCircle state={step.progress?.state} />
                </button>
              ) : (
                <StepCircle state={step.progress?.state} />
              )}
              <HoverTip text={step.progress?.state === "blocked" ? (step.progress.note ? `Blocked: ${step.progress.note}` : "Blocked") : null}>
                <span className="small">
                  {step.title}
                  {step.by === "you" && step.progress?.state !== "done" && step.progress?.state !== "skipped" && step.progress?.state !== "blocked" && (
                    <span className="step-by you">Human</span>
                  )}
                </span>
              </HoverTip>
              {onRemind && step.progress?.state === "blocked" && (
                <button className="link-button small step-remind" onClick={() => onRemind(i)}>
                  Remind
                </button>
              )}
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
  onMarkDone,
  onRemind,
}: {
  assessment: Assessment;
  /** Plan steps tagged by who does them, shown inside the assessment. */
  steps: OutlineStep[];
  /** Approve & start and Open in Claude, under the steps. */
  actions?: ReactNode;
  /** A plan is being written. */
  planning: boolean;
  onAddDetails?: () => void;
  onMarkDone?: (index: number) => void;
  onRemind?: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const orbName = useOrbName();
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
          <span className="automation-kind">Plan</span>
          {orbRole(assessment.automation, orbName) && <span className="automation-role timestamp">{orbRole(assessment.automation, orbName)}</span>}
          <svg className={`disclosure${open ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <Reveal open={open} className="automation-body">
          <PlanOutline steps={steps} action={actions} planning={planning} onMarkDone={onMarkDone} onRemind={onRemind} />
        </Reveal>
      </div>
    </>
  );
}

/** A message the session handed over, ready to review and send from Orb. */
function HandoffRow({ taskId, send, onChange }: { taskId: string; send: PendingSend; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(send.text);
  const [error, setError] = useState<string | null>(null);
  const sending = useJobStatus(`handoff:${taskId}`);
  const where = send.to.startsWith("http") ? "the thread" : send.to;
  return (
    <div className="handoff small">
      <div className="handoff-head">
        <span className="handoff-label">Ready to send to {where}</span>
        <button className="cta-primary" disabled={!!sending} onClick={() => setOpen(true)}>
          {sending ? "Sending…" : "Review & send"}
        </button>
      </div>
      <div className="muted handoff-preview">{send.text.split("\n")[0]}</div>
      {open && (
        <SlackSendModal
          to={send.to}
          text={text}
          status={sending ? `${sending}…` : error ? `Couldn't send: ${error}` : null}
          failed={!!error && !sending}
          busy={!!sending}
          onChange={setText}
          onCancel={() => !sending && setOpen(false)}
          onSend={async () => {
            if (!text.trim()) return;
            try {
              setError(null);
              await sendHandoff(taskId, send, text.trim());
              setOpen(false);
              onChange();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}

/** Text with markdown marks (bold, italics, code) dropped: the card shows Claude's words plainly. */
const plain = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, "$1$2").replace(/`([^`]+)`/g, "$1");

/**
 * Claude's message as plain paragraphs. Sessions are asked to write plain text, but older ones
 * (and the odd slip) use markdown: headings read as an ordinary line and list items as bullets.
 */
function ClaudeText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b && !/^[-*_]{3,}$/.test(b));
  return (
    <>
      {blocks.map((block, i) => (
        <div key={i} className="chat-para">
          {block.split("\n").map((line, j) => {
            const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
            const words = plain(item ? item[1] : line.replace(/^#{1,6}\s+/, ""));
            return (
              <span key={j} className={`chat-line${item ? " chat-item" : ""}`}>
                {words}
              </span>
            );
          })}
        </div>
      ))}
    </>
  );
}

/**
 * Where you write back to the session: grows with what you type; Enter sends, Shift+Enter starts a
 * new line (and text being composed with an input method is never sent early).
 */
function Composer({ onSend, autoFocus = false, disabled = false }: { onSend: (text: string) => void; autoFocus?: boolean; disabled?: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  useLayoutEffect(fit, [text]);
  const send = () => {
    if (disabled || !text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  // Back in the box, ready to type, as soon as Claude is done.
  useEffect(() => {
    if (!disabled && autoFocus) ref.current?.focus();
  }, [disabled]);
  return (
    <div className={`composer-wrap${disabled ? " disabled" : ""}`}>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={ref}
          rows={1}
          autoFocus={autoFocus}
          disabled={disabled}
          value={text}
          placeholder="Reply to Claude…"
          aria-label="Reply to Claude"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="composer-send" type="submit" disabled={disabled || !text.trim()} aria-label="Send reply">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </div>
  );
}

/** Claude's mark, turning while it works. */
/** Claude Code's working glyph: a star that grows and shrinks through its shapes, in Claude's orange. */
const CLAUDE_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

export function ClaudeSpark() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % CLAUDE_FRAMES.length), 120);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="claude-spark" aria-hidden>
      {CLAUDE_FRAMES[frame]}
    </span>
  );
}

/** chatFor's value while the chat is open to talk the plan through. */
const DISCUSS = -1;

/** What the session is waiting on you for: the step it stopped at and what it asked. */
export interface SessionAsk {
  /** 1-based step number, or null when the only thing waiting is a message to send. */
  step: number | null;
  title: string;
  note?: string;
}

/**
 * The conversation with a task's session, in a centered modal laid out like a Claude chat: what
 * it's waiting on at the top, the conversation (your messages in bubbles, Claude's as text), any
 * messages it handed over to send, and the reply box at the bottom. The card closes it once the
 * step it opened for is resolved. Esc or the backdrop closes it too.
 */
export function SessionChat({
  taskId,
  title,
  ask,
  messages,
  working,
  toSend,
  canReply,
  askAction,
  plain = false,
  onClose,
  onChange,
}: {
  taskId: string;
  title: string;
  /**
   * A conversation rather than a step waiting on you (Explain this): the top box is neutral, with
   * no waiting marker, and the title is a quiet label.
   */
  plain?: boolean;
  ask: SessionAsk | null;
  /** A button in the ask box (Approve & start while discussing the plan). */
  askAction?: ReactNode;
  messages: ChatMessage[];
  working: string | undefined;
  toSend: PendingSend[];
  canReply: boolean;
  onClose: () => void;
  onChange: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // What you just sent shows at once, until the transcript catches up with it.
  const [sent, setSent] = useState<string | null>(null);
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.text;
  useEffect(() => {
    if (sent && lastUser === sent) setSent(null);
  }, [lastUser]);
  const send = (message: string) => {
    setSent(message);
    continueTaskSession(taskId, message).then(onChange, onChange);
    onChange();
  };
  // While Claude answers, its reply streams in as it's written; the transcript's copy of this turn
  // (which lags) is held back until the turn ends, so nothing shows twice.
  // When the turn ends, the streamed reply stays up until the transcript's copy arrives, so it
  // doesn't blink out in between.
  const live = useJobStatus(`live:${taskId}`);
  const [held, setHeld] = useState<{ text: string; count: number } | null>(null);
  useEffect(() => {
    if (live) setHeld({ text: live, count: messages.length });
    else setHeld((h) => (h && messages.length > h.count ? null : h));
  }, [live]);
  useEffect(() => {
    if (held && !live && messages.length > held.count) setHeld(null);
  }, [messages.length]);
  const streaming = live ?? (held ? held.text : null);
  const liveText = streaming ? readableReply(streaming) : "";
  const lastUserAt = messages.map((m) => m.role).lastIndexOf("user");
  // Everything up to your last message (none, on a first turn) while a reply is forming.
  const settled = working || (held && !live) ? messages.slice(0, lastUserAt + 1) : messages;
  const shown = sent ? [...settled, { role: "user" as const, text: sent }] : settled;
  // Keep the newest message in view as the conversation grows.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, working, toSend.length, liveText.length]);
  const busy = !!working || !!sent;

  return createPortal(
    <div className="modal-backdrop plan-modal-backdrop" onClick={onClose}>
      <div className={`modal chat-modal${plain ? " plain" : ""}`} role="dialog" aria-label={`Conversation about ${title}`} onClick={(e) => e.stopPropagation()}>
        <div className="chat-modal-top">
          <header className="chat-modal-head">
            <span className="chat-modal-title">{title}</span>
            <button className="icon-button" onClick={onClose} title="Close" aria-label="Close">
              <CloseIcon />
            </button>
          </header>
          {ask && (
            <div className="chat-ask">
              <span className="chat-ask-step">
                {!plain && <StepCircle state="waiting" />}
                {ask.step ? `Step ${ask.step} · ${ask.title}` : ask.title}
              </span>
              {ask.note && <p className="chat-ask-note">{ask.note}</p>}
              {askAction && <div className="chat-ask-action">{askAction}</div>}
            </div>
          )}
        </div>
        <div className="chat-log" ref={scroller}>
          {shown.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="chat-turn you">
                {m.text}
              </div>
            ) : (
              <div key={i} className="chat-turn claude">
                <ClaudeText text={m.text} />
              </div>
            ),
          )}
          {(busy || held) && liveText && (
            <div className="chat-turn claude">
              <ClaudeText text={liveText} />
            </div>
          )}
          {/* Under Claude's reply as it forms, as in a Claude session: its working glyph and what it's doing. */}
          {busy && (
            <div className="chat-working" role="status">
              <ClaudeSpark />
              <ScrambleText text={working ? `${working[0].toUpperCase()}${working.slice(1)}…` : "Thinking…"} />
            </div>
          )}
          {!busy && toSend.map((st) => <HandoffRow key={st.key} taskId={taskId} send={st} onChange={onChange} />)}
        </div>
        {canReply && (
          <footer className="chat-modal-foot">
            <Composer onSend={send} autoFocus disabled={busy} />
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The background session, from the task card: what it's doing while a turn runs, a row with Open
 * chat when it needs you (to answer it, or to review a message it wrote), and a retry if a turn failed.
 */
function SessionPanel({
  taskId,
  link,
  working,
  needsInput,
  onOpenChat,
  onChange,
}: {
  taskId: string;
  link: SessionLink;
  /** What the session is doing right now, while a turn runs. */
  working: string | undefined;
  needsInput: boolean;
  onOpenChat: () => void;
  onChange: () => void;
}) {
  return (
    <>
      {working && (
        <span className="muted small session-working">
          <ClaudeSpark /> Claude is working: <ScrambleText text={`${working}…`} />
        </span>
      )}
      {link.lastError && !working && (
        <div className="small session-error">
          <span className="error">Claude stopped: {link.lastError}</span>
          <button
            className="link-button small"
            onClick={() => {
              continueTaskSession(taskId, "Please carry on where you left off.").then(onChange, onChange);
              onChange();
            }}
          >
            Try again
          </button>
        </div>
      )}
      {needsInput && !working && (
        <div className="input-needed">
          <span className="input-needed-label">Human input needed</span>
          <button className="cta-primary" onClick={onOpenChat}>
            Open chat
          </button>
        </div>
      )}
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
  duplicateTitle,
  onDone,
  onDismiss,
  onMerge,
  correction,
  taskId,
}: {
  /** For remembering whether it's folded away. */
  taskId: string;
  check: StoredTaskCheck;
  /** Title of the open task the check says this duplicates, when it's still open. */
  duplicateTitle?: string;
  onDone: () => void;
  onDismiss: () => void;
  /** Folds this task into the one it duplicates. */
  onMerge?: () => void;
  /** How applying its correction is going; null when the check suggested none. */
  correction: CorrectionState | null;
}) {
  const corrected = check.corrected_description?.trim();
  // Folded away or open, remembered per task.
  const key = `check-open:${taskId}`;
  const [open, setOpen] = useState(() => localStorage.getItem(key) !== "0");
  const toggle = () => {
    localStorage.setItem(key, open ? "0" : "1");
    setOpen(!open);
  };
  return (
    <div className={`check-result task-check ${check.verdict}${open ? "" : " folded"}`}>
      {/* The whole title row folds and unfolds it. */}
      <div className="check-head small" onClick={toggle}>
        <span className="check-title">Task investigation</span>
        {/* One status: a correction being applied (spinner, no time yet), or the outcome and when. */}
        {correction && "working" in correction ? (
          <span className="timestamp check-status">
            <Spinner /> {correction.working}…
          </span>
        ) : correction ? (
          <span className="timestamp check-status">Correction applied {sinceWhen(correction.appliedAt)}</span>
        ) : (
          <span className="check-status">
            <span className="check-verdict">{CHECK_VERDICT[check.verdict]}</span> <span className="timestamp">{sinceWhen(check.at)}</span>
          </span>
        )}
        <button
          className="task-toggle check-toggle"
          aria-expanded={open}
          aria-label={open ? "Fold the investigation away" : "Show the investigation"}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          <svg className={`disclosure${open ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <Reveal open={open} className="check-body">
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
      {corrected && <p className="small corrected">Corrected description: {corrected}</p>}
      <div className="check-actions small">
        <LinkChips links={check.evidence.map((e) => ({ url: e.link, title: e.title, kind: linkKind(e.link) }))} />
        <span className="check-buttons">
          {check.verdict === "already_done" && (
            <button className="link-button small" onClick={onDone}>
              Mark done
            </button>
          )}
          {check.verdict === "duplicate" && onMerge && (
            <button className="link-button small" onClick={onMerge} title={duplicateTitle ? `Fold this into "${duplicateTitle}"` : undefined}>
              Merge into it
            </button>
          )}
          {(check.verdict === "not_needed" || (check.verdict === "duplicate" && !onMerge)) && (
            <button className="link-button small" onClick={onDismiss}>
              Dismiss task
            </button>
          )}
        </span>
      </div>
      </Reveal>
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
  openTasks = [],
  duplicateOf,
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
  openTasks?: { id: string; title: string }[];
  /** Another open task that looks like the same work, offered for a merge. */
  duplicateOf?: DuplicateCandidate;
  /** Show a one-line row (title, priority, estimate, status) until clicked. */
  compact?: boolean;
  onChange: () => void;
}) {
  const planStatus = useJobStatus(`plan:${task.id}`);
  const checkStatus = useJobStatus(`taskcheck:${task.id}`);
  const progress = useSessionProgress(task.id, sessionLink, onChange);
  /** A Claude session has picked this task up; the card follows it from now on. */
  const linked = !!sessionLink?.sessionId;
  /** Started, and Orb is still looking for the session (it gives up after a while, so the task can be started again). */
  const awaitingSession = !!sessionLink && !linked && Date.now() - sessionLink.startedAt < GIVE_UP_MS;
  // Collapsed cards show one line; the arrow after the badges opens and closes them. Compact cards
  // (finished tasks in Today, other groups' rows) start collapsed, and collapse again when they become compact.
  // A card you opened or closed stays that way while the app runs, even when it's dragged to another
  // list (which renders it afresh there); otherwise it starts as its list shows cards.
  const [collapsed, setCollapsedState] = useState(() => openCards.get(task.id) === undefined ? compact : !openCards.get(task.id));
  const setCollapsed = (value: boolean) => {
    openCards.set(task.id, !value);
    setCollapsedState(value);
  };
  // Remember how the card first showed, so it keeps that state when it's dragged into a list whose
  // cards start the other way (each list renders the card afresh).
  useEffect(() => {
    if (!openCards.has(task.id)) openCards.set(task.id, !collapsed);
  }, []);
  /** The body's content is only rendered once the card has been opened, then kept for the close animation. */
  const [bodyMounted, setBodyMounted] = useState(!collapsed);
  /** True while the height animates; the body clips its content only then (and while collapsed). */
  const [animating, setAnimating] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const setOpen = (open: boolean) => {
    if (open === !collapsed) return;
    setAnimating(!reducedMotion());
    if (open && !bodyMounted) {
      // Mount the content collapsed first, then open on the next frame, so the height has a starting point to animate from.
      setBodyMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setCollapsed(false)));
    } else setCollapsed(!open);
  };
  // A card that becomes compact while shown (a task just marked done in Today) closes itself; one that
  // merely arrives in a compact list (dragged there) keeps its state.
  const wasCompact = useRef(compact);
  useEffect(() => {
    if (compact && !wasCompact.current) setOpen(false);
    wasCompact.current = compact;
  }, [compact]);
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
  // Once the session revises the plan (a decision in the chat changed it), its version replaces them.
  const outlineSteps: OutlineStep[] = (
    progress?.plan
      ? progress.plan
      : plan
        ? plan.plan.steps.map((st) => ({ title: st.title, by: st.by ?? null }))
        : (assessment?.claude_steps ?? []).map((title) => ({ title, by: "claude" as const }))
  )
    .map((st, i) => ({ ...st, progress: stepState(progress, sessionLink, i + 1, st.title) }))
    // A step after a blocked one can't be waiting on you yet; it starts once the block clears.
    .map((st, i, all) =>
      st.progress?.state === "waiting" && all.slice(0, i).some((earlier) => earlier.progress?.state === "blocked") ? { ...st, progress: undefined } : st,
    );
  // Once a session is under way, any step not yet done can be marked done by hand.
  const markDone = sessionLink
    ? async (i: number) => {
        await markStepDone(task.id, outlineSteps[i].title);
        onChange();
      }
    : undefined;
  // Approve & start sends the whole sequence; Claude does every step that isn't the user's.
  const hasClaudeSteps = outlineSteps.some((st) => st.by !== "you");
  // Approve & start runs the session in the background; the user answers it here, and opens it in
  // Claude only to step in or change course.
  const approveAndStart = async () => {
    if (!assessment) return;
    await setTaskState(task.id, { status: "in_progress" });
    const prompt = startPrompt(
      { id: task.id, title: task.title, description, link: task.link, requester: task.requester, projectName: task.project?.name },
      assessment.suggestion,
      outlineSteps,
    );
    startTaskSession(task.id, prompt).then(onChange, onChange);
    onChange();
  };
  const sessionWorking = useJobStatus(`session:${task.id}`);
  /** The session is talking the plan through (Discuss plan) and hasn't started the work. */
  const discussing = !!sessionLink?.discussing;
  // A blocked step's Remind: the session drafts a nudge where the step was asked and hands it over
  // to review and send, like any message. It isn't tied to the step, so sending it doesn't finish it.
  const remind =
    sessionLink?.sessionId && !sessionWorking
      ? (i: number) => {
          const step = outlineSteps[i];
          const on = step.progress?.note ? ` on ${step.progress.note}` : "";
          continueTaskSession(
            task.id,
            `Step ${i + 1} ("${step.title}") is still blocked${on}. Please draft a short, friendly reminder to whoever it's waiting on, in the thread or channel where it was asked (mention them), and hand it to me to send with an "[orb] send to …" block, without a step number. Leave the step blocked.`,
          ).then(onChange, onChange);
          onChange();
        }
      : undefined;
  // Steps that have drifted from the conversation (a later one moving while an earlier one isn't
  // done) are re-checked against it once the session is idle, once per change in the transcript.
  const recheckStatus = useJobStatus(`recheck:${task.id}`);
  const recheckSteps = () => progress && recheckSessionSteps(task.id, task.title, outlineSteps, progress).then(onChange, onChange);
  const transcriptKey = progress ? `${progress.reports ?? 0}:${progress.messages?.length ?? 0}` : null;
  useEffect(() => {
    if (!sessionLink?.sessionId || discussing || !progress?.found || sessionWorking || recheckStatus) return;
    if (transcriptKey === sessionLink.recheckedKey) return;
    if (looksOutOfSync(outlineSteps.map((st) => st.progress))) recheckSteps();
  }, [transcriptKey, sessionWorking]);
  // A step blocked on someone else blocks the task; once it moves, the task is back in progress.
  const anyBlocked = outlineSteps.some((st) => st.progress?.state === "blocked");
  const wasBlocked = useRef(anyBlocked);
  useEffect(() => {
    const changed = anyBlocked !== wasBlocked.current;
    wasBlocked.current = anyBlocked;
    if (!sessionLink || discussing) return;
    if (anyBlocked && task.status !== "blocked" && task.status !== "done") setTaskState(task.id, { status: "blocked" }).then(onChange);
    else if (!anyBlocked && changed && task.status === "blocked") setTaskState(task.id, { status: "in_progress" }).then(onChange);
  }, [anyBlocked]);
  const waitingIndex = outlineSteps.findIndex((st) => st.progress?.state === "waiting");
  const waitingStep = waitingIndex >= 0 ? outlineSteps[waitingIndex] : undefined;
  const toSend = progress ? unsentMessages(progress.sends, sessionLink) : [];
  const needsInput = !!sessionLink?.sessionId && !discussing && (!!waitingStep || toSend.length > 0);
  /**
   * What the chat was opened for: a step (its number), a message to send (0), talking the plan
   * through (DISCUSS), or null when it's closed.
   */
  const [chatFor, setChatFor] = useState<number | null>(null);
  const openChat = () => setChatFor(waitingIndex >= 0 ? waitingIndex + 1 : 0);
  // The chat closes once its step is resolved: Claude has moved on from it, or it's been marked done.
  const chatStepState = chatFor ? outlineSteps[chatFor - 1]?.progress?.state : undefined;
  useEffect(() => {
    if (chatFor === null || chatFor === DISCUSS) return;
    if (chatFor > 0 ? chatStepState === "done" || chatStepState === "started" : toSend.length === 0 && !sessionWorking) setChatFor(null);
  }, [chatFor, chatStepState, toSend.length, sessionWorking]);
  const chatAsk: SessionAsk | null =
    chatFor === null
      ? null
      : chatFor === DISCUSS
        ? {
            step: null,
            title: "Talking through the plan",
            note: discussing
              ? "Ask about any step or change it. The steps on the card follow what you agree; approve when you're happy."
              : "The plan's approved and Claude is carrying it out.",
          }
        : chatFor > 0
        ? { step: chatFor, title: outlineSteps[chatFor - 1]?.title ?? "", note: outlineSteps[chatFor - 1]?.progress?.note }
        : { step: null, title: "Review and send the message Claude wrote" };
  // Discuss plan opens the session in a talk-it-through mode and the chat with it; Approve & start
  // then tells that same session to begin, with the plan as agreed.
  const discussPlan = async () => {
    if (!discussing && assessment) {
      const prompt = discussPrompt(
        { id: task.id, title: task.title, description, link: task.link, requester: task.requester, projectName: task.project?.name },
        assessment.suggestion,
        outlineSteps,
      );
      await discussTaskPlan(task.id, prompt, onChange);
      onChange();
    }
    setChatFor(DISCUSS);
  };
  const approvePlan = async () => {
    await setTaskState(task.id, { status: "in_progress" });
    approveDiscussedPlan(task.id).then(onChange, onChange);
    onChange();
    setChatFor(null);
  };
  // Plan steps only for a card with no steps yet (the skeleton rows). Once steps show, from the
  // assessment or a plan, Approve & start is the one action: a second "plan" button reads as redundant.
  const canPlan = !plan && !planning && !linked && !!description && outlineSteps.length === 0;
  const planActions =
    outlineSteps.length > 0 || planning || canPlan || sessionLink ? (
      <div className="plan-actions">
        {canPlan && (
          <button className="cta-primary" onClick={() => runPlan()} title="Have Claude research the task and plan every step, marking which it can do">
            Plan steps
          </button>
        )}
        {hasClaudeSteps && assessment && ((!linked && !awaitingSession) || discussing) && (
          <button
            className={canPlan ? "cta-ghost" : "cta-primary"}
            onClick={discussing ? approvePlan : approveAndStart}
            title="Mark this in progress and open a Claude Code session with the whole plan; Claude does its steps and asks you for yours"
          >
            Approve & start
          </button>
        )}
        {hasClaudeSteps && assessment && ((!linked && !awaitingSession) || discussing) && (
          <button className="cta-ghost" onClick={discussPlan} title="Talk the plan through with Claude and change its steps before it starts">
            Discuss plan
          </button>
        )}
        {planning && (
          <span className="muted small">
            <Spinner /> {planStatus ?? "Researching a plan"}…
          </span>
        )}
        {sessionLink && !discussing && (
          <SessionPanel
            taskId={task.id}
            link={sessionLink}
            working={sessionWorking}
            needsInput={needsInput}
            onOpenChat={openChat}
            onChange={onChange}
          />
        )}
        {sessionLink && !discussing && !sessionWorking && !needsInput && !recheckStatus && <SessionStatus progress={progress} steps={outlineSteps} />}
        {recheckStatus ? (
          <span className="muted small session-working">
            <Spinner /> Re-checking the steps against the conversation…
          </span>
        ) : (
          sessionLink?.sessionId &&
          !discussing &&
          progress?.found &&
          !sessionWorking && (
            <button className="link-button small more-link" onClick={recheckSteps} title="Have Orb check each step against the conversation">
              Re-check steps
            </button>
          )
        )}
        {chatFor !== null && sessionLink && (
          <SessionChat
            taskId={task.id}
            title={task.title}
            ask={chatAsk}
            messages={progress?.messages ?? []}
            working={sessionWorking}
            toSend={toSend}
            canReply={!!sessionLink.sessionId}
            askAction={
              chatFor === DISCUSS && discussing ? (
                <button className="cta-primary" disabled={!!sessionWorking} onClick={approvePlan}>
                  Approve & start
                </button>
              ) : undefined
            }
            onClose={() => setChatFor(null)}
            onChange={onChange}
          />
        )}
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
  // A double check that found the task captured wrong applies its corrected description on its own,
  // once (recorded first, so it can't apply twice), and the task is planned again from it.
  const [applyingCorrection, setApplyingCorrection] = useState(false);
  const correction = check?.corrected_description?.trim();
  useEffect(() => {
    if (!correction || check?.appliedAt || applyingCorrection) return;
    setApplyingCorrection(true);
    markCorrectionApplied(task.id)
      .then(() => saveDescription(correction))
      .finally(() => setApplyingCorrection(false));
  }, [correction, check?.appliedAt]);
  const correctionState: CorrectionState | null = !correction
    ? null
    : applyingCorrection || !check?.appliedAt
      ? { working: "Applying correction" }
      : planning || assessing
        ? { working: "Replanning" }
        : { appliedAt: check.appliedAt };
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
      openTasks.filter((t) => t.id !== task.id),
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
  // Opens the task in Claude (its session, once it has one), beside Show links.
  const claudeLink = (
    <button
      className="link-button small more-link claude-link"
      onClick={(e) => {
        e.stopPropagation();
        openInClaude();
      }}
      title={linked ? "Open the Claude Code session working on this task" : "Open this task in a new Claude Code session"}
    >
      <img src={CLAUDE_ICON} width={11} height={11} alt="" />
      Open in Claude
    </button>
  );
  const descriptionActions = (
    <>
      {linksToggle}
      {claudeLink}
      {checkAction}
    </>
  );
  // The open task a double check says this one duplicates, if it's still open.
  const duplicateTarget = check?.duplicate_of ? openTasks.find((t) => t.id === check.duplicate_of) : undefined;
  const setStateAndRefresh = async (patch: Parameters<typeof setTaskState>[1]) => {
    await setTaskState(task.id, patch);
    onChange();
  };


  const drag = useTaskDrag(task.id, cardRef);

  const toggle = (
    <button
      className="task-toggle"
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Show details" : "Hide details"}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(collapsed);
      }}
    >
      <svg className={`disclosure${collapsed ? "" : " open"}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  // One header for both states, so the title row stays exactly where it is when the card opens or closes.
  const header = (
    <header className="task-card-header">
      <span className="task-title-wrap">
        <span className="task-title" title={task.title}>
          {task.title}
        </span>
      </span>
      {assessment?.estimate_minutes != null && (
        <span className="estimate" title="Estimated total time to finish: your time plus Claude's">
          ~{formatMinutes(assessment.estimate_minutes)}
        </span>
      )}
      {task.recommended && <RecommendedBadge />}
      <PriorityBadge task={task} priority={priority} manual={manualPriority} automatic={automaticPriority} onChange={onChange} />
      <StatusSelect task={task} onChange={onChange} />
      {toggle}
    </header>
  );

  return (
    <article
      ref={cardRef}
      className={`card task-card${collapsed ? " collapsed" : ""}${animating ? " animating" : ""}${drag.className} status-${task.status}${task.done ? " done" : ""}`}
      {...drag.attrs}
      onClick={
        collapsed
          ? (e) => {
              if (!(e.target as HTMLElement).closest("select, button")) setOpen(true);
            }
          : undefined
      }
    >
      {header}

      {/* The body stays mounted once shown, so collapsing can animate; while collapsed it's inert (no tabbing in). */}
      <div
        className="task-body"
        inert={collapsed}
        aria-hidden={collapsed}
        onTransitionEnd={(e) => {
          if (e.target !== e.currentTarget || e.propertyName !== "grid-template-rows") return;
          setAnimating(false);
          // A card opened near the bottom of the column scrolls just enough to show what it revealed.
          if (!collapsed) cardRef.current?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
        }}
      >
        <div className="task-body-inner">
          {bodyMounted && (
            <>
              {(SOURCE_LABEL[task.source] || task.project || task.requester || task.due) && (
                <div className="muted small task-meta">
                  {task.project && <span className="task-project">{task.project.name}</span>}
                  {SOURCE_LABEL[task.source] && <span className={`source ${task.source}`}>{SOURCE_LABEL[task.source]}</span>}
                  {task.requester && <span>{task.requester}</span>}
                  {task.due && <span className="due timestamp">due {formatWhen(task.due)}</span>}
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

              {duplicateOf && !linked && (
                <div className="duplicate-note small">
                  <span className="duplicate-text">
                    Possible duplicate of <span className="duplicate-title">"{duplicateOf.title}"</span>
                  </span>
                  <span className="duplicate-actions">
                    <button
                      className="link-button small"
                      onClick={async () => {
                        await mergeTasks(task.id, duplicateOf.id);
                        onChange();
                      }}
                      title="Keep this task and fold the other into it, with its sources, links and anything this one lacks"
                    >
                      Merge
                    </button>
                    <button
                      className="link-button small more-link"
                      onClick={async () => {
                        await markNotDuplicate(task.id, duplicateOf.id);
                        onChange();
                      }}
                    >
                      Not a duplicate
                    </button>
                  </span>
                </div>
              )}

              {assessment ? (
                <AssessmentView
                  assessment={assessment}
                  steps={outlineSteps}
                  onAddDetails={!editing ? () => setEditing(true) : undefined}
                  actions={planActions}
                  planning={planning}
                  onMarkDone={markDone}
                  onRemind={remind}
                />
              ) : (
                <>
                  {manual && assessing && (
                    <div className="muted small">
                      <Spinner /> Claude is reviewing this task…
                    </div>
                  )}
                  {/* No assessment to nest it in yet. */}
                  <PlanOutline steps={outlineSteps} action={planActions} planning={planning} onMarkDone={markDone} onRemind={remind} />
                </>
              )}

              {check && !checkStatus && (
                <TaskCheckResult
                  check={check}
                  duplicateTitle={duplicateTarget?.title}
                  onMerge={
                    duplicateTarget
                      ? async () => {
                          await mergeTasks(duplicateTarget.id, task.id);
                          await clearTaskCheck(task.id);
                          onChange();
                        }
                      : undefined
                  }
                  onDone={() => setStateAndRefresh({ status: "done" })}
                  onDismiss={() => setStateAndRefresh({ dismissed: true })}
                  correction={correctionState}
                  taskId={task.id}
                />
              )}
            </>
          )}
        </div>
      </div>

    </article>
  );
}
