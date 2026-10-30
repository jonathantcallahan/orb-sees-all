import type { Priority, ProjectPriority, ProjectStatus, Raci } from "./schema";

export type TaskStatus = "todo" | "in_progress" | "waiting" | "done";

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
  /** 0 (calm) to 1 (on fire). */
  level: number;
}

interface PressureProject {
  status: ProjectStatus | null;
  priority?: ProjectPriority | null;
  /** Ids of this project's tasks that are blocking it. */
  blockingIds?: string[];
  tasks: { id: string; due?: string | null }[];
}

/** Open tasks due within this many days (or overdue) count as critical. */
const CRITICAL_DUE_DAYS = 2;
/** Counts at which each signal saturates. */
const PROJECTS_AT_MAX = 6;
const CRITICAL_AT_MAX = 8;

function dueSoon(due: string | null | undefined, now: Date): boolean {
  if (!due) return false;
  const ms = new Date(`${due}T23:59:59`).getTime() - now.getTime();
  return !Number.isNaN(ms) && ms < CRITICAL_DUE_DAYS * 86_400_000;
}

/**
 * How much is waiting on the user: projects with at least one open task of
 * theirs, and open tasks that are blocking, due soon, or sit in a P0, blocked
 * or at-risk project. Done and dismissed tasks don't count.
 */
export function pressure(
  projects: PressureProject[],
  otherTasks: { id: string; due?: string | null }[],
  states: Map<string, TaskState>,
  now = new Date(),
): Pressure {
  const open = (t: { id: string }) => !states.get(t.id)?.done && !states.get(t.id)?.dismissed;
  let projectsOnMe = 0;
  let criticalTasks = 0;
  for (const p of projects) {
    const tasks = p.tasks.filter(open);
    if (tasks.length) projectsOnMe++;
    // Every task in a P0 project is critical, as are tasks in projects in trouble.
    const hot = p.priority === "P0" || p.status === "blocked" || p.status === "at_risk";
    criticalTasks += tasks.filter((t) => hot || p.blockingIds?.includes(t.id) || dueSoon(t.due, now)).length;
  }
  criticalTasks += otherTasks.filter((t) => open(t) && dueSoon(t.due, now)).length;
  const level =
    0.5 * Math.min(projectsOnMe / PROJECTS_AT_MAX, 1) + 0.5 * Math.min(criticalTasks / CRITICAL_AT_MAX, 1);
  return { projectsOnMe, criticalTasks, level };
}

export type OrbMood = "pleased" | "content" | "restless" | "agitated" | "furious";

/** The orb's mood for a pressure level; pleased only when nothing is waiting on the user. */
export function orbMood(p: Pressure): OrbMood {
  if (!p.projectsOnMe && !p.criticalTasks) return "pleased";
  if (p.level < 0.25) return "content";
  if (p.level < 0.5) return "restless";
  if (p.level < 0.75) return "agitated";
  return "furious";
}

/** Claude's priority levels plus "blocking", which outranks critical and is set by the app, never by Claude. */
export type EffectivePriority = Priority | "blocking";

/** Sort order for priorities, most urgent first; unrated last. */
export const PRIORITY_RANK: Record<EffectivePriority, number> = { blocking: 0, critical: 1, high: 2, medium: 3, low: 4 };

/**
 * A task's effective priority: a task that's one of the user's own blockers is
 * "blocking"; anything else in a P0 project is critical; otherwise Claude's
 * assessment stands (null until assessed).
 */
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

export interface TaskFilter {
  /** Empty means any source. */
  sources: TaskSource[];
  /** Empty means any status. */
  statuses: TaskStatus[];
  /** Empty means any priority. */
  priorities: PriorityFilter[];
  recommendedOnly: boolean;
}

export const NO_FILTER: TaskFilter = { sources: [], statuses: [], priorities: [], recommendedOnly: false };

export function isFiltering(f: TaskFilter): boolean {
  return f.sources.length > 0 || f.statuses.length > 0 || f.priorities.length > 0 || f.recommendedOnly;
}

/** Whether a task passes every filter that's set. */
export function matchesFilter(
  t: { status: TaskStatus; priority: EffectivePriority | null; recommended?: boolean; source?: TaskSource },
  f: TaskFilter,
): boolean {
  if (f.sources.length && (!t.source || !f.sources.includes(t.source))) return false;
  if (f.statuses.length && !f.statuses.includes(t.status)) return false;
  if (f.priorities.length && !f.priorities.includes(t.priority ?? "unrated")) return false;
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
