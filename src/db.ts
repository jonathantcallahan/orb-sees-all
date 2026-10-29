import Database from "@tauri-apps/plugin-sql";
import type { AdhocTask, CalendarDay, ManualAssessment, NewsItem, ProjectSnapshot, QuickReply, RepoState, TaskPlan } from "./schema";
import { stateOf, type TaskState, type TaskStatus } from "./tasks";

let conn: Promise<Database> | null = null;
const db = () => (conn ??= Database.load("sqlite:dayplanner.db"));

const nowIso = () => new Date().toISOString();
const json = <T>(text: string | null): T | null => (text ? (JSON.parse(text) as T) : null);

// ---- projects

export interface Project {
  channel_id: string;
  name: string;
  hidden: boolean;
  local_repos: string[];
  gh_repos: string[];
  last_refreshed_at: string | null;
  snapshot: ProjectSnapshot | null;
  repo_state: RepoState | null;
  last_error: string | null;
}

interface ProjectRow {
  channel_id: string;
  name: string;
  hidden: number;
  local_repos: string;
  gh_repos: string;
  last_refreshed_at: string | null;
  snapshot: string | null;
  repo_state: string | null;
  last_error: string | null;
}

export async function listProjects(): Promise<Project[]> {
  const rows = await (await db()).select<ProjectRow[]>("SELECT * FROM projects ORDER BY name");
  return rows.map((r) => ({
    ...r,
    hidden: r.hidden === 1,
    local_repos: JSON.parse(r.local_repos),
    gh_repos: JSON.parse(r.gh_repos),
    snapshot: json<ProjectSnapshot>(r.snapshot),
    repo_state: json<RepoState>(r.repo_state),
  }));
}

export async function getProject(channelId: string): Promise<Project | undefined> {
  return (await listProjects()).find((p) => p.channel_id === channelId);
}

/** Adds newly discovered channels and renames existing ones; never removes rows. */
export async function upsertChannels(channels: { channel_id: string; name: string }[]) {
  const d = await db();
  for (const c of channels) {
    await d.execute(
      "INSERT INTO projects (channel_id, name) VALUES ($1, $2) ON CONFLICT(channel_id) DO UPDATE SET name = excluded.name",
      [c.channel_id, c.name],
    );
  }
}

export async function saveProjectSnapshot(channelId: string, snapshot: ProjectSnapshot, refreshedAt: string) {
  await (await db()).execute(
    "UPDATE projects SET snapshot = $1, last_refreshed_at = $2, last_error = NULL WHERE channel_id = $3",
    [JSON.stringify(snapshot), refreshedAt, channelId],
  );
}

export async function saveRepoState(channelId: string, state: RepoState) {
  await (await db()).execute("UPDATE projects SET repo_state = $1 WHERE channel_id = $2", [JSON.stringify(state), channelId]);
}

export async function saveProjectError(channelId: string, error: string | null) {
  await (await db()).execute("UPDATE projects SET last_error = $1 WHERE channel_id = $2", [error, channelId]);
}

export async function updateProjectConfig(channelId: string, cfg: { hidden: boolean; local_repos: string[]; gh_repos: string[] }) {
  await (await db()).execute(
    "UPDATE projects SET hidden = $1, local_repos = $2, gh_repos = $3 WHERE channel_id = $4",
    [cfg.hidden ? 1 : 0, JSON.stringify(cfg.local_repos), JSON.stringify(cfg.gh_repos), channelId],
  );
}

// ---- settings and key/value snapshots

export async function getSetting(key: string): Promise<string | null> {
  const rows = await (await db()).select<{ value: string }[]>("SELECT value FROM settings WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await (await db()).execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export interface AdhocStore {
  tasks: AdhocTask[];
  replies: QuickReply[];
  news: NewsItem[];
  refreshed_at: string | null;
}

export async function getAdhoc(): Promise<AdhocStore> {
  const stored = json<Partial<AdhocStore>>(await getSetting("adhoc"));
  return { tasks: [], replies: [], news: [], refreshed_at: null, ...stored };
}

// ---- daily reading and reply drafts

export interface StoredReading {
  /** YYYY-MM-DD the reading is for. */
  date: string;
  text: string;
  created_at: string;
}

export async function getReading(): Promise<StoredReading | null> {
  return json<StoredReading>(await getSetting("daily_reading"));
}

export async function saveReading(reading: StoredReading) {
  await setSetting("daily_reading", JSON.stringify(reading));
}

export interface Reminder {
  at: string;
  link: string | null;
}

/** Reminders sent about blockers, keyed by blocker id. */
export async function getReminders(): Promise<Record<string, Reminder>> {
  return json<Record<string, Reminder>>(await getSetting("reminders")) ?? {};
}

export async function saveReminder(blockerId: string, reminder: Reminder) {
  const all = await getReminders();
  all[blockerId] = reminder;
  await setSetting("reminders", JSON.stringify(all));
}

export async function getReplyDrafts(): Promise<Map<string, { text: string; created_at: string }>> {
  const rows = await (await db()).select<{ reply_id: string; text: string; created_at: string }[]>("SELECT * FROM reply_drafts");
  return new Map(rows.map((r) => [r.reply_id, { text: r.text, created_at: r.created_at }]));
}

export async function saveReplyDraft(replyId: string, text: string, costUsd: number) {
  await (await db()).execute(
    "INSERT INTO reply_drafts (reply_id, text, created_at, cost_usd) VALUES ($1, $2, $3, $4) ON CONFLICT(reply_id) DO UPDATE SET text = excluded.text, created_at = excluded.created_at, cost_usd = excluded.cost_usd",
    [replyId, text, nowIso(), costUsd],
  );
}

export async function saveAdhoc(store: AdhocStore) {
  await setSetting("adhoc", JSON.stringify(store));
}

// ---- calendar

export async function getCalendarDay(date: string): Promise<{ day: CalendarDay; refreshed_at: string } | null> {
  const rows = await (await db()).select<{ data: string; refreshed_at: string }[]>(
    "SELECT data, refreshed_at FROM calendar_days WHERE date = $1",
    [date],
  );
  return rows[0] ? { day: JSON.parse(rows[0].data), refreshed_at: rows[0].refreshed_at } : null;
}

export async function saveCalendarDay(day: CalendarDay) {
  await (await db()).execute(
    "INSERT INTO calendar_days (date, data, refreshed_at) VALUES ($1, $2, $3) ON CONFLICT(date) DO UPDATE SET data = excluded.data, refreshed_at = excluded.refreshed_at",
    [day.date, JSON.stringify(day), nowIso()],
  );
}

// ---- tasks

export interface ManualTask {
  id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  created_at: string;
}

export async function listManualTasks(): Promise<ManualTask[]> {
  return (await db()).select<ManualTask[]>("SELECT * FROM manual_tasks ORDER BY created_at");
}

export async function addManualTask(title: string, projectId: string | null = null) {
  await (await db()).execute("INSERT INTO manual_tasks (id, title, project_id, created_at) VALUES ($1, $2, $3, $4)", [
    `manual:${crypto.randomUUID()}`,
    title,
    projectId,
    nowIso(),
  ]);
}

export async function updateManualTask(id: string, fields: { title: string; description: string | null }) {
  await (await db()).execute("UPDATE manual_tasks SET title = $1, description = $2 WHERE id = $3", [fields.title, fields.description, id]);
}

export async function getAssessments(): Promise<Map<string, ManualAssessment>> {
  const rows = await (await db()).select<{ task_id: string; data: string }[]>("SELECT task_id, data FROM task_assessments");
  return new Map(rows.map((r) => [r.task_id, JSON.parse(r.data)]));
}

export async function saveAssessments(list: ManualAssessment[]) {
  const d = await db();
  for (const a of list) {
    await d.execute(
      "INSERT INTO task_assessments (task_id, data, created_at) VALUES ($1, $2, $3) ON CONFLICT(task_id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at",
      [a.id, JSON.stringify(a), nowIso()],
    );
  }
}

/** Drops a task's assessment so the next assessment run redoes it, e.g. after the user edits it. */
export async function clearAssessment(taskId: string) {
  await (await db()).execute("DELETE FROM task_assessments WHERE task_id = $1", [taskId]);
}

export interface StoredPlan {
  plan: TaskPlan;
  created_at: string;
  cost_usd: number | null;
}

export async function getTaskPlans(): Promise<Map<string, StoredPlan>> {
  const rows = await (await db()).select<{ task_id: string; plan: string; created_at: string; cost_usd: number | null }[]>(
    "SELECT * FROM task_plans",
  );
  return new Map(rows.map((r) => [r.task_id, { plan: JSON.parse(r.plan), created_at: r.created_at, cost_usd: r.cost_usd }]));
}

export async function saveTaskPlan(taskId: string, plan: TaskPlan, costUsd: number) {
  await (await db()).execute(
    "INSERT INTO task_plans (task_id, plan, created_at, cost_usd) VALUES ($1, $2, $3, $4) ON CONFLICT(task_id) DO UPDATE SET plan = excluded.plan, created_at = excluded.created_at, cost_usd = excluded.cost_usd",
    [taskId, JSON.stringify(plan), nowIso(), costUsd],
  );
}

export async function getTaskStates(): Promise<Map<string, TaskState>> {
  const rows = await (await db()).select<{ task_id: string; status: TaskStatus | null; done: number; dismissed: number; today_on: string | null }[]>(
    "SELECT * FROM task_state",
  );
  return new Map(
    rows.map((r) => {
      const status = r.status ?? (r.done === 1 ? "done" : "todo");
      return [r.task_id, { status, dismissed: r.dismissed === 1, todayOn: r.today_on, done: status === "done" }];
    }),
  );
}

/** Updates part of a task's state, keeping the rest. */
export async function setTaskState(taskId: string, patch: Partial<Pick<TaskState, "status" | "dismissed" | "todayOn">>) {
  const current = stateOf(await getTaskStates(), taskId);
  const next = { ...current, ...patch };
  await (await db()).execute(
    `INSERT INTO task_state (task_id, status, done, dismissed, today_on, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, done = excluded.done, dismissed = excluded.dismissed,
       today_on = excluded.today_on, updated_at = excluded.updated_at`,
    [taskId, next.status, next.status === "done" ? 1 : 0, next.dismissed ? 1 : 0, next.todayOn, nowIso()],
  );
}

// ---- refresh log

export async function logStart(job: string, scope: string | null): Promise<number> {
  const res = await (await db()).execute("INSERT INTO refresh_log (job, scope, started_at, status) VALUES ($1, $2, $3, 'running')", [
    job,
    scope,
    nowIso(),
  ]);
  return res.lastInsertId as number;
}

export async function logFinish(id: number, result: { error?: string; costUsd?: number }) {
  await (await db()).execute("UPDATE refresh_log SET finished_at = $1, status = $2, error = $3, cost_usd = $4 WHERE id = $5", [
    nowIso(),
    result.error ? "error" : "ok",
    result.error ?? null,
    result.costUsd ?? null,
    id,
  ]);
}

/** Jobs still marked running belong to a previous launch that quit mid-refresh. */
export async function markInterruptedJobs() {
  await (await db()).execute(
    "UPDATE refresh_log SET status = 'error', error = 'Interrupted: the app quit during this refresh', finished_at = $1 WHERE status = 'running'",
    [nowIso()],
  );
}

export interface LogEntry {
  id: number;
  job: string;
  scope: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  error: string | null;
  cost_usd: number | null;
}

export async function recentLog(limit = 50): Promise<LogEntry[]> {
  return (await db()).select<LogEntry[]>("SELECT * FROM refresh_log ORDER BY id DESC LIMIT $1", [limit]);
}
