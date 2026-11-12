import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject, useMemo } from "react";
import { createPortal } from "react-dom";
import { MOD } from "../platform";
import { adoptAsTaskNote, claudeSessionUrl, resumeSessionUrl, sessionPrompt, taskChatPrompt } from "../openInClaude";
import { clearAssessment, clearTaskCheck, hideMergedNote, markCorrectionApplied, markNotDuplicate, mergeTasks, separateTasks, setDueOverride, setPriorityOverride, saveDescriptionOverride, setTaskState, updateManualTask, type MergedTask, type StoredPlan, type StoredTaskCheck } from "../db";
import { assessPendingTasks, checkTask, continueTaskSession, planTask, recheckSessionSteps, sendHandoff, startTaskChat, stopTaskSession, STOPPED_BY_YOU } from "../jobs";
import type { Assessment, Automation, FollowUp, ManualAssessment, Priority, ProjectPriority } from "../schema";
import { ago, formatMinutes, sinceWhen, statusForBlockedSteps, taskEstimate, taskPriority, type EffectivePriority, type TaskStatus } from "../tasks";
import { useJobStatus } from "../useAppData";
import { formatWhen, localDate } from "../scheduler";
import { TaskChangeCards } from "./ActionRow";
import { CloseIcon, ComposeModal, ExternalLink, HoverTip, RefreshButton, Reveal, ScrambleText, Spinner, SPINNER_FRAMES, StepCircle, UnreadDot, useScrambled } from "./common";
import { chatView, connectableSessions, connectSession, disconnectSession, humanKey, rankSessions, readableReply, saveDraftEdit, sendDestination, sendProblem, withEdit, linkSession, markStepDone, planFinished, stepState, stepsNeedRecheck, unsentMessages, useSessionProgress, type ChatMessage, type ChatTurn, type PendingSend, type RecentSession, type SessionLink, type SessionProgress, type StepProgress } from "../sessions";
import { LinkChips } from "./LinkChips";
import { useTaskDrag } from "./taskDrag";
import { InDock, useInDock, useTaskChatDock } from "./chatDock";
import { label, recordCorrection, taskSnapshot } from "../feedback";
import * as db from "../db";
import { CLAUDE_ICON } from "../linkIcons";
import { collectLinks, linkKind, type TaskLink } from "../links";
import type { DuplicateCandidate } from "../duplicates";

export interface CardTask {
  id: string;
  title: string;
  description?: string | null;
  /** The user's own note on a task they added, as typed, when its short title was written from it. */
  brief?: string | null;
  link?: string | null;
  due?: string | null;
  requester?: string | null;
  follow_up?: FollowUp | null;
  source: "manual" | "slack" | "email" | "project" | "meeting" | "watched";
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

const SOURCE_LABEL = { manual: null, slack: "Slack", email: "Email", project: null, meeting: "Meeting prep", watched: null } as const;

/** A task's description, in full: one card is open at a time, so there's room for all of it. */
function Description({ text }: { text: string }) {
  return (
    <p className="description small">
      <span>{text}</span>
    </p>
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

/** A session's folder as you'd know it: its last part. */
const folderName = (dir: string | null) => dir?.replace(/\/+$/, "").split("/").pop() || null;

/**
 * Connect a session (the Claude menu): your recent Claude Code sessions, likely matches for the task
 * first. Picking one connects it to the task (see connectSession).
 */
function ConnectSessionModal({
  task,
  replacing,
  onClose,
  onConnected,
}: {
  task: { id: string; title: string; description?: string | null };
  /** The task follows a session already, which the one you pick replaces. */
  replacing: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [sessions, setSessions] = useState<{ session: RecentSession; likely: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    connectableSessions(task.id).then(
      (found) => !cancelled && setSessions(rankSessions(task, found)),
      (e) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
    // The task's words are read once, when the picker opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const connect = async (s: RecentSession) => {
    setConnecting(s.sessionId);
    try {
      await connectSession(task.id, s);
      onConnected();
    } catch (e) {
      setError(String(e));
      setConnecting(null);
    }
  };
  const q = query.trim().toLowerCase();
  const shown = (sessions ?? []).filter(({ session: s }) => !q || `${s.title}\n${s.prompt}\n${s.cwd ?? ""}`.toLowerCase().includes(q));
  const likely = shown.filter((r) => r.likely);
  const rest = shown.filter((r) => !r.likely);
  const list = (rows: typeof shown) => (
    <ul className="connect-sessions">
      {rows.map(({ session: s }) => (
        <li key={s.sessionId}>
          <button className="connect-session" disabled={connecting !== null} onClick={() => connect(s)}>
            <span className="connect-session-title">{s.title}</span>
            <span className="connect-session-meta muted small">
              {connecting === s.sessionId && <Spinner />}
              {[folderName(s.cwd), sinceWhen(new Date(s.modifiedMs).toISOString())].filter(Boolean).join(" · ")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
  return createPortal(
    <div className="modal-backdrop plan-modal-backdrop" onClick={onClose}>
      <div className="modal plan-modal connect-modal" role="dialog" aria-label="Connect a session" onClick={(e) => e.stopPropagation()}>
        <header className="column-header">
          <h2>Connect a session</h2>
        </header>
        <p className="muted small connect-intro">
          Pick the Claude Code session you started for this task. The card follows it, and the task's chat carries on in it.
          {replacing && " It takes the place of the session the task follows now."}
        </p>
        <input autoFocus className="connect-search" placeholder="Search sessions" aria-label="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="connect-lists">
          {error ? (
            <div className="small session-error">Couldn't list sessions: {error}</div>
          ) : !sessions ? (
            <div className="muted small">
              <Spinner /> Finding your sessions…
            </div>
          ) : !shown.length ? (
            <div className="muted small">{q ? "No sessions match." : "No Claude Code sessions in the last two weeks."}</div>
          ) : (
            <>
              {likely.length > 0 && (
                <section>
                  <h4 className="connect-heading">Likely matches</h4>
                  {list(likely)}
                </section>
              )}
              {rest.length > 0 && (
                <section>
                  <h4 className="connect-heading">{likely.length ? "Other recent sessions" : "Recent sessions"}</h4>
                  {list(rest)}
                </section>
              )}
            </>
          )}
        </div>
        <footer className="plan-modal-actions edit-actions">
          <button className="cta-ghost" onClick={onClose}>
            Cancel
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
      title="In today's briefing: one of the few things only you can move"
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
/** The status menu's value while it reads Human, so choosing any status (the saved one too) answers it. */
const HUMAN = "human";

/**
 * A watched topic's statuses: Watching, or Human when something needs you (shown on its own when an
 * action is ready, or set by hand), and Done. Kept in the same task status field: Human is
 * "waiting", Watching anything else that isn't done. Dismiss reads Unwatch.
 */
const WATCH_STATUS: { value: TaskStatus; label: string }[] = [
  { value: "todo", label: "Watching" },
  { value: "waiting", label: "Human" },
  { value: "done", label: "Done" },
];
const watchStatusLabel = (status: TaskStatus) => (status === "done" ? "Done" : status === "waiting" ? "Human" : "Watching");

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
  const focus = usePointerFocus();
  if (priority === "blocking") {
    return (
      <span className="badge priority blocking">
        {PRIORITY_LABEL.blocking}
      </span>
    );
  }
  return (
    <span
      className={`badge priority menu-badge ${priority ?? "unset hover-only"}${manual ? " manual" : ""}${focus.pointer ? " pointer-focus" : ""}`}
    >
      {priority ? PRIORITY_LABEL[priority] : "Priority"}
      <select
        value={manual ?? AUTO}
        aria-label="Priority"
        {...focus.props}
        onChange={async (e) => {
          const to = e.target.value === AUTO ? null : (e.target.value as Priority);
          await setPriorityOverride(task.id, to);
          onChange();
          // What Demian learns from is about tasks; a watched topic's priority isn't one.
          if (task.source !== "watched")
            recordCorrection(
            {
              kind: "priority_change",
              subject: "task",
              subject_id: task.id,
              project_id: task.project?.id,
              before: { ...taskSnapshot(task), priority: priority ?? null, set_by: manual ? "user" : "demian" },
              after: { priority: to ?? automatic, set_by: to ? "user" : "demian" },
            },
            label.priority(task.title, to ? PRIORITY_LABEL[to] : "automatic"),
          );
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

/**
 * Whether a badge's menu was last focused with the mouse: WebKit counts a clicked <select> as
 * :focus-visible, so without this its focus ring would stay after you pick from it with the mouse.
 * Spread `props` on the select and add `pointer-focus` to the badge when `pointer` is set.
 */
function usePointerFocus() {
  const [pointer, setPointer] = useState(false);
  return {
    pointer,
    props: { onPointerDown: () => setPointer(true), onKeyDown: () => setPointer(false), onBlur: () => setPointer(false) },
  };
}

/**
 * The due date in an open card, with the date picker laid over it to change it, and × to take it
 * off. A task without one offers Add due date. The date you pick wins over the one a refresh found.
 */
function DueDate({ task, onChange }: { task: CardTask; onChange: () => void }) {
  const set = async (due: string | null) => {
    await setDueOverride(task.id, due);
    onChange();
  };
  return (
    <span className="due-date">
      <span className="due-pick">
        <span className="due timestamp">{task.due ? `Due ${formatWhen(task.due)}` : "Add due date"}</span>
        <input
          type="date"
          aria-label="Due date"
          value={task.due?.slice(0, 10) ?? ""}
          onClick={(e) => {
            try {
              e.currentTarget.showPicker();
            } catch {
              // Already open, or the picker isn't available: the field still takes typing.
            }
          }}
          onChange={(e) => set(e.target.value || null)}
        />
      </span>
      {task.due && (
        <button className="due-clear" aria-label="Remove the due date" onClick={() => set(null)}>
          <CloseIcon />
        </button>
      )}
    </span>
  );
}

/** A dismissal, recorded with what the task was, so a refresh doesn't raise it again. */
function recordDismiss(task: CardTask) {
  // Dismissing a watched topic is unwatching it, not a lesson about tasks.
  if (task.source === "watched") return;
  recordCorrection({ kind: "dismiss", subject: "task", subject_id: task.id, project_id: task.project?.id, before: taskSnapshot(task) }, label.dismiss(task.title));
}

/**
 * A badge showing the status, with the native menu laid invisibly over it so it sizes to its text.
 * While the task's Claude session is waiting on you, it reads "Human" instead (yellow); while the
 * session is working, "Working", shimmering. Neither is saved: they go once it's answered or done.
 */
function StatusSelect({
  task,
  human = false,
  working = false,
  onPicked,
  onChange,
}: {
  task: CardTask;
  human?: boolean;
  working?: boolean;
  /** You set a status yourself (not Dismiss): it replaces Human until the session asks again. */
  onPicked?: () => Promise<void>;
  onChange: () => void;
}) {
  const watched = task.source === "watched";
  const options = watched ? WATCH_STATUS : (Object.keys(STATUS_LABEL) as TaskStatus[]).map((value) => ({ value, label: STATUS_LABEL[value] }));
  // A watched topic set to Human shows it like one whose action is ready.
  const showHuman = !working && (human || (watched && task.status === "waiting"));
  // The session's Human (not a watched topic's waiting status, which is a status of its own).
  const sessionHuman = !working && human && !watched;
  const focus = usePointerFocus();
  return (
    <span
      className={`badge status-badge ${working ? "working" : showHuman ? "human" : watched && task.status !== "done" ? "todo" : task.status}${focus.pointer ? " pointer-focus" : ""}`}
    >
      {working ? <span className="shimmer">Working</span> : showHuman ? "Human" : watched ? watchStatusLabel(task.status) : STATUS_LABEL[task.status]}
      <select
        value={sessionHuman ? HUMAN : watched && task.status !== "done" && task.status !== "waiting" ? "todo" : task.status}
        aria-label="Status"
        {...focus.props}
        onChange={async (e) => {
          // Dismiss lives in the same menu: it hides the task rather than setting a status.
          const dismiss = e.target.value === DISMISS;
          await setTaskState(task.id, dismiss ? { dismissed: true } : { status: e.target.value as TaskStatus });
          if (!dismiss) await onPicked?.();
          onChange();
          if (dismiss) recordDismiss(task);
        }}
      >
        {sessionHuman && (
          <option value={HUMAN} hidden>
            Human
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option disabled>──────</option>
        <option value={DISMISS}>{watched ? "Unwatch" : "Dismiss"}</option>
      </select>
    </span>
  );
}

/** What Demian can do for a task, beside the Plan heading (always "Demian", whichever orb is showing); nothing for tasks that are all yours. */
const orbRole = (automation: Automation): string | null =>
  automation === "assisted" ? "Demian can help" : automation === "claude" ? "Demian can complete this task" : null;

/**
 * A high-level view of the plan: each step's title beside a numbered circle.
 * With no plan yet, the next action stands in as step one. `action` (e.g.
 * Open in chat) sits inside, under the steps.
 */
/** A small dashed ring marking a plan step. */
/** Applying a double check's correction: still going (what it's doing), or done (when). */
type CorrectionState = { working: string } | { appliedAt: string };

/**
 * The one task card that's open, by task id: opening a card closes whichever other was open (they're
 * told by TASK_OPEN_EVENT). Kept here, not in the card, so a card dragged to another list (which
 * renders it afresh) stays open.
 */
let openTask: string | null = null;
const TASK_OPEN_EVENT = "taskcard:open";
/** A task asked to be shown (View in tasks), until its card has scrolled it into view. */
let pendingReveal: string | null = null;
const TASK_REVEAL_EVENT = "taskcard:reveal";

/**
 * Opens a task's card and scrolls it into view: right away if it's on screen, or as soon as it is
 * (View in tasks switches to the Tasks area first). Any id the task goes by works, merged ones too.
 */
export function revealTask(id: string) {
  openTask = id;
  pendingReveal = id;
  window.dispatchEvent(new CustomEvent(TASK_REVEAL_EVENT, { detail: id }));
}

/** Whether the user asked for reduced motion; checked on each use, so a change in System Settings applies at once. */
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface OutlineStep {
  /** The step as text: in prompts, matching and labels. */
  title: string;
  /** Who does it; null for older plans that didn't say. */
  by: "claude" | "you" | null;
  /** What the linked Claude session last reported for this step. */
  progress?: StepProgress;
  /** What finished it (a message sent, a doc or event created), as chips beside it. */
  links?: TaskLink[];
  /** Drawn in place of the title when given (a watched topic's action, with its condition as badges). */
  line?: ReactNode;
  /** At the end of the line: a watched topic's action's state, or its Create and open task. */
  trailing?: ReactNode;
}

/**
 * Turns a task card into a card for something task-like that isn't a task: a watched topic. It keeps
 * the card (header, priority, status, description, the step box, the chat in the dock) and replaces
 * where the steps come from, the actions under them, and where edits go. Tasks don't pass it.
 */
export interface CardExtension {
  /** The steps, with their state, in place of the plan's. */
  steps: OutlineStep[];
  /** The step box's heading ("Conditional actions"), and the note beside it. */
  heading: string;
  role: string;
  /** Shown in the step box when there are no steps, in place of the plan's placeholder rows. */
  empty?: ReactNode;
  /** Below the card's boxes, always shown while it's open (Discuss); `discuss` opens the chat, and `chatOpen` says it's open already. */
  actions: (open: { discuss: () => void; chatOpen: boolean }) => ReactNode;
  /** In the meta row, in place of the project name (a project that can be changed). */
  meta?: ReactNode;
  /** More links for the Links toggle. */
  links?: { url: string | null | undefined; title: string | null }[];
  /** The chat, while it's open: drawn in the dock (or inline where there's none). */
  chat: (close: () => void) => ReactNode;
  /** The title isn't written yet: this shows, muted, in its place. */
  titlePending?: string | null;
  /** More of the card's boxes, after the steps' (a watched topic's Updates). */
  after?: ReactNode;
  /** A timestamp shown beside the title while the card is hovered, open or not ("Updated 2:30 PM"); the title gives way to it. */
  stamp?: string | null;
  /** Re-checks just this one: a ↻ that slides in between the status and the arrow while the card is hovered (a spinner while it runs). */
  refresh?: { busy: boolean; onClick: () => void };
}

/** What Orb sent or created for a session, as chips: those for each step (1-based), and the rest. */
function artifactChips(link: SessionLink | undefined, titles: string[] = []): { byStep: Map<number, TaskLink[]>; loose: TaskLink[] } {
  const byStep = new Map<number, TaskLink[]>();
  const loose: TaskLink[] = [];
  for (const a of link?.artifacts ?? []) {
    const chip = { url: a.url, title: a.title, kind: linkKind(a.url) };
    // Beside the step it finished, found by its title when it has one (the steps may have been
    // renumbered since), else by number.
    const at = a.stepTitle && titles.includes(a.stepTitle) ? titles.indexOf(a.stepTitle) + 1 : a.stepTitle ? 0 : (a.step ?? 0);
    if (at) byStep.set(at, [...(byStep.get(at) ?? []), chip]);
    else loose.push(chip);
  }
  return { byStep, loose };
}

function PlanOutline({
  steps,
  action,
  empty,
  onMarkDone,
  onRemind,
}: {
  steps: OutlineStep[];
  action?: ReactNode;
  /** Shown when there are no steps. */
  empty?: ReactNode;
  /** Marks a step done by hand (once a session is under way): for work the session didn't see, like a message sent from Slack. */
  onMarkDone?: (index: number) => void;
  /** Has the session draft a reminder to whoever a blocked step is waiting on. */
  onRemind?: (index: number) => void;
}) {
  if (steps.length === 0 && !action && !empty) return null;
  return (
    <div className="plan-outline">
      {/* No steps yet: what the box shows instead (a watched topic's note), else just the actions. */}
      {steps.length === 0 && empty}
      {steps.length > 0 && (
        <ol className="plan-outline-steps">
          {steps.map((step, i) => (
            <li key={i} className={[step.by && `by-${step.by}`, step.progress && `step-${step.progress.state}`].filter(Boolean).join(" ") || undefined}>
              {(() => {
                // A step that's yours (or waiting on you) has an orange circle, until it's done.
                const settled = step.progress?.state === "done" || step.progress?.state === "skipped" || step.progress?.state === "blocked";
                const human = !settled && (step.by === "you" || step.progress?.state === "waiting");
                const circle = <StepCircle state={step.progress?.state} human={human} />;
                return onMarkDone && step.progress?.state !== "done" && step.progress?.state !== "skipped" ? (
                  <button className="step-circle-button" onClick={() => onMarkDone(i)} aria-label={`Mark "${step.title}" done`}>
                    {circle}
                  </button>
                ) : (
                  circle
                );
              })()}
              {/* Each step wraps to as many lines as it needs; a blocked one says why on hover. */}
              {/* What was sent or made for the step follows its text, as icons. */}
              <HoverTip text={step.progress?.state === "blocked" ? `${step.title}${step.progress.note ? ` (blocked: ${step.progress.note})` : " (blocked)"}` : null}>
                <span className="small step-line">
                  {step.line ?? step.title}
                  {step.links && step.links.length > 0 && <LinkChips links={step.links} layout="icons" />}
                </span>
              </HoverTip>
              {step.trailing && <span className="step-trailing">{step.trailing}</span>}
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
  planCreated,
  heading = "Plan",
  role,
  openWhen = false,
  empty,
  alwaysOpen = false,
  busy = false,
}: {
  /** A task's plan: always open, with no arrow. */
  alwaysOpen?: boolean;
  /** The plan is being written or re-checked: a spinner at the right of the heading. */
  busy?: boolean;
  /** The box's heading, and the note beside it, when it holds something other than a plan. */
  heading?: string;
  role?: string;
  /** The box opens by itself when this turns true (a watched topic's action is ready). */
  openWhen?: boolean;
  /** Shown when there are no steps. */
  empty?: ReactNode;
  /** When the plan was made (ISO), shown after the Plan heading's role as "Plan created …". */
  planCreated?: string | null;
  /** Claude's take on the task; until there is one (a task nobody has assessed), the plan box says so. */
  assessment: Assessment | null;
  /** Plan steps tagged by who does them, shown inside the assessment. */
  steps: OutlineStep[];
  /** Open in chat, under the steps. */
  actions?: ReactNode;
  /** A plan is being written. */
  planning: boolean;
  onAddDetails?: () => void;
  onMarkDone?: (index: number) => void;
  onRemind?: (index: number) => void;
}) {
  return (
    <>
      {assessment?.needs_details && (
        <div className="needs-details small">
          <strong>Needs more detail.</strong> {assessment.details_question}
          {onAddDetails && (
            <button className="link-button small" onClick={onAddDetails}>
              Add details
            </button>
          )}
        </div>
      )}
      <CardBox
        kind={assessment?.automation ?? "unplanned"}
        heading={heading}
        openWhen={openWhen}
        // No plan yet: nothing to open, so no arrow; just the heading.
        fixed={steps.length === 0 && !empty}
        alwaysOpen={alwaysOpen}
        aside={
          busy ? (
            <span role="status" aria-label="Working on the plan">
              <Spinner />
            </span>
          ) : undefined
        }
        note={
          role !== undefined ? (
            <span className="automation-role timestamp">{role}</span>
          ) : assessment ? (
            orbRole(assessment.automation) && (
              <span className="automation-role timestamp">
                {orbRole(assessment.automation)}
                {planCreated && <span className="hover-stamp"> · Plan created {ago(planCreated)}</span>}
              </span>
            )
          ) : (
            <span className="automation-role timestamp">{planning ? "Planning…" : steps.length ? `${steps.length} steps` : "Open chat to make plan"}</span>
          )
        }
      >
        <PlanOutline steps={steps} action={actions} empty={empty} onMarkDone={onMarkDone} onRemind={onRemind} />
      </CardBox>
    </>
  );
}

/**
 * A card's collapsible box: a heading and a note beside it, opening to what's inside. The Plan (or
 * a watched topic's Conditional actions) is one; a watched topic's Updates is another.
 */
export function CardBox({
  kind = "unplanned",
  heading,
  note,
  openWhen = false,
  fixed = false,
  alwaysOpen = false,
  aside,
  children,
}: {
  /** Always open, with no arrow (a task's plan). */
  alwaysOpen?: boolean;
  /** At the right end of the heading row, centered on it (a spinner while the plan is written). */
  aside?: ReactNode;
  /** Who does the work, for a plan (its color); "unplanned" otherwise. */
  kind?: string;
  heading: string;
  note?: ReactNode;
  /** The box opens by itself when this turns true. */
  openWhen?: boolean;
  /** Nothing to open yet (no plan): the heading alone, no arrow, with anything inside (a plan being written) shown under it. */
  fixed?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(openWhen);
  useEffect(() => {
    if (openWhen) setOpen(true);
  }, [openWhen]);
  // A plan arriving while the card is open (you asked for one) opens the box, so its steps show.
  const wasFixed = useRef(fixed);
  useEffect(() => {
    if (wasFixed.current && !fixed) setOpen(true);
    wasFixed.current = fixed;
  }, [fixed]);
  if (alwaysOpen) {
    return (
      <div className={`automation ${kind}`}>
        <div className="automation-head fixed">
          <span className="automation-kind">{heading}</span>
          {note}
          {aside && <span className="automation-aside">{aside}</span>}
        </div>
        <Reveal open className="automation-body">
          {children}
        </Reveal>
      </div>
    );
  }
  if (fixed) {
    return (
      <div className={`automation ${kind}`}>
        <div className="automation-head fixed">
          <span className="automation-kind">{heading}</span>
          {note}
          {aside && <span className="automation-aside">{aside}</span>}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className={`automation ${kind}`}>
      <button className="automation-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="automation-kind">{heading}</span>
        {note}
        {aside && <span className="automation-aside">{aside}</span>}
        <svg className={`disclosure${open ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <Reveal open={open} className="automation-body">
        {children}
      </Reveal>
    </div>
  );
}

/** A message the session handed over, ready to review and send from Orb. */
function HandoffRow({ taskId, send, onChange }: { taskId: string; send: PendingSend; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(send.text);
  // Your edits are saved as you type (see SessionLink.edits), and picked up again when the row is
  // drawn anew: after the chat closes, Claude takes a turn, or the app restarts.
  const typed = useRef(false);
  useEffect(() => {
    db.getSessionLinks()
      .then((links) => {
        const saved = links[taskId]?.edits?.[send.key];
        if (saved !== undefined && !typed.current) setText(saved);
      })
      .catch(() => {});
  }, [taskId, send.key]);
  const pending = useRef<string | null>(null);
  const flush = () => {
    if (pending.current === null) return;
    const next = pending.current;
    pending.current = null;
    saveDraftEdit(taskId, send.key, next, send.text).catch(() => {});
  };
  useEffect(() => {
    if (!typed.current) return;
    pending.current = text;
    const t = setTimeout(flush, 400);
    return () => clearTimeout(t);
  }, [text]);
  // Anything typed in the last moment before the row goes is saved too.
  useEffect(() => () => flush(), []);
  const edit = (next: string) => {
    typed.current = true;
    setText(next);
  };
  const [error, setError] = useState<string | null>(null);
  const sending = useJobStatus(`handoff:${taskId}`);
  const doc = send.kind === "doc";
  const event = send.kind === "event";
  const ticket = send.kind === "ticket";
  // Something to create (a doc, an event or a ticket) rather than a message to send.
  const creates = doc || event || ticket;
  const where = sendDestination(send);
  // Where it goes isn't clear (see sendProblem): it can't be sent, only handed back to the chat to fix.
  const problem = sendProblem(send);
  const chatBusy = useJobStatus(`session:${taskId}`);
  const askToFix = async () => {
    const link = (await db.getSessionLinks())[taskId];
    await db.updateSessionLink(taskId, { dismissedKeys: [...(link?.dismissedKeys ?? []), send.key] });
    continueTaskSession(
      taskId,
      `The message you handed over${send.step ? ` for step ${send.step}` : ""} wasn't sent. ${problem} Hand it over again with a send line that names exactly where it goes: #channel-name for a channel, @person for a DM (their Slack user ID, like @U0123ABCD, when you know it), each person in a group DM the same way, comma-separated (@U0123ABCD, @U0456EFGH), or the permalink of the thread to reply in.`,
      true,
    ).then(onChange, onChange);
    onChange();
  };
  // An event's "when:" line, shown on the card; and whether it invites anyone.
  const when = event ? text.match(/^when:\s*(.+)$/im)?.[1] : undefined;
  const invites = event && /^who:\s*\S/im.test(text);
  // A ticket's project, type and epic, shown on the card.
  const field = (name: string) => text.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim();
  const ticketWhere = ticket ? [field("project"), field("type"), field("epic") && `in ${field("epic")}`].filter(Boolean).join(" · ") || undefined : undefined;
  // What it is, the same way for every kind: an eyebrow saying what's ready, then what it is or where
  // it goes, on one line (all of it on hover).
  const eyebrow = problem ? "Can't send this yet" : doc ? "Ready to create a Google Doc" : event ? "Ready to create an event" : ticket ? "Ready to file a Jira ticket" : send.to.startsWith("http") ? "Ready to reply" : "Ready to send";
  const title = creates ? send.to : `${where.charAt(0).toUpperCase()}${where.slice(1)}`;
  return (
    <div className="handoff small">
      <span className="handoff-eyebrow">{eyebrow}</span>
      <span className="handoff-title" title={title}>
        {title}
      </span>
      {problem ? (
        <div className="handoff-preview error">{problem}</div>
      ) : (
        <div className="muted handoff-preview">{when ?? ticketWhere ?? text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "")}</div>
      )}
      {/* Its buttons in a row of their own, under a line across the card. */}
      <div className="handoff-actions action-buttons">
        {!sending && (
          <button
            className="cta-ghost"
            title={creates ? "Don't create this one" : "Don't send this one"}
            onClick={async () => {
              await db.updateSessionLink(taskId, (link) => ({ dismissedKeys: [...(link.dismissedKeys ?? []), send.key], edits: withEdit(link.edits, send.key, null, send.text) }));
              onChange();
            }}
          >
            Not this
          </button>
        )}
        {problem ? (
          <button className="cta-primary" disabled={!!chatBusy} title="Asks the chat to hand it over again, saying exactly where it goes" onClick={askToFix}>
            Ask to fix
          </button>
        ) : (
          <button className="cta-primary" disabled={!!sending} onClick={() => setOpen(true)}>
            {sending ? (creates ? "Creating…" : "Sending…") : creates ? "Review & create" : "Review & send"}
          </button>
        )}
      </div>
      {open && !problem && (
        <ComposeModal
          heading={creates ? `Create "${send.to}"` : send.to.startsWith("http") ? `Reply in ${where}` : `Send to ${where}`}
          note={
            doc
              ? "Creates a Google Doc in your Drive, only visible to you until you share it."
              : ticket
                ? "Files the ticket in Jira as you, in the project and epic its lines name."
                : event
                ? `Creates the event on your calendar${invites ? " and sends invites to everyone on the who line" : ""}. If the time is no longer free for everyone, it moves to the next time that is.`
                : `Posts in ${where} as you.`
          }
          sendLabel={doc ? "Create doc" : ticket ? "File ticket" : event ? (invites ? "Create & invite" : "Create event") : "Send"}
          tall={doc}
          text={text}
          status={sending ? `${sending}…` : error ? `Couldn't ${creates ? "create it" : "send"}: ${error}` : null}
          failed={!!error && !sending}
          busy={!!sending}
          onChange={edit}
          onCancel={() => {
            if (sending) return;
            flush();
            setOpen(false);
          }}
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
          actions={
            send.to.startsWith("http") ? (
              <ExternalLink href={send.to} className="link-button small more-link">
                Open thread
              </ExternalLink>
            ) : undefined
          }
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
 * The reply box's thin cursor. WebKit (the app's engine on macOS) can't draw a thinner caret, and
 * no browser lets CSS set caret width, so the native one is hidden and this draws its own.
 *
 * Where it goes comes from a mirror: a hidden copy of the textarea, styled the same (the same CSS
 * rules, plus its computed box and type copied over), holding the text before the cursor and then a
 * span with the rest, as component/textarea-caret-position does. The rest matters: it makes the
 * mirror wrap exactly as the textarea does, so a cursor mid-word near the edge lands where the
 * textarea draws that word. The span's first line box is the cursor's spot.
 *
 * It moves on everything that moves the real cursor: typing, input-method composition, clicks and
 * drags, arrow keys (selectionchange), scrolling, the box resizing and fonts finishing loading. It's
 * placed just after the event, never inside it (a state update during the textarea's own input
 * event re-renders it with the old value and drops the keystroke). It hides while text is selected,
 * where the selection highlight shows the cursor's place.
 */
function useThinCaret(ref: RefObject<HTMLTextAreaElement | null>, text: string, disabled = false) {
  const mirror = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState<{ x: number; y: number; h: number } | null>(null);
  const last = useRef<string>("");
  const place = () => {
    const el = ref.current;
    const m = mirror.current;
    let next: { x: number; y: number; h: number } | null = null;
    // Only in a box you can type in: a disabled one (while Claude answers) shows no cursor, wherever
    // focus was left.
    if (el && m && !el.disabled && document.activeElement === el && el.selectionStart === el.selectionEnd) {
      const cs = getComputedStyle(el);
      // Longhands only: WebKit can report shorthands like font as empty.
      for (const prop of MIRRORED) m.style.setProperty(prop, cs.getPropertyValue(prop));
      // Wrapping width: the textarea's content box, without its scrollbar.
      m.style.width = `${el.clientWidth}px`;
      m.style.boxSizing = "border-box";
      const at = el.selectionStart;
      const rest = el.value.slice(at);
      m.replaceChildren(document.createTextNode(el.value.slice(0, at)), Object.assign(document.createElement("span"), { textContent: rest || "." }));
      const mark = m.lastChild as HTMLElement;
      // The first line box of what follows the cursor: its left edge is the cursor, its height the
      // font's ascent to descent (a pixel trimmed from each end), where the glyphs sit.
      const box = mark.getClientRects()[0];
      const origin = m.getBoundingClientRect();
      if (box) {
        const top = box.top - origin.top - el.scrollTop + 1;
        const h = Math.max(8, box.height - 2);
        // Only when it lies wholly inside the visible text: a cursor scrolled out of view (or measured
        // against a box that has since shrunk) is not drawn, rather than drawn outside the box.
        // In an empty box it sits just before where the placeholder starts (the text indent), a hair off it.
        const empty = (parseFloat(cs.textIndent) || 0) - 3;
        if (top >= -1 && top + h <= el.clientHeight + 1) next = { x: el.value ? box.left - origin.left : empty, y: top, h };
      }
    }
    // Only a real move re-renders; this keeps typing light.
    const key = next ? `${Math.round(next.x * 2)}:${Math.round(next.y * 2)}:${Math.round(next.h)}` : "";
    if (key === last.current) return;
    last.current = key;
    setCaret(next);
  };
  const timer = useRef(0);
  const later = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(place, 0);
  };
  useLayoutEffect(later, [text, disabled]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const events = ["focus", "blur", "input", "keydown", "keyup", "pointerdown", "pointerup", "select", "scroll", "compositionupdate", "compositionend"] as const;
    events.forEach((e) => el.addEventListener(e, later));
    // Arrow keys, word jumps and drags move the cursor without an input event.
    const onSelection = () => document.activeElement === el && later();
    document.addEventListener("selectionchange", onSelection);
    const resized = new ResizeObserver(later);
    resized.observe(el);
    document.fonts?.ready.then(later);
    return () => {
      window.clearTimeout(timer.current);
      events.forEach((e) => el.removeEventListener(e, later));
      document.removeEventListener("selectionchange", onSelection);
      resized.disconnect();
    };
  }, []);
  return { mirror, caret };
}

/** What the caret's mirror copies from the textarea, so it lays text out the same way. */
const MIRRORED = [
  "direction",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-style",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-size",
  "font-size-adjust",
  "line-height",
  "font-family",
  "font-kerning",
  "font-feature-settings",
  "font-variation-settings",
  "text-align",
  "text-transform",
  "text-indent",
  "text-decoration",
  "text-rendering",
  "letter-spacing",
  "word-spacing",
  "tab-size",
] as const;

/** How long each example prompt shows in the reply box before the next scrambles in. */
const HINT_MS = 4500;

/**
 * Where you write back to the session: grows with what you type; Enter sends, Shift+Enter starts a
 * new line (and text being composed with an input method is never sent early). Given several
 * placeholders, it cycles through them, each scrambling into the next, while the box is empty.
 */
function Composer({
  onSend,
  autoFocus = false,
  disabled = false,
  placeholder = "Reply to Claude…",
  status,
  onStop,
}: {
  onSend: (text: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  placeholder?: string | string[];
  /** While it's disabled: what Claude is doing, shown in the box where the placeholder goes, on one line. */
  status?: string;
  /** While it's disabled: the send button becomes Stop, which calls this. */
  onStop?: () => void;
}) {
  const [text, setText] = useState("");
  const hints = typeof placeholder === "string" ? [placeholder] : placeholder;
  const [hint, setHint] = useState(0);
  useEffect(() => {
    if (hints.length < 2 || text) return;
    const t = setInterval(() => setHint((h) => (h + 1) % hints.length), HINT_MS);
    return () => clearInterval(t);
  }, [hints.length, !text]);
  const cycling = hints.length > 1;
  const shownHint = hints[hint % hints.length] ?? "";
  const scrambledHint = useScrambled(shownHint);
  const showStatus = disabled && !!status;
  const scrambledStatus = useScrambled(status ?? "");
  const stopping = disabled && !!onStop;
  const ref = useRef<HTMLTextAreaElement>(null);
  const { mirror, caret } = useThinCaret(ref, text, disabled);
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
        <div className="composer-field">
          <div ref={mirror} className="composer-mirror" aria-hidden />
          {caret && <span key={`${caret.x}:${caret.y}`} className="composer-caret" style={{ left: caret.x, top: caret.y, height: caret.h }} aria-hidden />}
          {/* What Claude is doing, in the placeholder's place: drawn over the box so it stays on one line. */}
          {showStatus && (
            <span className="composer-status text-shimmer" role="status">
              {scrambledStatus}
            </span>
          )}
          <textarea
            ref={ref}
            rows={1}
            autoFocus={autoFocus}
            disabled={disabled}
            value={text}
            // The textarea's own placeholder, scrambling from one example to the next, so it sits exactly
            // where typed text does.
            placeholder={showStatus ? "" : scrambledHint}
            aria-label={cycling ? "Message" : shownHint.replace(/…$/, "")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
        </div>
        {stopping ? (
          // As in Claude: while it works, the send button is Stop. It ends the turn and everything it started.
          <button className="composer-send composer-stop" type="button" onClick={onStop} aria-label="Stop">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <rect x="3" y="3" width="6" height="6" rx="1.2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button className="composer-send" type="submit" disabled={disabled || !text.trim()} aria-label="Send reply">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </form>
    </div>
  );
}

/**
 * Streamed text revealed at a steady pace: Claude Code delivers a reply in a few quick bursts, so
 * this types out what has arrived, faster the further behind it is (all of it within about half a
 * second), instead of jumping a burst at a time.
 */
function useSmoothText(target: string): string {
  const [count, setCount] = useState(target.length);
  const shown = useRef(target.length);
  const goal = useRef(target);
  goal.current = target;
  // A new reply (not a continuation of what's shown) starts from nothing.
  const prev = useRef(target);
  if (!target.startsWith(prev.current.slice(0, shown.current))) shown.current = 0;
  prev.current = target;
  useEffect(() => {
    if (shown.current >= target.length) {
      shown.current = target.length;
      setCount(target.length);
      return;
    }
    let frame = 0;
    let then = performance.now();
    const step = (now: number) => {
      const behind = goal.current.length - shown.current;
      const perSecond = Math.max(90, behind / 0.45);
      shown.current = Math.min(goal.current.length, shown.current + Math.max(1, Math.round(perSecond * ((now - then) / 1000))));
      then = now;
      setCount(shown.current);
      if (shown.current < goal.current.length) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return target.slice(0, Math.min(count, target.length));
}

/** Claude's mark, turning while it works. */
/** Claude Code's working glyph: a star that grows and shrinks through its shapes, in Claude's orange. */
const CLAUDE_FRAMES = SPINNER_FRAMES;

export function ClaudeSpark() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % CLAUDE_FRAMES.length), 120);
    return () => clearInterval(t);
  }, []);
  return (
    <span className={`claude-spark${CLAUDE_FRAMES[frame] === "·" ? " dot" : ""}`} aria-hidden>
      {CLAUDE_FRAMES[frame]}
    </span>
  );
}

/** What the session is waiting on you for: the step it stopped at and what it asked. */
export interface SessionAsk {
  /** 1-based step number, or null when the only thing waiting is a message to send. */
  step: number | null;
  title: string;
  note?: string;
  /**
   * The plan's steps, with where each stands and what finished it. Given, the chat lays out side by
   * side: the steps on the left, the conversation on the right.
   */
  steps?: OutlineStep[];
  /** What Orb sent or created that isn't tied to a step, listed under the steps. */
  artifacts?: TaskLink[];
  /**
   * A task's chat: its plan is always in view (beside the chat, or on the card beside the dock), so
   * there's no box above the chat; `step` only marks the current one.
   */
  stepsOnly?: boolean;
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
  plain = false,
  hideSteps = false,
  headAction,
  subtitle,
  extra,
  empty,
  placeholder,
  onSend,
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
  /** Leave the plan's steps out (the Detail view's Tasks area, where the task's card sits beside the chat). */
  hideSteps?: boolean;
  ask: SessionAsk | null;
  messages: ChatMessage[];
  working: string | undefined;
  toSend: PendingSend[];
  canReply: boolean;
  /** Beside the close button (New chat, in the global chat). */
  headAction?: ReactNode;
  /** A lighter line after the title, saying what the chat is for. */
  subtitle?: string;
  /** More cards under the conversation once Claude's turn is over (proposed changes, in the global chat). */
  extra?: ReactNode;
  /** Shown while the conversation is empty. */
  empty?: ReactNode;
  /** The reply box's placeholder; several cycle through as examples. */
  placeholder?: string | string[];
  /** Sends your message another way than continuing the session (the global chat's first message starts it). */
  onSend?: (message: string) => void;
  onClose: () => void;
  onChange: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // The turn under way, if any (see chatView): from your send, or from Orb setting the session to
  // work itself. Everything before where it began stays put while it runs.
  const [turn, setTurn] = useState<ChatTurn | null>(null);
  // Whether the session has started on this turn yet (until then, it's queued: still busy).
  const [turnStarted, setTurnStarted] = useState(false);
  const live = useJobStatus(`live:${taskId}`);
  // The last live text, kept after the turn ends until the transcript's copy lands.
  const [held, setHeld] = useState<string | null>(null);
  useEffect(() => {
    if (live) setHeld(live);
  }, [live]);
  useEffect(() => {
    if (!working) return;
    setTurnStarted(true);
    setTurn((t) => t ?? { base: messages.length, text: null });
  }, [working]);
  const send = (message: string) => {
    setTurn({ base: messages.length, text: message });
    setTurnStarted(false);
    setHeld(null);
    if (onSend) onSend(message);
    else continueTaskSession(taskId, message, true).then(onChange, onChange);
    onChange();
  };
  const view = chatView(messages, turn, { working: !!working, live: live ?? null, held });
  const endTurn = () => {
    setTurn(null);
    setHeld(null);
  };
  useEffect(() => {
    if (view.done) endTurn();
  }, [view.done]);
  // A turn that ended without the transcript ever showing it (cut short, or worded differently)
  // is let go after a while, so the chat never sits on a stale copy.
  useEffect(() => {
    if (!turn || working || live || (turn.text !== null && !turnStarted)) return;
    const t = setTimeout(endTurn, 20_000);
    return () => clearTimeout(t);
  }, [turn, working, live, turnStarted]);
  const shown = view.shown;
  const liveText = useSmoothText(view.reply ? readableReply(view.reply) : "");
  // Keep the newest message in view as the conversation grows.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, working, toSend.length, liveText.length]);
  // Answering, or your message is queued and the session hasn't picked it up yet.
  const busy = !!working || (!!turn && turn.text !== null && !turnStarted);

  // With the plan's steps, the chat sits beside them: steps on the left, the conversation on the right.
  const split = !hideSteps && !!ask?.steps?.length;
  const docked = useInDock();
  const head = (
    <header className="chat-modal-head">
      <span className="chat-modal-title">
        {title}
        {subtitle && <span className="chat-modal-subtitle">{subtitle}</span>}
      </span>
      <span className="chat-modal-head-actions">
        {headAction}
        <button className="icon-button" onClick={onClose} title="Close" aria-label="Close">
          <CloseIcon />
        </button>
      </span>
    </header>
  );
  const askBox = ask && !ask.stepsOnly && (
    <div className="chat-ask">
      <span className="chat-ask-step">
        {/* The waiting marker only for a step that's waiting on you; talking the plan through isn't one. */}
        {!plain && !!ask.step && <StepCircle state="waiting" />}
        {ask.step ? `Step ${ask.step} · ${ask.title}` : ask.title}
      </span>
      {ask.note && <p className="chat-ask-note">{ask.note}</p>}
    </div>
  );
  const conversation = (
    <>
      <div className="chat-log" ref={scroller}>
        {!shown.length && !busy && empty}
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
        {liveText && (
          <div className="chat-turn claude">
            <ClaudeText text={liveText} />
          </div>
        )}
        {/* Under Claude's reply as it forms, as in a Claude session: its working glyph. What it's
            doing shows in the reply box, and the box's Stop ends the turn. */}
        {busy && (
          <div className="chat-working" aria-hidden>
            <ClaudeSpark />
          </div>
        )}
        {!busy && toSend.map((st) => <HandoffRow key={st.key} taskId={taskId} send={st} onChange={onChange} />)}
        {!busy && extra}
      </div>
      {canReply && (
        <footer className="chat-modal-foot">
          <Composer
            onSend={send}
            autoFocus
            disabled={busy}
            placeholder={placeholder}
            status={working ? `${working[0].toUpperCase()}${working.slice(1)}…` : "Thinking…"}
            // Ends this turn, and everything it started; Carry on picks it up again.
            onStop={() => stopTaskSession(taskId)}
          />
        </footer>
      )}
    </>
  );

  // In a chat dock (the Detail view's Updates area) it draws inline, filling the dock; elsewhere it's
  // a window over everything.
  const panel = (
      <div className={`modal chat-modal${plain ? " plain" : ""}${split ? " split" : ""}${docked ? " docked" : ""}`} role="dialog" aria-label={`Conversation about ${title}`} onClick={(e) => e.stopPropagation()}>
        {split ? (
          <>
            <div className="chat-modal-top">{head}</div>
            <div className="chat-split">
              <aside className="chat-steps">
                {askBox}
                <ol className="chat-steps-list">
                  {ask!.steps!.map((st, i) => (
                    <li key={`${i}:${st.title}`} className={[st.progress && `step-${st.progress.state}`, ask!.step === i + 1 && "current"].filter(Boolean).join(" ") || undefined}>
                      <StepCircle state={st.progress?.state} />
                      <span className="chat-step-body">
                        <span className="chat-step-title">
                          {st.title}
                          {st.by === "you" && st.progress?.state !== "done" && st.progress?.state !== "skipped" && <span className="step-human">Human</span>}
                        </span>
                        {st.progress?.state === "blocked" && st.progress.note && <span className="chat-step-note">Blocked: {st.progress.note}</span>}
                        {st.links && st.links.length > 0 && <LinkChips links={st.links} />}
                      </span>
                    </li>
                  ))}
                </ol>
                {ask!.artifacts && ask!.artifacts.length > 0 && (
                  <div className="chat-steps-made">
                    <span className="chat-steps-made-label">Made in this chat</span>
                    <LinkChips links={ask!.artifacts} />
                  </div>
                )}
              </aside>
              <div className="chat-main">{conversation}</div>
            </div>
          </>
        ) : (
          <>
            <div className="chat-modal-top">
              {head}
              {askBox}
            </div>
            {conversation}
          </>
        )}
      </div>
  );
  if (docked) return panel;
  return createPortal(
    <div className="modal-backdrop plan-modal-backdrop" onClick={onClose}>
      {panel}
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
  chatOpen,
  onOpenChat,
  onChange,
}: {
  taskId: string;
  link: SessionLink;
  /** What the session is doing right now, while a turn runs. */
  working: string | undefined;
  needsInput: boolean;
  /** The chat is open already, so its button has nothing to do. */
  chatOpen: boolean;
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
          {/* Stopping it yourself isn't an error; a timeout says why it stopped. */}
          {link.lastError === STOPPED_BY_YOU ? <span className="muted">You stopped Claude.</span> : <span className="error">Claude stopped: {link.lastError}</span>}
          <button
            className="link-button small"
            onClick={() => {
              continueTaskSession(taskId, "Please carry on where you left off.", true).then(onChange, onChange);
              onChange();
            }}
          >
            {link.lastError === STOPPED_BY_YOU ? "Carry on" : "Try again"}
          </button>
        </div>
      )}
      {/* Open in chat is always here: to answer it, to review what it wrote, or to have it re-check its
          steps against the conversation. The step it's waiting on says Human. */}
      <button className={needsInput && !working && !chatOpen ? "cta-primary" : "cta-ghost"} disabled={chatOpen} onClick={onOpenChat}>
        Open in chat
      </button>
    </>
  );
}

/**
 * While the linked Claude session is still being looked for, says so. Once it's found, the checklist
 * above shows how far it's got, and the Plan heading when the plan was made, so this says nothing.
 */
function SessionStatus({ progress }: { progress: SessionProgress | null; steps: OutlineStep[] }) {
  if (!progress || progress.found) return null;
  return <span className="timestamp small session-status">Looking for the Claude session…</span>;
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
}: {
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
  // Starts folded away; its title row opens it.
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen(!open);
  return (
    <div className={`check-result task-check ${check.verdict}${open ? "" : " folded"}`}>
      {/* The whole title row folds and unfolds it. */}
      <div className="check-head small" onClick={toggle}>
        <span className="check-title">Task investigation</span>
        {/* One status: a correction being applied (spinner, no time yet), or the outcome and when. */}
        {correction && "working" in correction ? (
          <span className="timestamp check-status" aria-label={correction.working}>
            <Spinner />
          </span>
        ) : correction ? (
          <span className="timestamp check-status hover-stamp">Correction applied {ago(correction.appliedAt)}</span>
        ) : (
          <span className="check-status">
            <span className="check-verdict">{CHECK_VERDICT[check.verdict]}</span> <span className="timestamp hover-stamp">{ago(check.at)}</span>
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
  mergedIn = [],
  compact = false,
  unread = false,
  onSeen,
  dateBadge,
  created,
  watch,
  onChange,
}: {
  /** Makes this the card for a watched topic (see CardExtension); tasks don't pass it. */
  watch?: CardExtension;
  /** When the task was created, if known: shown in the open card beside the due date. */
  created?: string | null;
  /**
   * A date to show as a badge on the card's top line, collapsed or open: the due date or when it was
   * created, when the list is sorted by one ("No due date" / "No date" when it has none).
   */
  dateBadge?: { kind: "due" | "created"; date: string | null };
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
  /** Tasks merged into this one (by Demian or by you), each with Separate to undo it. */
  mergedIn?: MergedTask[];
  /** Show a one-line row (title, priority, estimate, status) until clicked. */
  compact?: boolean;
  /** Demian found something new about it since you last opened it: a green dot after its title. */
  unread?: boolean;
  /** Marks it seen; called while the card is open. */
  onSeen?: () => void;
  onChange: () => void;
}) {
  const checkStatus = useJobStatus(`taskcheck:${task.id}`);
  const progress = useSessionProgress(task.id, sessionLink, onChange);
  /** A Claude session has picked this task up; the card follows it from now on. */
  const linked = !!sessionLink?.sessionId;
  // Collapsed cards show one line; the arrow after the badges opens and closes them. At most one card
  // is open at a time: every card starts collapsed except the one you last opened, and opening a card
  // closes the other, and its chat if that's open. A card that becomes compact (a task just marked done in Today) closes too.
  // Every id this card's task goes by: its own, and those of tasks merged into it.
  const ids = useMemo(() => new Set([task.id, ...(("aliasIds" in task ? (task as { aliasIds: string[] }).aliasIds : []) ?? [])]), [task]);
  const [collapsed, setCollapsedState] = useState(() => !(openTask && ids.has(openTask)));
  const setCollapsed = (value: boolean) => {
    if (!value) {
      openTask = task.id;
      window.dispatchEvent(new CustomEvent(TASK_OPEN_EVENT, { detail: task.id }));
    } else if (openTask === task.id) openTask = null;
    setCollapsedState(value);
  };
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
  // View in tasks: this card opens and scrolls into view, now or as soon as it's shown.
  useEffect(() => {
    const reveal = () => {
      if (!pendingReveal || !ids.has(pendingReveal)) return;
      pendingReveal = null;
      closeForOther.current(true);
      // After it has opened, so its full height is in view.
      window.setTimeout(() => cardRef.current?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }), 320);
    };
    reveal();
    window.addEventListener(TASK_REVEAL_EVENT, reveal);
    return () => window.removeEventListener(TASK_REVEAL_EVENT, reveal);
  }, [ids]);
  // Another card opened: this one closes.
  const closeForOther = useRef(setOpen);
  closeForOther.current = setOpen;
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== task.id) closeForOther.current(false);
    };
    window.addEventListener(TASK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(TASK_OPEN_EVENT, onOpen);
  }, [task.id]);
  const [editing, setEditing] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
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
      { id: task.id, title: task.title, description, brief: task.brief, link: task.link, requester: task.requester, projectName: task.project?.name },
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
  const planSteps: { title: string; by: "claude" | "you" | null }[] = progress?.plan
    ? progress.plan
    : plan
      ? plan.plan.steps.map((st) => ({ title: st.title, by: st.by ?? null }))
      : (assessment?.claude_steps ?? []).map((title) => ({ title, by: "claude" as const }));
  const chips = artifactChips(sessionLink, planSteps.map((st) => st.title));
  // A watched topic brings its own steps, each with its state (see CardExtension).
  const outlineSteps: OutlineStep[] = watch
    ? watch.steps
    : planSteps
        .map((st, i) => ({ ...st, progress: stepState(progress, sessionLink, i + 1, st.title), links: chips.byStep.get(i + 1) }))
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
  const sessionWorking = useJobStatus(`session:${task.id}`);
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
  // The steps follow the chat. The session restates the plan when the work changes, and when it may
  // not have, Orb re-checks the steps against the conversation once the turn is over, once per change
  // in the transcript: when you said something it didn't restate the plan for, when it reported a
  // step the list doesn't have, or when a later step moved while an earlier one isn't done.
  const recheckStatus = useJobStatus(`recheck:${task.id}`);
  // The list the session numbers its reports by: the plan it last wrote itself, else the one it started with.
  const sessionSteps =
    progress?.ownPlan ?? (plan ? plan.plan.steps.map((st) => ({ title: st.title, by: st.by ?? null })) : (assessment?.claude_steps ?? []).map((title) => ({ title, by: "claude" as const })));
  const recheckSteps = () => progress && recheckSessionSteps(task.id, task.title, outlineSteps, progress, sessionSteps).then(onChange, onChange);
  const transcriptKey = progress ? `${progress.reports ?? 0}:${progress.messages?.length ?? 0}` : null;
  useEffect(() => {
    if (watch || sessionLink?.topic || !sessionLink?.sessionId || !progress?.found || sessionWorking || recheckStatus) return;
    if (transcriptKey === sessionLink.recheckedKey) return;
    if (stepsNeedRecheck(progress, outlineSteps.map((st) => st.progress), sessionLink.recheck?.userMessages ?? 0)) recheckSteps();
  }, [transcriptKey, sessionWorking]);
  // A step blocked on someone else blocks the task, during a plan discussion too; once no step is,
  // the task moves on again (see statusForBlockedSteps). Checked whenever the plan's link or phase
  // changes as well, so a block found before the card was shown still applies.
  const anyBlocked = outlineSteps.some((st) => st.progress?.state === "blocked");
  const wasBlocked = useRef(anyBlocked);
  useEffect(() => {
    const was = wasBlocked.current;
    wasBlocked.current = anyBlocked;
    if (!sessionLink) return;
    const next = statusForBlockedSteps(anyBlocked, was, task.status);
    if (next) setTaskState(task.id, { status: next }).then(onChange);
  }, [anyBlocked, !!sessionLink]);
  // The task is under way once Claude starts on the plan (you told it to go ahead in the chat): only
  // as that happens, so a task you set back to To do afterwards stays as you set it.
  const begun = !watch && !!sessionLink && outlineSteps.some((st) => st.progress && st.progress.state !== "blocked");
  const wasBegun = useRef(begun);
  useEffect(() => {
    const justBegun = begun && !wasBegun.current;
    wasBegun.current = begun;
    if (justBegun && task.status === "todo") setTaskState(task.id, { status: "in_progress" }).then(onChange);
  }, [begun]);
  const waitingIndex = outlineSteps.findIndex((st) => st.progress?.state === "waiting");
  const waitingStep = waitingIndex >= 0 ? outlineSteps[waitingIndex] : undefined;
  const toSend = progress ? unsentMessages(progress.sends, sessionLink) : [];
  // The task is done once every step is (see planFinished), with nothing handed over still to send
  // or create. Only as that happens, so a task you reopen afterwards stays open.
  const allStepsDone = !watch && planFinished(outlineSteps.map((st) => st.progress), toSend.length);
  const wereAllDone = useRef(allStepsDone);
  useEffect(() => {
    const justFinished = allStepsDone && !wereAllDone.current;
    wereAllDone.current = allStepsDone;
    if (justFinished && task.status !== "done") setTaskState(task.id, { status: "done" }).then(onChange);
  }, [allStepsDone]);
  const needsInput = watch ? !!waitingStep : !!sessionLink?.sessionId && (!!waitingStep || toSend.length > 0);
  /**
   * What the chat was opened for: a step (its number), the plan or a message to send (0), or null
   * when it's closed.
   */
  const [chatFor, setChatFor] = useState<number | null>(null);
  // In the Detail view's Tasks area the chat opens in the dock beside the list (see TaskChatDock):
  // opening it here claims the dock; another task's chat taking it closes this one; and a card that
  // finds the dock already holding its task's chat (it just moved into Today) shows it.
  const chatDock = useTaskChatDock();
  const ownsDock = chatDock?.owner?.id === task.id;
  const lastChatFor = useRef(chatFor);
  useEffect(() => {
    const was = lastChatFor.current;
    lastChatFor.current = chatFor;
    if (!chatDock) return;
    // Opening, or switching what the chat is for, keeps the dock's record of it current.
    if (chatFor !== null && (!ownsDock || chatDock.owner?.kind !== chatFor)) chatDock.open(task.id, chatFor);
    else if (chatFor === null && was !== null && ownsDock) chatDock.close(task.id);
  }, [chatFor]);
  const owned = useRef(ownsDock);
  useEffect(() => {
    if (ownsDock && chatFor === null) setChatFor(chatDock!.owner!.kind);
    else if (!ownsDock && owned.current && chatFor !== null) setChatFor(null);
    owned.current = ownsDock;
  }, [ownsDock]);
  const openChat = () => setChatFor(waitingIndex >= 0 ? waitingIndex + 1 : 0);
  // Opening another card closes this one's chat, as a window or in the dock, so the chat on screen
  // is the open card's or none.
  useEffect(() => {
    const onOpen = (e: Event) => {
      if (!ids.has((e as CustomEvent<string>).detail)) setChatFor(null);
    };
    window.addEventListener(TASK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(TASK_OPEN_EVENT, onOpen);
  }, [ids]);
  // Otherwise the chat stays open until you close it, whatever the session does meanwhile.
  const chatAsk: SessionAsk | null =
    chatFor === null
      ? null
      : (() => {
          // The plan as it now stands (it follows the chat as the work changes), with the step that's
          // waiting on you marked.
          const at = waitingIndex >= 0 ? waitingIndex + 1 : null;
          return {
            step: at,
            title: at ? (outlineSteps[at - 1]?.title ?? "") : "The plan",
            stepsOnly: true,
            steps: outlineSteps,
            artifacts: chips.loose,
          };
        })();
  // Open in chat only opens the chat: nothing runs until you send a message. Your first message
  // starts the task's session, which talks the plan through and carries it out once you tell it to
  // go ahead there. Also when an earlier start never got going (the app quit before Claude answered):
  // there's a link, but no session to talk to.
  const fresh = !sessionLink?.sessionId && !sessionWorking;
  const startWith = async (message: string) => {
    const prompt = taskChatPrompt(
      { id: task.id, title: task.title, description, brief: task.brief, link: task.link, requester: task.requester, projectName: task.project?.name },
      assessment?.suggestion ?? "",
      outlineSteps,
      message,
    );
    await startTaskChat(task.id, prompt, onChange);
    onChange();
  };
  const openTaskChat = () => openChat();
  // The task's chat. In the Detail view it sits in the dock beside the list, drawn whatever state
  // the card is in (collapsed, or done and shrunk to a row), so it stays until you close it or open
  // another card.
  const chatView = watch ? (
    chatFor !== null ? watch.chat(() => setChatFor(null)) : null
  ) : chatFor !== null ? (
      <SessionChat
        taskId={task.id}
        title={task.title}
        // A chat not started yet starts with your first message. One that began as something else
        // (its Draft response) learns the task's steps with your next message.
        onSend={
          fresh
            ? (message) => {
                startWith(message).catch(() => {});
              }
            : sessionLink?.topic
            ? (message) => {
                db.updateSessionLink(task.id, { topic: false })
                  .then(() => continueTaskSession(task.id, `${message}\n\n${adoptAsTaskNote(task.title, outlineSteps.map((st) => `${st.by === "you" ? "[Me] " : ""}${st.title}`))}`, true))
                  .then(onChange, onChange);
              }
            : undefined
        }
        hideSteps={!!chatDock}
        ask={chatAsk}
        // Its changes to its task are made when its turn ends (see applyTaskChatChanges); one that
        // wasn't (its turn was stopped or failed, or it's from before) shows as a card to apply.
        extra={
          <TaskChangeCards
            taskId={task.id}
            title={task.title}
            actions={progress?.actions ?? []}
            link={sessionLink}
            said={[...(progress?.messages ?? [])].reverse().find((m) => m.role === "user")?.text}
            onChange={onChange}
          />
        }
        messages={progress?.messages ?? []}
        working={sessionWorking}
        toSend={toSend}
        canReply={!!sessionLink?.sessionId || fresh}
        placeholder={fresh ? "Ask about this task, change its plan, or tell Claude to go ahead…" : undefined}
        empty={
          fresh && sessionLink?.lastError ? (
            <div className="chat-empty small muted">Claude couldn't start: {sessionLink.lastError}. Send a message to try again.</div>
          ) : undefined
        }
        onClose={() => setChatFor(null)}
        onChange={onChange}
      />
    ) : null;
  // Claude, at the right of the row under the plan box: pointing at it opens a menu above with Open
  // in Claude (its session, once it has one; clicking Claude does this too) and Connect a session,
  // for one you started yourself.
  const pick = (run: () => void) => (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    (document.activeElement as HTMLElement | null)?.blur();
    run();
  };
  const claudeLink = (
    <span className="claude-menu-anchor" onClick={(e) => e.stopPropagation()}>
      <button className="link-button small more-link claude-link" aria-haspopup="menu" onClick={pick(openInClaude)}>
        <img src={CLAUDE_ICON} width={11} height={11} alt="" />
        Claude
      </button>
      <span className="card menu-card claude-menu small" role="menu" aria-label="Claude">
        <button role="menuitem" className="link-button small" onClick={pick(openInClaude)}>
          Open in Claude
        </button>
        <button role="menuitem" className="link-button small" onClick={pick(() => setConnecting(true))}>
          Connect a session
        </button>
      </span>
    </span>
  );
  // Inside the plan box: what belongs to the plan itself (a plan being written, and the session's
  // view of it). There's no Plan steps button: a task gets its plan in its chat.
  const planActions = watch ? undefined : (
      <div className="plan-actions">
        {sessionLink && !sessionWorking && !needsInput && !recheckStatus && <SessionStatus progress={progress} steps={outlineSteps} />}
        {/* Inline where there's no dock; in the Detail view it's drawn into the dock (below), open or not. */}
        {!chatDock && chatView}
      </div>
    );
  /** Saves an edited description, then has Claude plan again from it. */
  /** Saves an edited description. Before work starts, Claude assesses and plans again from it; once a session is linked, the plan stays as the session has it. */
  const saveDescription = async (next: string | null, fromUser = true) => {
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
    if (fromUser)
      recordCorrection(
        { kind: "description_edit", subject: "task", subject_id: task.id, project_id: task.project?.id, before: taskSnapshot(task), after: { description: next } },
        label.description(task.title),
      );
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
      .then(() => saveDescription(correction, false))
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
        : task.source === "meeting"
          ? "preparation for a meeting on the user's calendar"
          : task.source;
  const runPlan = (descriptionText: string | null = description ?? null) => {
    planTask({
      id: task.id,
      title: task.title,
      description: descriptionText,
      brief: task.brief ?? null,
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
      ...(watch?.links ?? []),
      // Links its chat added as it worked.
      ...(sessionLink?.links ?? []),
    ],
    [description],
  );
  // Double check: the reload button at the right of the card's header (where a watched topic's
  // Check now is), shown on hover and while it runs. Every task has it, a task with a chat too: the
  // check reads the task's sources, not the chat.
  const checkAction = watch ? null : (
    <span className={`card-refresh${checkStatus ? " busy" : ""}`} onClick={(e) => e.stopPropagation()}>
      <RefreshButton
        busy={!!checkStatus}
        status={checkStatus ?? undefined}
        title="Double check: that the task was captured right, is still needed, and isn't a duplicate"
        onClick={runCheck}
      />
    </span>
  );
  // In the row at the bottom of the card, just left of Claude.
  const linksToggle =
    links.length > 0 ? (
      <button className="link-button small more-link links-toggle" onClick={() => setLinksOpen(!linksOpen)} aria-expanded={linksOpen}>
        {linksOpen ? "Hide links" : `Links (${links.length})`}
      </button>
    ) : null;
  // Under the plan box, so they show on an open card whether the box is open or not: Open in chat
  // (with what Claude is doing, or why it stopped) and, at the right, Links and Claude.
  const chatActions = watch ? undefined : (
      <div className="plan-actions task-chat-actions">
        {/* On every task, planned or not, all yours or not: it's also where you change a task. Once
            there's a session, the session panel's Open in chat takes over. */}
        {!sessionLink && (
          <button
            className="cta-primary"
            disabled={chatFor !== null}
            onClick={openTaskChat}
            title="Talk the task through with Claude, or change it; once you tell it to go ahead, it does its steps and asks you for yours"
          >
            Open in chat
          </button>
        )}
        {sessionLink && (
          <SessionPanel
            taskId={task.id}
            link={sessionLink}
            // The open chat already shows what Claude is doing.
            working={chatFor === null ? sessionWorking : undefined}
            needsInput={needsInput}
            chatOpen={chatFor !== null}
            onOpenChat={openChat}
            onChange={onChange}
          />
        )}
        {linksToggle}
        {claudeLink}
      </div>
    );
  // The open task a double check says this one duplicates, if it's still open.
  const duplicateTarget = check?.duplicate_of ? openTasks.find((t) => t.id === check.duplicate_of) : undefined;
  const setStateAndRefresh = async (patch: Parameters<typeof setTaskState>[1]) => {
    await setTaskState(task.id, patch);
    onChange();
  };


  const drag = useTaskDrag(task.id, cardRef);
  // Opening the card is reading what's new on it, and anything new while it's open is read too.
  useEffect(() => {
    if (!collapsed && unread) onSeen?.();
  }, [collapsed, unread]);

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

  const estimateMinutes = taskEstimate(plan?.plan, assessment);
  // Your hands-on time: always the first badge, whatever the list is sorted by. Folded, it slides in
  // on hover with the rest.
  const estimate = estimateMinutes != null && (
    <span className="estimate" title="Your own hands-on time, estimated from the plan's steps (Claude's work isn't counted)">
      {formatMinutes(estimateMinutes)}
    </span>
  );
  // Human until you set the status yourself, which answers it until the session asks for something new.
  const waitingFor = humanKey(waitingStep?.title, toSend.map((m) => m.key));
  const human = needsInput && !task.done && (!!watch || sessionLink?.humanSeen !== waitingFor);
  const working = !!sessionWorking && !task.done;
  const pinStatus = human || working;
  const status = (
    <StatusSelect
      task={task}
      human={human}
      working={working}
      onPicked={human && !watch ? () => db.updateSessionLink(task.id, { humanSeen: waitingFor }) : undefined}
      onChange={onChange}
    />
  );
  // One header for both states, so the title row stays exactly where it is when the card opens or closes.
  const header = (
    <header className="task-card-header">
      {/* A closed card opens on any click (see the article); an open one closes from its title, as
          from the arrow, unless the click was the end of selecting the title's text. */}
      <span
        className="task-title-wrap"
        onClick={
          collapsed
            ? undefined
            : () => {
                if (window.getSelection()?.toString()) return;
                setOpen(false);
              }
        }
      >
        <span className="task-title">
          {watch?.titlePending ? <span className="muted">{watch.titlePending}</span> : task.title}
        </span>
        {unread && <UnreadDot />}
        {watch?.stamp && <span className="timestamp small card-stamp">{watch.stamp}</span>}
      </span>
      {estimate && <span className="task-extras">{estimate}</span>}
      {/* Folded, the card shows only the badge its list is sorted by (the date when sorted by one,
          else the priority); the rest slide in beside it while it's hovered, and stay when it's open. */}
      {watch ? null : dateBadge ? (
        <span className={`badge date-badge${dateBadge.date ? "" : " none"}`}>
          {dateBadge.date ? `${dateBadge.kind === "due" ? "Due " : ""}${formatWhen(dateBadge.date)}` : dateBadge.kind === "due" ? "No due date" : "No date"}
        </span>
      ) : (
        <PriorityBadge task={task} priority={priority} manual={manualPriority} automatic={automaticPriority} onChange={onChange} />
      )}
      {(task.recommended || dateBadge || !pinStatus) && (
        <span className="task-extras">
          {task.recommended && <RecommendedBadge />}
          {dateBadge && <PriorityBadge task={task} priority={priority} manual={manualPriority} automatic={automaticPriority} onChange={onChange} />}
          {!pinStatus && status}
        </span>
      )}
      {/* Human or Working stays in the title row, folded or open: it's what you'd look for. */}
      {pinStatus && status}
      {watch?.refresh ? (
        <span className={`card-refresh${watch.refresh.busy ? " busy" : ""}`} onClick={(e) => e.stopPropagation()}>
          <RefreshButton busy={watch.refresh.busy} title="Check now" status="Checking" onClick={watch.refresh.onClick} />
        </span>
      ) : (
        checkAction
      )}
      {toggle}
    </header>
  );

  return (
    <>
    <article
      ref={cardRef}
      className={`card task-card${watch ? " watched" : ""}${collapsed ? " collapsed" : ""}${animating ? " animating" : ""}${drag.className} status-${task.status}${task.done ? " done" : ""}`}
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
              {(watch?.meta || !watch || SOURCE_LABEL[task.source] || task.project || task.requester || task.due || created) && (
                <div className="muted small task-meta">
                  {watch?.meta ?? (task.project && <span className="task-project">{task.project.name}</span>)}
                  {SOURCE_LABEL[task.source] && <span className={`source ${task.source}`}>{SOURCE_LABEL[task.source]}</span>}
                  {task.requester && <span>{task.requester}</span>}
                  {watch ? task.due && <span className="due timestamp">Due {formatWhen(task.due)}</span> : <DueDate task={task} onChange={onChange} />}
                  {created && (
                    // Just the day (in your time zone), not the time.
                    <span className="timestamp" title={new Date(created).toLocaleString()}>
                      Created {formatWhen(localDate(new Date(created)))}
                    </span>
                  )}
                </div>
              )}

              {connecting && (
                <ConnectSessionModal
                  task={{ id: task.id, title: task.title, description }}
                  replacing={linked}
                  onClose={() => setConnecting(false)}
                  onConnected={() => {
                    setConnecting(false);
                    onChange();
                  }}
                />
              )}
              {editing && (
                <DescriptionEditor title={task.title} initial={description ?? ""} onSave={saveDescription} onCancel={() => setEditing(false)} />
              )}
              {description ? (
                <Description text={description} />
              ) : (
                manual && (
                  <button className="link-button small muted add-description" onClick={() => setEditing(true)}>
                    Add a description…
                  </button>
                )
              )}


              {duplicateOf && !linked && (
                <div className="duplicate-note small">
                  <span className="duplicate-text">
                    Possible duplicate of <span className="duplicate-title">"{duplicateOf.title}"</span>
                  </span>
                  <span className="duplicate-actions">
                    <button
                      className="link-button small"
                      onClick={async () => {
                        await mergeTasks(task.id, duplicateOf.id, duplicateOf.title);
                        onChange();
                        recordCorrection(
                          { kind: "task_merge", subject: "task", subject_id: task.id, project_id: task.project?.id, before: { kept: taskSnapshot(task), folded: { title: duplicateOf.title } }, after: { into: task.id } },
                          label.merge(task.title),
                        );
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
                        recordCorrection(
                          { kind: "not_duplicate", subject: "task", subject_id: task.id, project_id: task.project?.id, before: { task: taskSnapshot(task), looked_like: { id: duplicateOf.id, title: duplicateOf.title } } },
                          label.notDuplicate(task.title),
                        );
                      }}
                    >
                      Not a duplicate
                    </button>
                  </span>
                </div>
              )}

              {mergedIn.filter((m) => !m.hidden).map((m) => (
                <div key={m.id} className="duplicate-note merged-note small">
                  <span className="duplicate-text">
                    Merged <span className="duplicate-title">"{m.title}"</span>
                  </span>
                  <span className="duplicate-actions">
                    <button
                      className="link-button small"
                      onClick={async () => {
                        await separateTasks(task.id, m.id);
                        onChange();
                        recordCorrection(
                          { kind: "not_duplicate", subject: "task", subject_id: task.id, project_id: task.project?.id, before: { task: taskSnapshot(task), looked_like: { id: m.id, title: m.title } } },
                          label.notDuplicate(task.title),
                        );
                      }}
                      title="Make it its own task again; Demian won't merge these two again"
                    >
                      Undo merge
                    </button>
                    <button
                      className="icon-button merged-close"
                      title="Hide this note; the tasks stay merged"
                      aria-label="Hide this note"
                      onClick={async () => {
                        await hideMergedNote(task.id, m.id);
                        onChange();
                      }}
                    >
                      <CloseIcon size={8} />
                    </button>
                  </span>
                </div>
              ))}

              {sessionLink?.found && !sessionLink.found.hidden && (
                <div className="duplicate-note merged-note small">
                  <span className="duplicate-text">
                    {sessionLink.found.created ? "Made from Claude session " : "Connected to Claude session "}
                    <span className="duplicate-title">"{sessionLink.found.session}"</span>
                  </span>
                  <span className="duplicate-actions">
                    {/* Made from the session, the task goes with it: what's learned is that it isn't one.
                        Connected, the task stays: the session just isn't its work. */}
                    <button
                      className="link-button small"
                      onClick={async () => {
                        const found = sessionLink.found!;
                        await disconnectSession(task.id);
                        if (found.created) await setTaskState(task.id, { dismissed: true });
                        onChange();
                        recordCorrection(
                          { kind: "session_unlink", subject: "task", subject_id: task.id, project_id: task.project?.id, before: { task: taskSnapshot(task), session: found.session, created: found.created } },
                          found.created ? label.sessionNotTask(task.title) : label.sessionUnlink(task.title),
                        );
                      }}
                      title={
                        sessionLink.found.created
                          ? "Dismiss this task, and don't make tasks from this session"
                          : "Stop following this session; Demian won't connect it again"
                      }
                    >
                      {sessionLink.found.created ? "Not a task" : "Disconnect"}
                    </button>
                    <button
                      className="icon-button merged-close"
                      title="Hide this note; the session stays connected"
                      aria-label="Hide this note"
                      onClick={async () => {
                        await db.updateSessionLink(task.id, { found: { ...sessionLink.found!, hidden: true } });
                        onChange();
                      }}
                    >
                      <CloseIcon size={8} />
                    </button>
                  </span>
                </div>
              )}

              {watch ? (
                <>
                  <AssessmentView
                    assessment={null}
                    steps={outlineSteps}
                    planning={false}
                    heading={watch.heading}
                    role={watch.role}
                    openWhen={needsInput}
                    empty={watch.empty}
                  />
                  {watch.after}
                  <div className="plan-actions">
                    {watch.actions({ discuss: () => setChatFor(0), chatOpen: chatFor !== null })}
                    {linksToggle}
                    {!chatDock && chatView}
                  </div>
                </>
              ) : assessment ? (
                <AssessmentView
                  planCreated={plan?.created_at}
                  assessment={assessment}
                  steps={outlineSteps}
                  onAddDetails={!editing ? () => setEditing(true) : undefined}
                  actions={planActions}
                  planning={planning}
                  onMarkDone={markDone}
                  onRemind={remind}
                  alwaysOpen
                  busy={planning || !!recheckStatus}
                />
              ) : (
                // No assessment yet: the same Plan box, saying there's no plan yet (a spinner while Claude reviews the task).
                <AssessmentView
                  assessment={null}
                  steps={outlineSteps}
                  actions={planActions}
                  planning={planning}
                  onMarkDone={markDone}
                  onRemind={remind}
                  planCreated={plan?.created_at}
                  alwaysOpen
                  busy={planning || !!recheckStatus || (manual && assessing)}
                />
              )}
              {/* The investigation, under the plan and above the row of actions. */}
              {check && !checkStatus && (
                <TaskCheckResult
                  check={check}
                  duplicateTitle={duplicateTarget?.title}
                  onMerge={
                    duplicateTarget
                      ? async () => {
                          await mergeTasks(duplicateTarget.id, task.id, task.title);
                          await clearTaskCheck(task.id);
                          onChange();
                          recordCorrection(
                            { kind: "task_merge", subject: "task", subject_id: duplicateTarget.id, project_id: task.project?.id, before: { kept: { title: duplicateTarget.title }, folded: taskSnapshot(task) }, after: { into: duplicateTarget.id } },
                            label.merge(duplicateTarget.title),
                          );
                        }
                      : undefined
                  }
                  onDone={() => setStateAndRefresh({ status: "done" })}
                  onDismiss={() => setStateAndRefresh({ dismissed: true }).then(() => recordDismiss(task))}
                  correction={correctionState}
                />
              )}
              {chatActions}
              {/* Last, under a line across the card. */}
              {linksOpen && links.length > 0 && (
                <div className="task-links">
                  <LinkChips links={links} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

    </article>
    {/* Beside the card, not in it, so clicks in the chat don't open a collapsed card. */}
    {chatDock?.target && chatView && createPortal(<InDock>{chatView}</InDock>, chatDock.target)}
    </>
  );
}
