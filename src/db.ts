import type { SessionLink } from "./sessions";
import Database from "@tauri-apps/plugin-sql";
import type { AdhocTask, BlockerCheck, CalendarDay, TaskCheck, ManualAssessment, Priority, NewsItem, ProjectSnapshot, QuickReply, RepoState, TaskPlan } from "./schema";
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
  /** Task ids the Orb recommends doing today. */
  recommended?: string[];
  created_at: string;
}

export async function getReading(): Promise<StoredReading | null> {
  return json<StoredReading>(await getSetting("daily_reading"));
}

export async function saveReading(reading: StoredReading) {
  await setSetting("daily_reading", JSON.stringify(reading));
}

// ---- per-task data: one row per item in task_data, so concurrent saves can't clobber each other

type Store =
  | "description_overrides"
  | "refined_descriptions"
  | "priority_overrides"
  | "session_links"
  | "task_checks"
  | "blocker_checks"
  | "reminders"
  | "not_duplicates";

async function getRows<T>(store: Store): Promise<Record<string, T>> {
  const rows = await (await db()).select<{ task_id: string; value: string }[]>("SELECT task_id, value FROM task_data WHERE store = $1", [store]);
  const out: Record<string, T> = {};
  for (const r of rows) {
    const v = json<T>(r.value);
    if (v !== null) out[r.task_id] = v;
  }
  return out;
}

async function putRow(store: Store, id: string, value: unknown) {
  await (await db()).execute(
    `INSERT INTO task_data (store, task_id, value, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT(store, task_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [store, id, JSON.stringify(value), nowIso()],
  );
}

async function deleteRow(store: Store, id: string) {
  await (await db()).execute("DELETE FROM task_data WHERE store = $1 AND task_id = $2", [store, id]);
}

/**
 * Descriptions the user edited on Slack, email and project tasks, by task id.
 * Those tasks are rewritten on each refresh, so the edits live here.
 */
export const getDescriptionOverrides = () => getRows<string>("description_overrides");

export async function saveDescriptionOverride(taskId: string, text: string | null) {
  if (text) await putRow("description_overrides", taskId, text);
  else await deleteRow("description_overrides", taskId);
}

/**
 * Descriptions a refresh wrote when it found new information about an existing task (see
 * taskIndex.ts), by canonical task id. Shown unless the user edited the description themselves.
 */
export const getRefinedDescriptions = () => getRows<string>("refined_descriptions");

export const saveRefinedDescription = (taskId: string, text: string) => putRow("refined_descriptions", taskId, text);

export interface StoredTaskCheck extends TaskCheck {
  at: string;
}

/** Priorities the user set by hand, keyed by task id. */
export const getPriorityOverrides = () => getRows<Priority>("priority_overrides");

/** Sets a task's priority by hand, or with null goes back to the automatic one. */
export async function setPriorityOverride(taskId: string, priority: Priority | null) {
  if (priority) await putRow("priority_overrides", taskId, priority);
  else await deleteRow("priority_overrides", taskId);
}

/** Claude Code sessions Orb opened for tasks, keyed by task id. */
export const getSessionLinks = () => getRows<SessionLink>("session_links");

export const saveSessionLink = (taskId: string, link: SessionLink) => putRow("session_links", taskId, link);

/** Double checks of tasks, keyed by task id. */
export const getTaskChecks = () => getRows<StoredTaskCheck>("task_checks");

export const clearTaskCheck = (taskId: string) => deleteRow("task_checks", taskId);

export const saveTaskCheck = (taskId: string, check: TaskCheck) => putRow("task_checks", taskId, { ...check, at: nowIso() });

export interface StoredBlockerCheck extends BlockerCheck {
  at: string;
}

/** Double checks of blockers, keyed by blocker id. */
export const getBlockerChecks = () => getRows<StoredBlockerCheck>("blocker_checks");

export const saveBlockerCheck = (blockerId: string, check: BlockerCheck) => putRow("blocker_checks", blockerId, { ...check, at: nowIso() });

export interface Reminder {
  at: string;
  link: string | null;
}

/** Reminders and update requests sent about blockers and active work, keyed by item id. */
export const getReminders = () => getRows<Reminder>("reminders");

export const saveReminder = (blockerId: string, reminder: Reminder) => putRow("reminders", blockerId, reminder);

// ---- task registry: which refs (message permalinks, thread ids, other task ids) are the same task

/** Every alias ref and the canonical task id it belongs to. */
export async function getTaskAliases(): Promise<Map<string, string>> {
  const rows = await (await db()).select<{ ref: string; task_id: string }[]>("SELECT ref, task_id FROM task_sources");
  return new Map(rows.map((r) => [r.ref, r.task_id]));
}

/**
 * Records that `ref` is the same task as `taskId` (itself resolved to its canonical id), and moves
 * anything already aliased to `ref` along with it, so chains always end at one canonical task.
 */
export async function addTaskAlias(ref: string, taskId: string, how: "refined" | "merged") {
  const conn = await db();
  const canonical = (await getTaskAliases()).get(taskId) ?? taskId;
  if (ref === canonical) return;
  await conn.execute(
    `INSERT INTO task_sources (ref, task_id, added_at, how) VALUES ($1, $2, $3, $4)
     ON CONFLICT(ref) DO UPDATE SET task_id = excluded.task_id, how = excluded.how`,
    [ref, canonical, nowIso(), how],
  );
  await conn.execute("UPDATE task_sources SET task_id = $1 WHERE task_id = $2", [canonical, ref]);
}

/**
 * Merges task `dropId` into `keepId` (both canonical ids): drop becomes another source of keep, so
 * it folds into keep's card everywhere. Keep's own data stands; anything it lacks that drop had (a
 * priority you set, a session, an edited or refined description, a plan, a Today slot) carries over.
 */
export async function mergeTasks(keepId: string, dropId: string) {
  if (keepId === dropId) return;
  const conn = await db();
  await addTaskAlias(dropId, keepId, "merged");
  await conn.execute(
    `INSERT OR IGNORE INTO task_data (store, task_id, value, updated_at)
     SELECT store, $1, value, $3 FROM task_data
     WHERE task_id = $2 AND store IN ('priority_overrides', 'session_links', 'description_overrides', 'refined_descriptions')`,
    [keepId, dropId, nowIso()],
  );
  await conn.execute(
    "INSERT OR IGNORE INTO task_plans (task_id, plan, created_at, cost_usd) SELECT $1, plan, created_at, cost_usd FROM task_plans WHERE task_id = $2",
    [keepId, dropId],
  );
  const states = await getTaskStates();
  const dropToday = states.get(dropId)?.todayOn;
  if (dropToday && !states.get(keepId)?.todayOn) await setTaskState(keepId, { todayOn: dropToday });
}

/** Pairs the user said aren't duplicates, as "a|b" with a < b. */
export const getNotDuplicates = async () => new Set(Object.keys(await getRows<true>("not_duplicates")));

export const notDuplicateKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export const markNotDuplicate = (a: string, b: string) => putRow("not_duplicates", notDuplicateKey(a, b), true);

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
