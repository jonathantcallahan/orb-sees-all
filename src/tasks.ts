import type { Automation, Priority, ProjectPriority, ProjectStatus, Raci } from "./schema";

export type TaskStatus = "todo" | "in_progress" | "waiting" | "blocked" | "done";

export interface TaskState {
  status: TaskStatus;
  dismissed: boolean;
  /** YYYY-MM-DD the task was planned for, or null when it isn't in Today. */
  todayOn: string | null;
  /** Derived from status, for code that only cares whether it's finished. */
  done: boolean;
}

export const DEFAULT_TASK_STATE: TaskState = { status: "todo", dismissed: false, todayOn: null, done: false };

export function stateOf(states: Map<string, TaskState>, id: string): TaskState {
  return states.get(id) ?? DEFAULT_TASK_STATE;
}

export interface ViewTask {
  id: string;
  title: string;
  link?: string | null;
  due?: string | null;
  detail?: string | null;
  done: boolean;
}

/**
 * Applies the user's saved state to freshly extracted tasks. Task ids are
 * source permalinks, so a task's status survives a refresh. Dismissed tasks
 * are hidden; done tasks sort after open ones.
 */
export function applyTaskState<T extends { id: string }>(
  tasks: T[],
  states: Map<string, TaskState>,
): (T & { done: boolean; status: TaskStatus; todayOn: string | null })[] {
  return tasks
    .map((t) => ({ t, st: stateOf(states, t.id) }))
    .filter(({ st }) => !st.dismissed)
    .map(({ t, st }) => ({ ...t, done: st.done, status: st.status, todayOn: st.todayOn }))
    .sort((a, b) => Number(a.done) - Number(b.done));
}

/**
 * Splits tasks into today's plan and the rest. A task is in Today when it was
 * planned for today, or planned for an earlier day and still isn't done
 * (carriedFrom says which day). Tasks done on an earlier day drop out.
 */
export function splitToday<T extends { todayOn: string | null; done: boolean }>(
  tasks: T[],
  today: string,
): { planned: (T & { carriedFrom: string | null })[]; rest: T[] } {
  const planned: (T & { carriedFrom: string | null })[] = [];
  const rest: T[] = [];
  for (const t of tasks) {
    if (t.todayOn === today) planned.push({ ...t, carriedFrom: null });
    else if (t.todayOn && t.todayOn < today && !t.done) planned.push({ ...t, carriedFrom: t.todayOn });
    else rest.push(t);
  }
  return { planned, rest };
}

/** "45m", "1h", "1h 30m". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const STATUS_ORDER: Record<ProjectStatus, number> = { blocked: 0, at_risk: 1, on_track: 2, idle: 3 };

/**
 * P0 first: priority leads (unprioritized projects after P4), then status
 * (blocked, at risk, on track, idle, never refreshed), then name.
 */
export function compareProjects(
  a: { name: string; status: ProjectStatus | null; priority?: string | null },
  b: { name: string; status: ProjectStatus | null; priority?: string | null },
): number {
  const rank = (s: ProjectStatus | null) => (s ? STATUS_ORDER[s] : 4);
  const prio = (p?: string | null) => (p ? Number(p.slice(1)) : 5);
  return prio(a.priority) - prio(b.priority) || rank(a.status) - rank(b.status) || a.name.localeCompare(b.name);
}

/** "3d", "5h" or "just now" since an ISO date or YYYY-MM-DD. */
export function age(since: string | null | undefined, now = new Date()): string | null {
  if (!since) return null;
  const ms = now.getTime() - new Date(since).getTime();
  if (Number.isNaN(ms)) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export interface Pressure {
  projectsOnMe: number;
  criticalTasks: number;
  /** Weighted open work: see pressure(). */
  load: number;
  /** Everything counted in the load: open tasks by priority, and how many are due soon or overdue. */
  tally?: PressureTally;
  /** 0 (calm) to 1 (on fire). */
  level: number;
}

/** An open-or-not task, as the orb weighs it. */
export interface PressureTask {
  id: string;
  priority: EffectivePriority | null;
  due?: string | null;
  /** The project it belongs to, for the "N projects blocked on you" count. */
  projectId?: string | null;
}

/**
 * How much each open task weighs, by priority. The orb answers mainly to blocking and high-priority
 * work: medium and low tasks barely register, so a long backlog alone doesn't make it angry.
 * Unrated tasks count like low ones.
 */
const TASK_WEIGHT: Record<EffectivePriority, number> = { blocking: 6, critical: 2.5, high: 0.75, medium: 0.1, low: 0.05 };
const UNRATED_WEIGHT = 0.05;
/** Extra weight for a task due within two days, and for one already overdue. */
const DUE_SOON_WEIGHT = 0.5;
const OVERDUE_WEIGHT = 1;
const DUE_SOON_DAYS = 2;
/**
 * Load at which stress reaches 63% (1 - 1/e). Stress = 1 - e^(-load/scale): it
 * rises quickly at first, then flattens, so each finished task always lowers it
 * a little and it never pins at the top. Furious takes real trouble, like a few
 * blockers of yours on top of a stack of critical work.
 */
export const LOAD_SCALE = 35;

export interface PressureTally {
  blocking: number;
  critical: number;
  high: number;
  medium: number;
  /** Low and unrated tasks, which weigh the same. */
  low: number;
  dueSoon: number;
  overdue: number;
}

function dueState(due: string | null | undefined, now: Date): "overdue" | "soon" | null {
  if (!due) return null;
  const ms = new Date(`${due}T23:59:59`).getTime() - now.getTime();
  if (Number.isNaN(ms)) return null;
  if (ms < 0) return "overdue";
  return ms < DUE_SOON_DAYS * 86_400_000 ? "soon" : null;
}

function dueWeight(due: string | null | undefined, now: Date): number {
  const state = dueState(due, now);
  return state === "overdue" ? OVERDUE_WEIGHT : state === "soon" ? DUE_SOON_WEIGHT : 0;
}

/**
 * How much is waiting on the user: every open task, weighted by its priority
 * and how soon it's due, mapped smoothly onto 0 (calm) to 1 (on fire). Done and
 * dismissed tasks don't count, so each one finished eases the orb a little.
 */
export function pressure(tasks: PressureTask[], states: Map<string, TaskState>, now = new Date()): Pressure {
  const open = tasks.filter((t) => !states.get(t.id)?.done && !states.get(t.id)?.dismissed);
  const load = open.reduce((sum, t) => sum + (t.priority ? TASK_WEIGHT[t.priority] : UNRATED_WEIGHT) + dueWeight(t.due, now), 0);
  return {
    // Projects you're holding up: ones where an open task of yours is one of its blockers.
    projectsOnMe: new Set(open.filter((t) => t.priority === "blocking").map((t) => t.projectId).filter(Boolean)).size,
    criticalTasks: open.filter((t) => t.priority === "blocking" || t.priority === "critical").length,
    load,
    level: 1 - Math.exp(-load / LOAD_SCALE),
    tally: {
      blocking: open.filter((t) => t.priority === "blocking").length,
      critical: open.filter((t) => t.priority === "critical").length,
      high: open.filter((t) => t.priority === "high").length,
      medium: open.filter((t) => t.priority === "medium").length,
      low: open.filter((t) => !t.priority || t.priority === "low").length,
      dueSoon: open.filter((t) => dueState(t.due, now) === "soon").length,
      overdue: open.filter((t) => dueState(t.due, now) === "overdue").length,
    },
  };
}

/** "a, b and c" */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Everything that feeds the orb's score, as a sentence or two, e.g. "2 projects are blocked on you.
 * You have 2 critical, 19 high and 5 low-priority tasks, 3 due soon and 1 overdue." Zero counts are
 * left out; null when nothing is waiting.
 */
export function describePressure(p: Pick<Pressure, "projectsOnMe" | "tally">): string | null {
  const sentences: string[] = [];
  if (p.projectsOnMe) sentences.push(`${p.projectsOnMe} project${p.projectsOnMe === 1 ? " is" : "s are"} blocked on you.`);
  const t = p.tally;
  if (t) {
    const levels = (
      [
        [t.blocking, "blocking"],
        [t.critical, "critical"],
        [t.high, "high"],
        [t.medium, "medium"],
        [t.low, "low"],
      ] as const
    ).filter(([n]) => n);
    if (levels.length) {
      const total = levels.reduce((sum, [n]) => sum + n, 0);
      const last = levels[levels.length - 1][1];
      // "-priority" reads naturally after high, medium and low, not after blocking or critical.
      const suffix = last === "blocking" || last === "critical" ? "" : "-priority";
      const kinds = listOf(levels.map(([n, label]) => `${n} ${label}`));
      const due = listOf([t.dueSoon ? `${t.dueSoon} due soon` : "", t.overdue ? `${t.overdue} overdue` : ""].filter(Boolean));
      sentences.push(`You have ${kinds}${suffix} task${total === 1 ? "" : "s"}${due ? `, ${due}` : ""}.`);
    }
  }
  return sentences.length ? sentences.join(" ") : null;
}

/** From calm to angry; each step down is a finished task or two closer to peace. */
export type OrbMood = "pleased" | "serene" | "content" | "attentive" | "restless" | "agitated" | "irritated" | "furious";

const MOOD_STEPS: [number, OrbMood][] = [
  [0.12, "serene"],
  [0.25, "content"],
  [0.4, "attentive"],
  [0.55, "restless"],
  [0.7, "agitated"],
  [0.85, "irritated"],
];

/** The orb's mood for a pressure level; pleased only when nothing at all is waiting. */
export function orbMood(p: Pick<Pressure, "load" | "level">): OrbMood {
  if (p.load === 0) return "pleased";
  return MOOD_STEPS.find(([max]) => p.level < max)?.[1] ?? "furious";
}

/** Claude's priority levels plus "blocking", which outranks critical and is set by the app, never by Claude. */
export type EffectivePriority = Priority | "blocking";

/** Sort order for priorities, most urgent first; unrated last. */
export const PRIORITY_RANK: Record<EffectivePriority, number> = { blocking: 0, critical: 1, high: 2, medium: 3, low: 4 };

/**
 * A task's priority: Blocking always wins; then one the user set by hand; then
 * critical for tasks in P0 projects; then Claude's assessment.
 */
export function taskPriority(
  assessed: Priority | null | undefined,
  projectPriority?: ProjectPriority | null,
  blocking = false,
  manual?: Priority | null,
): EffectivePriority | null {
  if (blocking) return "blocking";
  if (manual) return manual;
  if (projectPriority === "P0") return "critical";
  return assessed ?? null;
}

export type PriorityFilter = EffectivePriority | "unrated";

/** Where a task came from: a project channel, a Slack or email request, or the user's own list. */
export type TaskSource = "project" | "request" | "own";

/** When a task is due: overdue, within two days (as the orb counts it), later, or no date. */
export type DueFilter = "overdue" | "soon" | "later" | "none";

export function dueBucket(due: string | null | undefined, now = new Date()): DueFilter {
  if (!due) return "none";
  return dueState(due, now) ?? "later";
}

/** How much Orb can do on a task (its assessment's automation), or not assessed yet. */
export type AssistanceFilter = Automation | "unassessed";

export interface TaskFilter {
  /** Empty means any source. */
  sources: TaskSource[];
  /** Empty means any status. */
  statuses: TaskStatus[];
  /** Empty means any priority. */
  priorities: PriorityFilter[];
  /** Empty means any: whether Orb can do it, help with it, or it's the user's. */
  assistance: AssistanceFilter[];
  /** Empty means any due date. */
  dues: DueFilter[];
  recommendedOnly: boolean;
}

export const NO_FILTER: TaskFilter = { sources: [], statuses: [], priorities: [], assistance: [], dues: [], recommendedOnly: false };

export function isFiltering(f: TaskFilter): boolean {
  return f.sources.length > 0 || f.statuses.length > 0 || f.priorities.length > 0 || f.assistance.length > 0 || f.dues.length > 0 || f.recommendedOnly;
}

/** Whether a task passes every filter that's set. */
export function matchesFilter(
  t: { status: TaskStatus; priority: EffectivePriority | null; recommended?: boolean; source?: TaskSource; automation?: Automation | null; due?: string | null },
  f: TaskFilter,
  now = new Date(),
): boolean {
  if (f.sources.length && (!t.source || !f.sources.includes(t.source))) return false;
  if (f.statuses.length && !f.statuses.includes(t.status)) return false;
  if (f.priorities.length && !f.priorities.includes(t.priority ?? "unrated")) return false;
  if (f.assistance.length && !f.assistance.includes(t.automation ?? "unassessed")) return false;
  if (f.dues.length && !f.dues.includes(dueBucket(t.due, now))) return false;
  if (f.recommendedOnly && !t.recommended) return false;
  return true;
}

/** Task-state key for a blocker the user marked resolved. */
export const blockerKey = (blockerId: string) => `blocker:${blockerId}`;

/** "3d ago", "5h ago" or "just now". */
export function ago(since: string | null | undefined, now = new Date()): string | null {
  const a = age(since, now);
  return a && a !== "just now" ? `${a} ago` : a;
}

/** When something happened, to finish a phrase: "just now", "5m ago" or "3h ago" within a day, then the date ("Oct 29"). */
export function sinceWhen(at: string | null | undefined, now = new Date()): string {
  if (!at) return "";
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return "";
  if (now.getTime() - t.getTime() < 86_400_000) return ago(at, now) ?? "";
  return t.toLocaleDateString([], { month: "short", day: "numeric" });
}

export interface ProjectFilter {
  /** Empty means any status. */
  statuses: ProjectStatus[];
  /** Empty means any priority. */
  priorities: ProjectPriority[];
  /** Empty means any role. */
  roles: Raci[];
}

export const NO_PROJECT_FILTER: ProjectFilter = { statuses: [], priorities: [], roles: [] };

export function isFilteringProjects(f: ProjectFilter): boolean {
  return f.statuses.length > 0 || f.priorities.length > 0 || f.roles.length > 0;
}

/** Whether a project passes every filter that's set. */
export function matchesProjectFilter(
  p: { status: ProjectStatus | null; priority: ProjectPriority | null | undefined; role: Raci | null | undefined },
  f: ProjectFilter,
): boolean {
  if (f.statuses.length && (!p.status || !f.statuses.includes(p.status))) return false;
  if (f.priorities.length && (!p.priority || !f.priorities.includes(p.priority))) return false;
  if (f.roles.length && (!p.role || !f.roles.includes(p.role))) return false;
  return true;
}

/** Ids of a project's blockers the user owns and hasn't marked resolved: their blocking tasks. */
export function myBlockingIds(blockers: { id: string; owners: { is_me: boolean }[] }[] | undefined, states: Map<string, TaskState>): string[] {
  return (blockers ?? []).filter((b) => b.owners.some((o) => o.is_me) && !stateOf(states, blockerKey(b.id)).dismissed).map((b) => b.id);
}

/**
 * A list in the user's own order: tasks they've arranged take the slots those tasks occupy in the
 * default order, rearranged as saved; tasks they haven't touched (new ones) keep their default slot,
 * so a new urgent task still shows near the top.
 */
export function applyOrder<T extends { id: string }>(list: T[], saved: string[]): T[] {
  if (!saved.length) return list;
  const pos = new Map(saved.map((id, i) => [id, i]));
  const arranged = list.filter((t) => pos.has(t.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
  let k = 0;
  return list.map((t) => (pos.has(t.id) ? arranged[k++] : t));
}

/** `ids` with `id` moved (or added) just before `before`, or to the end. */
export function reorder(ids: string[], id: string, before: string | null): string[] {
  const rest = ids.filter((x) => x !== id);
  const at = before ? rest.indexOf(before) : -1;
  return at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)];
}
