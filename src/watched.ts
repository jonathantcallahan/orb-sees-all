import { localDate } from "./scheduler";

/**
 * Watched topics: things the user asked Demian to keep an eye on (a contract that should come back,
 * a decision someone owes them), each with outcomes to act on. An outcome is "if this happens" or
 * "if this hasn't happened by a date", then what to do, which becomes a task when it's ready.
 */
export interface WatchedOutcome {
  id: string;
  /** "happens": ready once the event happens. "not_by": ready if it still hasn't by `by`. */
  when: "happens" | "not_by";
  /** What to look for, in the user's words ("Legal signs off on the contract"). */
  event: string;
  /** For "not_by": the last day it can happen, YYYY-MM-DD. */
  by: string | null;
  /** What to do then, in the user's words; the title of the task it becomes. */
  then: string;
  /** What the last check found: whether the event has happened, and the evidence. */
  occurred?: boolean;
  evidence?: string | null;
  link?: string | null;
  /** The task made from it (Create and open task). */
  taskId?: string | null;
}

export interface WatchedStatus {
  summary: string;
  links: { title: string; link: string }[];
}

/** One update a check found: when it was collected, and what it said. */
export interface WatchedUpdate extends WatchedStatus {
  at: string;
}

/** The most updates a topic keeps; the oldest go first. */
const HISTORY_KEPT = 50;

/**
 * A topic's updates after a check: the new one added when it says something new (a check that finds
 * nothing has changed doesn't repeat itself), oldest dropped past HISTORY_KEPT.
 */
export function withUpdate(history: WatchedUpdate[], update: WatchedUpdate): WatchedUpdate[] {
  const last = history[history.length - 1];
  if (last && last.summary.trim() === update.summary.trim()) return history;
  return [...history, update].slice(-HISTORY_KEPT);
}

export interface WatchedTopic {
  id: string;
  topic: string;
  details: string | null;
  /** The project it belongs to, like a task's, or null. */
  projectId: string | null;
  outcomes: WatchedOutcome[];
  status: WatchedStatus | null;
  /** Every update its checks found, oldest first. */
  history: WatchedUpdate[];
  checkedAt: string | null;
  createdAt: string;
}

/**
 * Where an outcome stands. "ready": act on it now. "waiting": the event hasn't happened (and its
 * date, if any, hasn't passed). "not_needed": a "not by" whose event happened in time. "acted": a
 * task was made from it.
 */
export type OutcomeState = "ready" | "waiting" | "not_needed" | "acted";

export function outcomeState(o: WatchedOutcome, today = localDate(new Date())): OutcomeState {
  if (o.taskId) return "acted";
  if (o.when === "happens") return o.occurred ? "ready" : "waiting";
  if (o.occurred) return "not_needed";
  return o.by && today > o.by ? "ready" : "waiting";
}

/** Outcomes a check still needs to look into: ones not acted on whose event hasn't been seen yet. */
export const openOutcomes = (t: WatchedTopic) => t.outcomes.filter((o) => !o.taskId && !o.occurred);

/** "Nov 12" from YYYY-MM-DD, read as a local date. */
export function shortDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** What the task made from an outcome says: why it's needed now, and what Demian found. */
export function outcomeTaskDescription(t: WatchedTopic, o: WatchedOutcome): string {
  const why =
    o.when === "happens"
      ? `This happened: ${o.event}.`
      : `This hadn't happened by ${o.by ? shortDate(o.by) : "the date"}: ${o.event}.`;
  return [`From the watched topic "${t.topic}". ${why}`, o.evidence?.trim(), o.link, t.details?.trim() ? `About the topic: ${t.details.trim()}` : null]
    .filter(Boolean)
    .join("\n");
}

/**
 * A topic's conditional actions after they're restated (see actionsFromPlan): one whose condition
 * (what, when, by) is unchanged keeps what checks found and the task made from it; a new or changed
 * one starts fresh.
 */
export function mergeEditedOutcomes(before: WatchedOutcome[], edited: Pick<WatchedOutcome, "id" | "when" | "event" | "by" | "then">[]): WatchedOutcome[] {
  return edited.map((e) => {
    const old = before.find((o) => o.id === e.id);
    const same = old && old.when === e.when && old.event === e.event && (old.by ?? null) === (e.by ?? null);
    return same ? { ...old, ...e } : { ...e };
  });
}

/** A watched topic's chat is the session keyed by this and the topic's id. */
export const WATCH_CHAT = "watchchat:";

/** A conditional action as one plan line, the form a Discuss chat restates them in. */
export function actionLine(o: Pick<WatchedOutcome, "when" | "event" | "by" | "then">): string {
  return `If ${o.event} | ${o.when === "happens" ? "has happened" : `hasn't happened by ${o.by ?? "?"}`} | then ${o.then}`;
}

/**
 * The conditional action in a plan line written by actionLine, or null when the line isn't one.
 * Forgiving of how a model writes it: wrapped in backticks, quotes or bold, or with a curly apostrophe.
 */
export function parseActionLine(line: string): Pick<WatchedOutcome, "when" | "event" | "by" | "then"> | null {
  const clean = line.trim().replace(/^[`*"']+|[`*"']+$/g, "").replace(/[\u2018\u2019]/g, "'").trim();
  const m = clean.match(/^if\s+(.+?)\s*\|\s*(has happened|hasn't happened by\s+(\d{4}-\d{2}-\d{2}))\s*\|\s*then\s+(.+)$/i);
  if (!m) return null;
  const notBy = /^hasn't/i.test(m[2]);
  return { event: m[1].trim(), when: notBy ? "not_by" : "happens", by: notBy ? m[3] : null, then: m[4].trim() };
}

/**
 * The topic's conditional actions after a Discuss chat restated them: each kept by its id where its
 * line matches one already there (same condition), so what checks found stays; the rest are new.
 */
export function actionsFromPlan(before: WatchedOutcome[], lines: string[]): WatchedOutcome[] | null {
  const parsed = lines.map(parseActionLine);
  if (!parsed.length || parsed.some((p) => !p)) return null;
  const used = new Set<string>();
  const edited = parsed.map((p) => {
    const match = before.find((o) => !used.has(o.id) && o.event === p!.event && o.when === p!.when && (o.by ?? null) === (p!.by ?? null))
      ?? before.find((o) => !used.has(o.id) && o.then === p!.then);
    const id = match?.id ?? crypto.randomUUID();
    used.add(id);
    return { id, ...p! };
  });
  return mergeEditedOutcomes(before, edited);
}

/**
 * A conditional action as a step on the task card: not started while waiting, "waiting on you"
 * when ready (the status shows Human), done once a task was made from it, skipped when not needed.
 * So a topic whose actions are all done or skipped turns Done, as a task does.
 */
export const OUTCOME_STEP: Record<OutcomeState, "waiting" | "done" | "skipped" | undefined> = {
  waiting: undefined,
  ready: "waiting",
  acted: "done",
  not_needed: "skipped",
};

/**
 * A topic needs you (its status shows Human) when it's still watched and an action is ready to act
 * on, or you set it to Human yourself.
 */
export function needsYou(t: WatchedTopic, state: { done: boolean; dismissed: boolean; status?: string }, today = localDate(new Date())): boolean {
  return !state.done && !state.dismissed && (state.status === "waiting" || t.outcomes.some((o) => outcomeState(o, today) === "ready"));
}

/**
 * The topics to show, in order: ones that need you, then the rest still watched, then done ones.
 * Dismissed topics (Unwatch) are left out.
 */
export function orderTopics<T extends WatchedTopic>(topics: T[], state: (id: string) => { done: boolean; dismissed: boolean; status?: string }, today = localDate(new Date())): T[] {
  const rank = (t: T) => (state(t.id).done ? 2 : needsYou(t, state(t.id), today) ? 0 : 1);
  return topics.filter((t) => !state(t.id).dismissed).sort((a, b) => rank(a) - rank(b));
}

/** Whether a check should still look at a topic: not done, and not unwatched. */
export const stillWatched = (state: { done: boolean; dismissed: boolean }) => !state.done && !state.dismissed;
