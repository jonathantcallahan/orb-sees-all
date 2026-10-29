import type { ProjectStatus } from "./schema";

export interface TaskState {
  done: boolean;
  dismissed: boolean;
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
 * source permalinks, so a checked task stays checked after a refresh.
 * Dismissed tasks are hidden; done tasks sort after open ones.
 */
export function applyTaskState<T extends Omit<ViewTask, "done">>(tasks: T[], states: Map<string, TaskState>): (T & { done: boolean })[] {
  return tasks
    .filter((t) => !states.get(t.id)?.dismissed)
    .map((t) => ({ ...t, done: states.get(t.id)?.done ?? false }))
    .sort((a, b) => Number(a.done) - Number(b.done));
}

const STATUS_ORDER: Record<ProjectStatus, number> = { blocked: 0, at_risk: 1, on_track: 2, idle: 3 };

/** Blocked first, then at risk, on track, idle; projects never refreshed go last. */
export function compareProjects(
  a: { name: string; status: ProjectStatus | null },
  b: { name: string; status: ProjectStatus | null },
): number {
  const rank = (s: ProjectStatus | null) => (s ? STATUS_ORDER[s] : 4);
  return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name);
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
 * theirs, and open tasks that are due soon or sit in a blocked or at-risk
 * project. Done and dismissed tasks don't count.
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
    const hot = p.status === "blocked" || p.status === "at_risk";
    criticalTasks += tasks.filter((t) => hot || dueSoon(t.due, now)).length;
  }
  criticalTasks += otherTasks.filter((t) => open(t) && dueSoon(t.due, now)).length;
  const level =
    0.5 * Math.min(projectsOnMe / PROJECTS_AT_MAX, 1) + 0.5 * Math.min(criticalTasks / CRITICAL_AT_MAX, 1);
  return { projectsOnMe, criticalTasks, level };
}
