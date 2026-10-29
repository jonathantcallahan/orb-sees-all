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
