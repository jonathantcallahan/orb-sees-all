/**
 * When a task came to be, for sorting All tasks by date created. Tasks you add record it; a task from
 * a Slack message dates from the message (its permalink carries the time); anything else (a project
 * or email task) from when Demian first saw it, recorded as it turns up.
 */

/** The time a Slack permalink points at (…/p1700000000000100 → 1700000000.000100), or null. */
export function slackTime(url: string | null | undefined): string | null {
  const m = url?.match(/\/p(\d{10})(\d{6})(?:\D|$)/);
  return m ? new Date(Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000)).toISOString() : null;
}

export function createdAt(task: { id: string; link?: string | null; created_at?: string | null }, firstSeen: Record<string, string>): string | null {
  return task.created_at ?? slackTime(task.id) ?? slackTime(task.link) ?? firstSeen[task.id] ?? null;
}

/** How All tasks can be sorted. Priority is the default and the only one your drag order applies to. */
export type TaskSort = "priority" | "due" | "newest" | "oldest";

export const TASK_SORTS: [TaskSort, string][] = [
  ["priority", "Priority"],
  ["due", "Due date"],
  ["newest", "Newest"],
  ["oldest", "Oldest"],
];

/**
 * Tasks in a sort's order (a stable sort, so ties keep the order they came in: priority order).
 * Due date: soonest first, undated last. Newest and oldest: by date created, undated last.
 */
export function sortTasks<T extends { id: string; due?: string | null; link?: string | null; created_at?: string | null }>(
  tasks: T[],
  sort: TaskSort,
  firstSeen: Record<string, string>,
): T[] {
  if (sort === "priority") return tasks;
  const key = (t: T) => (sort === "due" ? (t.due ?? null) : createdAt(t, firstSeen));
  const dir = sort === "newest" ? -1 : 1;
  return tasks
    .map((t, i) => ({ t, i, k: key(t) }))
    .sort((a, b) => (a.k && b.k ? a.k.localeCompare(b.k) * dir : a.k ? -1 : b.k ? 1 : 0) || a.i - b.i)
    .map(({ t }) => t);
}
