import { withUpdate, type WatchedOutcome, type WatchedStatus, type WatchedTopic, type WatchedUpdate } from "./watched";
import type { SessionLink } from "./sessions";
import Database from "@tauri-apps/plugin-sql";
import type { AdhocTask, EpicChildren, BlockerCheck, CalendarDay, TaskCheck, ManualAssessment, Priority, NewsItem, ProjectProfile, ProjectSnapshot, QuickReply, RepoState, TaskPlan } from "./schema";
import { foldProfile, projectName, type DiscoveryPlan, type ProjectChannel } from "./projects";
import type { ProjectTracking } from "./jobs/tracking";
import { stateOf, type TaskState, type TaskStatus } from "./tasks";
import { announceTaskDone } from "./orbEvents";

let conn: Promise<Database> | null = null;
const db = () => (conn ??= Database.load("sqlite:dayplanner.db"));

const nowIso = () => new Date().toISOString();
const json = <T>(text: string | null): T | null => (text ? (JSON.parse(text) as T) : null);

// ---- projects

/** Tracked: on the board. Suggested: found by discovery, waiting for the user. Ignored and merged: off the board. */
export type ProjectState = "tracked" | "suggested" | "ignored" | "merged";

export interface Project {
  /** The project's id: the channel it was first found in. */
  channel_id: string;
  /** That channel's name. */
  name: string;
  /** Off the board: anything but tracked. */
  hidden: boolean;
  state: ProjectState;
  /** Why discovery thinks this is a project, for suggestions. */
  found_reason: string | null;
  merged_into: string | null;
  /** Every channel linked to the project, unlinked ones included (role "excluded"). */
  channels: ProjectChannel[];
  local_repos: string[];
  gh_repos: string[];
  last_refreshed_at: string | null;
  snapshot: ProjectSnapshot | null;
  profile: ProjectProfile | null;
  repo_state: RepoState | null;
  last_error: string | null;
  /** What the project is, as the user means it (see ProjectFocus); null until they say. */
  focus: ProjectFocus | null;
  /** A status the user set (through the Demian chat), when, and why; see projectStatus. */
  status_override: StatusOverride | null;
}

export interface StatusOverride {
  status: "blocked" | "at_risk" | "on_track" | "idle";
  reason: string | null;
  at: string;
}

async function getStatusOverrides(): Promise<Record<string, StatusOverride>> {
  return json<Record<string, StatusOverride>>(await getSetting("project_status")) ?? {};
}

/** Sets the status the user gave a project, or clears it (null) so the refreshes' own shows. */
export async function setProjectStatus(projectId: string, status: StatusOverride["status"] | null, reason: string | null = null) {
  const all = await getStatusOverrides();
  if (status) all[projectId] = { status, reason, at: nowIso() };
  else delete all[projectId];
  await setSetting("project_status", JSON.stringify(all));
}

interface ProjectRow {
  channel_id: string;
  name: string;
  hidden: number;
  state: ProjectState;
  found_reason: string | null;
  merged_into: string | null;
  local_repos: string;
  gh_repos: string;
  last_refreshed_at: string | null;
  snapshot: string | null;
  profile: string | null;
  repo_state: string | null;
  last_error: string | null;
}

export async function listProjectChannels(): Promise<ProjectChannel[]> {
  return (await db()).select<ProjectChannel[]>("SELECT channel_id, project_id, name, role, origin, reason FROM project_channels ORDER BY added_at");
}

export async function listProjects(): Promise<Project[]> {
  const d = await db();
  const [rows, channels, focus, statuses] = await Promise.all([
    d.select<ProjectRow[]>("SELECT * FROM projects ORDER BY name"),
    listProjectChannels(),
    listFocus(),
    getStatusOverrides(),
  ]);
  return rows.map((r) => ({
    ...r,
    hidden: r.hidden === 1,
    channels: channels.filter((c) => c.project_id === r.channel_id),
    local_repos: JSON.parse(r.local_repos),
    gh_repos: JSON.parse(r.gh_repos),
    snapshot: json<ProjectSnapshot>(r.snapshot),
    profile: json<ProjectProfile>(r.profile),
    repo_state: json<RepoState>(r.repo_state),
    focus: focus.get(r.channel_id) ?? null,
    status_override: statuses[r.channel_id] ?? null,
  }));
}

export async function getProject(channelId: string): Promise<Project | undefined> {
  return (await listProjects()).find((p) => p.channel_id === channelId);
}

/** Records what discovery found (see planDiscovery); never removes or moves anything. */
export async function applyDiscovery(plan: DiscoveryPlan) {
  const d = await db();
  for (const p of plan.newProjects)
    await d.execute(
      "INSERT OR IGNORE INTO projects (channel_id, name, hidden, state, found_reason) VALUES ($1, $2, $3, $4, $5)",
      [p.id, p.name, p.tracked ? 0 : 1, p.tracked ? "tracked" : "suggested", p.reason],
    );
  for (const l of plan.links)
    await d.execute(
      "INSERT OR IGNORE INTO project_channels (channel_id, project_id, name, role, origin, reason, added_at) VALUES ($1, $2, $3, $4, 'discovered', $5, $6)",
      [l.channel_id, l.project_id, l.name, l.role, l.reason, nowIso()],
    );
  for (const r of plan.renames) {
    await d.execute("UPDATE project_channels SET name = $1 WHERE channel_id = $2", [r.name, r.channel_id]);
    await d.execute("UPDATE projects SET name = $1 WHERE channel_id = $2", [r.name, r.channel_id]);
  }
}

/** Links a channel to a project. A user's link replaces whatever link the channel had. */
export async function linkChannel(projectId: string, c: { channel_id: string; name: string; reason?: string | null }, origin: "discovered" | "user") {
  const sql =
    origin === "user"
      ? "INSERT OR REPLACE INTO project_channels (channel_id, project_id, name, role, origin, reason, added_at) VALUES ($1, $2, $3, 'related', 'user', $4, $5)"
      : "INSERT OR IGNORE INTO project_channels (channel_id, project_id, name, role, origin, reason, added_at) VALUES ($1, $2, $3, 'related', 'discovered', $4, $5)";
  await (await db()).execute(sql, [c.channel_id, projectId, c.name, c.reason ?? null, nowIso()]);
}

/** Unlinks a related channel; it's remembered so discovery won't link it again. */
/** Unlinks one of a project's related channels. False if it isn't one (its main channel, or another project's). */
export async function unlinkChannel(channelId: string, projectId: string): Promise<boolean> {
  const { rowsAffected } = await (await db()).execute(
    "UPDATE project_channels SET role = 'excluded', origin = 'user' WHERE channel_id = $1 AND project_id = $2 AND role = 'related'",
    [channelId, projectId],
  );
  return rowsAffected > 0;
}

export async function setProjectState(id: string, state: "tracked" | "ignored") {
  await (await db()).execute("UPDATE projects SET state = $1, hidden = $2 WHERE channel_id = $3", [state, state === "tracked" ? 0 : 1, id]);
}

/**
 * Folds one project into another: its channels become the other's related channels, its own tasks
 * move over, and it leaves the board. The next refresh of the other project reads them all.
 */
export async function mergeProject(fromId: string, intoId: string) {
  const d = await db();
  // What's known about the merged-away project carries over, its name becoming another name for it.
  const [from, into] = await Promise.all([getProject(fromId), getProject(intoId)]);
  if (from && into) {
    await d.execute("UPDATE projects SET profile = $1 WHERE channel_id = $2", [JSON.stringify(foldProfile(into.profile, from.profile, projectName(from))), intoId]);
    await saveFocus(intoId, { aliases: [...new Set([...(into.focus?.aliases ?? []), projectName(from)])] });
  }
  await d.execute(
    "UPDATE project_channels SET project_id = $1, role = CASE role WHEN 'excluded' THEN 'excluded' ELSE 'related' END, origin = 'user' WHERE project_id = $2",
    [intoId, fromId],
  );
  await d.execute("UPDATE projects SET state = 'merged', merged_into = $1, hidden = 1 WHERE channel_id = $2", [intoId, fromId]);
  await d.execute("UPDATE manual_tasks SET project_id = $1 WHERE project_id = $2", [intoId, fromId]);
}

/** A project the user named (from the global chat): tracked, with its channels; the first is its main one. */
export async function createProject(name: string, channels: { channel_id: string; name: string }[], reason?: string | null) {
  const d = await db();
  const id = channels[0].channel_id;
  await d.execute(
    "INSERT INTO projects (channel_id, name, hidden, state, found_reason) VALUES ($1, $2, 0, 'tracked', $3) ON CONFLICT(channel_id) DO UPDATE SET name = excluded.name, hidden = 0, state = 'tracked', merged_into = NULL",
    [id, name, reason ?? null],
  );
  for (const [i, c] of channels.entries())
    await d.execute(
      "INSERT OR REPLACE INTO project_channels (channel_id, project_id, name, role, origin, reason, added_at) VALUES ($1, $2, $3, $4, 'user', $5, $6)",
      [c.channel_id, id, c.name.replace(/^#/, ""), i === 0 ? "primary" : "related", reason ?? null, nowIso()],
    );
  // The user named it, so that name holds through refreshes.
  await saveFocus(id, { pinned_name: name });
  return id;
}

/**
 * Splits channels off a project into a new one: the first moved channel becomes the new project's
 * id and main channel. Returns the new project's id.
 */
export async function splitProject(fromId: string, name: string, channelIds: string[], reason?: string | null) {
  const channels = (await listProjectChannels()).filter((c) => c.project_id === fromId);
  const moving = channelIds.map((id) => channels.find((c) => c.channel_id === id)).filter((c): c is ProjectChannel => !!c);
  if (!moving.length) throw new Error("None of those channels belong to that project");
  // The original project keeps its id, so if its main channel moves, the one left behind takes over.
  if (moving.some((c) => c.channel_id === fromId)) throw new Error("A project's main channel can't move; split the other channels off instead");
  return createProject(name, moving, reason);
}

/** The user's name for a project, which holds through refreshes (see projectName). */
export async function renameProject(id: string, name: string) {
  await saveFocus(id, { pinned_name: name });
}

/** Standing corrections from the user (via the global chat) that every job is told. */
export async function getNotes(): Promise<string[]> {
  return json<string[]>(await getSetting("user_notes")) ?? [];
}

export async function saveNotes(notes: string[]) {
  await setSetting("user_notes", JSON.stringify(notes));
}

export async function saveProjectSnapshot(channelId: string, snapshot: ProjectSnapshot, profile: ProjectProfile, refreshedAt: string) {
  await (await db()).execute(
    "UPDATE projects SET snapshot = $1, profile = $2, last_refreshed_at = $3, last_error = NULL WHERE channel_id = $4",
    [JSON.stringify(snapshot), JSON.stringify(profile), refreshedAt, channelId],
  );
}

export async function saveRepoState(channelId: string, state: RepoState) {
  await (await db()).execute("UPDATE projects SET repo_state = $1 WHERE channel_id = $2", [JSON.stringify(state), channelId]);
}

export async function saveProjectError(channelId: string, error: string | null) {
  await (await db()).execute("UPDATE projects SET last_error = $1 WHERE channel_id = $2", [error, channelId]);
}

/** Showing a project tracks it; hiding it keeps whatever it was (suggested, ignored). */
export async function updateProjectConfig(channelId: string, cfg: { hidden: boolean; local_repos: string[]; gh_repos: string[] }) {
  await (await db()).execute(
    `UPDATE projects SET hidden = $1, local_repos = $2, gh_repos = $3,
       state = CASE WHEN $1 = 0 THEN 'tracked' WHEN state = 'tracked' THEN 'ignored' ELSE state END
     WHERE channel_id = $4`,
    [cfg.hidden ? 1 : 0, JSON.stringify(cfg.local_repos), JSON.stringify(cfg.gh_repos), channelId],
  );
}

// ---- watched topics

type WatchedRow = { id: string; topic: string; details: string | null; project_id: string | null; outcomes: string; status: string | null; history: string | null; checked_at: string | null; created_at: string };
const parseJson = <T>(raw: string | null, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export async function listWatchedTopics(): Promise<WatchedTopic[]> {
  const rows = await (await db()).select<WatchedRow[]>("SELECT * FROM watched_topics ORDER BY created_at DESC");
  return rows.map((r) => {
    const status = parseJson<WatchedStatus | null>(r.status, null);
    const history = parseJson<WatchedUpdate[]>(r.history, []);
    return {
      id: r.id,
      topic: r.topic,
      details: r.details,
      projectId: r.project_id,
      outcomes: parseJson<WatchedOutcome[]>(r.outcomes, []),
      status,
      // A topic checked before updates were kept starts with its latest one.
      history: history.length || !status ? history : [{ ...status, at: r.checked_at ?? r.created_at }],
      checkedAt: r.checked_at,
      createdAt: r.created_at,
    };
  });
}

export async function addWatchedTopic(topic: string, details: string | null, outcomes: WatchedOutcome[], projectId: string | null = null): Promise<string> {
  const id = `watch:${crypto.randomUUID()}`;
  await (await db()).execute("INSERT INTO watched_topics (id, topic, details, outcomes, created_at, project_id) VALUES ($1, $2, $3, $4, $5, $6)", [
    id,
    topic,
    details,
    JSON.stringify(outcomes),
    nowIso(),
    projectId,
  ]);
  return id;
}

export async function getWatchedTopic(id: string): Promise<WatchedTopic | null> {
  return (await listWatchedTopics()).find((t) => t.id === id) ?? null;
}

/**
 * Changes only the fields given: Edit sends the title, details and project; a Discuss chat its
 * conditional actions. So a check that finishes while the form is open keeps what it found.
 */
export async function updateWatchedTopic(id: string, f: { topic?: string; details?: string | null; projectId?: string | null; outcomes?: WatchedOutcome[] }) {
  const sets: string[] = [];
  const values: unknown[] = [id];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (f.topic !== undefined) set("topic", f.topic);
  if (f.details !== undefined) set("details", f.details);
  if (f.projectId !== undefined) set("project_id", f.projectId);
  if (f.outcomes !== undefined) set("outcomes", JSON.stringify(f.outcomes));
  if (!sets.length) return;
  await (await db()).execute(`UPDATE watched_topics SET ${sets.join(", ")} WHERE id = $1`, values);
}

/** Saves a check's result: the topic's status, and what it found for each outcome it looked into. */
export async function saveWatchedCheck(id: string, status: WatchedStatus, found: { id: string; occurred: boolean; evidence?: string | null; link?: string | null }[]) {
  const topic = await getWatchedTopic(id);
  if (!topic) return;
  const outcomes = topic.outcomes.map((o) => {
    const f = found.find((x) => x.id === o.id);
    // Once seen, an event stays seen: a later check that misses it doesn't undo it.
    return f && !o.occurred ? { ...o, occurred: f.occurred, evidence: f.evidence ?? null, link: f.link ?? null } : o;
  });
  const at = nowIso();
  await (await db()).execute("UPDATE watched_topics SET status = $2, outcomes = $3, checked_at = $4, history = $5 WHERE id = $1", [
    id,
    JSON.stringify(status),
    JSON.stringify(outcomes),
    at,
    JSON.stringify(withUpdate(topic.history, { ...status, at })),
  ]);
}

/** Records the task made from an outcome. */
export async function setOutcomeTask(id: string, outcomeId: string, taskId: string) {
  const topic = await getWatchedTopic(id);
  if (!topic) return;
  const outcomes = topic.outcomes.map((o) => (o.id === outcomeId ? { ...o, taskId } : o));
  await (await db()).execute("UPDATE watched_topics SET outcomes = $2 WHERE id = $1", [id, JSON.stringify(outcomes)]);
}

/** Where the last list of conditional actions a topic's Discuss chat wrote is kept, so it's applied once. */
export const watchedActionsKey = (id: string) => `watch_actions_applied:${id}`;

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
  | "due_overrides"
  | "session_links"
  | "task_checks"
  | "blocker_checks"
  | "reminders"
  | "not_duplicates"
  | "project_tracking"
  | "epic_children"
  | "merged_from"
  | "seen"
  | "project_overrides";

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
  /** When its corrected description was applied to the task (corrections apply on their own, once). */
  appliedAt?: string;
}

/** Priorities the user set by hand, keyed by task id. */
export const getPriorityOverrides = () => getRows<Priority>("priority_overrides");

/**
 * Due dates you set by hand, by task id: a date, or null when you took a task's date off. They win
 * over the date a refresh found, which a refresh would otherwise write again.
 */
export const getDueOverrides = () => getRows<{ due: string | null }>("due_overrides");

/** Sets a task's due date by hand (YYYY-MM-DD), or with null says it has none. */
export const setDueOverride = (taskId: string, due: string | null) => putRow("due_overrides", taskId, { due });

/** What you've seen of each task, project and watched topic (see unread.ts), by its id. */
export const getSeen = () => getRows<string[]>("seen");

/** Records what's been seen of several items at once. */
export async function saveSeen(entries: [string, string[]][]) {
  for (const [id, facts] of entries) await putRow("seen", id, facts);
}

/** Projects you moved tasks to, by task id: a task found in one project's channels (or in Slack or email) that belongs to another. */
export const getProjectOverrides = () => getRows<string>("project_overrides");

/**
 * Files a task under another project. Your own tasks just change project; one from a project's
 * channels, Slack or email keeps where it was found and is shown under this project instead, or
 * with null under where it was found again.
 */
export async function setTaskProject(taskId: string, projectId: string | null) {
  const conn = await db();
  const mine = await conn.select<{ id: string }[]>("SELECT id FROM manual_tasks WHERE id = $1", [taskId]);
  if (mine.length) {
    await conn.execute("UPDATE manual_tasks SET project_id = $1 WHERE id = $2", [projectId, taskId]);
    return;
  }
  if (projectId) await putRow("project_overrides", taskId, projectId);
  else await deleteRow("project_overrides", taskId);
}

/** Sets a task's priority by hand, or with null goes back to the automatic one. */
export async function setPriorityOverride(taskId: string, priority: Priority | null) {
  if (priority) await putRow("priority_overrides", taskId, priority);
  else await deleteRow("priority_overrides", taskId);
}

/** Claude Code sessions Orb opened for tasks, keyed by task id. */
/** Each project's tracking feed (epics, PRs, branches), by project id. */
export const getProjectTracking = () => getRows<ProjectTracking>("project_tracking");
/** An epic's child issues as last read from Jira, by epic key. */
export type StoredEpicChildren = EpicChildren & { at: string };
export const getEpicChildren = () => getRows<StoredEpicChildren>("epic_children");
export const saveEpicChildren = (key: string, children: EpicChildren) => putRow("epic_children", key, { ...children, at: nowIso() });
export const saveProjectTracking = (projectId: string, tracking: ProjectTracking) => putRow("project_tracking", projectId, tracking);

export const getSessionLinks = () => getRows<SessionLink>("session_links");

export const saveSessionLink = (taskId: string, link: SessionLink) => putRow("session_links", taskId, link);

/** Changes part of a task's session link, keeping the rest as it is now (not as the caller last saw it). */
export async function updateSessionLink(taskId: string, patch: Partial<SessionLink>) {
  const current = (await getSessionLinks())[taskId];
  if (current) await saveSessionLink(taskId, { ...current, ...patch });
}

/** Double checks of tasks, keyed by task id. */
export const getTaskChecks = () => getRows<StoredTaskCheck>("task_checks");

export const clearTaskCheck = (taskId: string) => deleteRow("task_checks", taskId);

export const saveTaskCheck = (taskId: string, check: TaskCheck) => putRow("task_checks", taskId, { ...check, at: nowIso() });

/** Records that a check's correction was applied, so it never applies twice. */
export async function markCorrectionApplied(taskId: string) {
  const check = (await getTaskChecks())[taskId];
  if (check) await putRow("task_checks", taskId, { ...check, appliedAt: nowIso() });
}

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

/** A task folded into another, kept under the kept task's id so its card can say so and Separate can undo it. */
export interface MergedTask {
  id: string;
  title: string;
  at: string;
  /** You closed its note on the card; the merge stands. */
  hidden?: boolean;
}

/** What was merged into each task, by the kept task's id. */
export const getMergedFrom = () => getRows<MergedTask[]>("merged_from");

/**
 * Merges task `dropId` into `keepId` (both canonical ids): drop becomes another source of keep, so
 * it folds into keep's card everywhere. Keep's own data stands; anything it lacks that drop had (a
 * priority you set, a session, an edited or refined description, a plan, a Today slot) carries over,
 * copied rather than moved, so separating them again leaves drop as it was. `dropTitle` is kept with
 * the merge, for the card's "Merged in" note.
 */
export async function mergeTasks(keepId: string, dropId: string, dropTitle: string) {
  if (keepId === dropId) return;
  const conn = await db();
  await addTaskAlias(dropId, keepId, "merged");
  const merged = (await getMergedFrom())[keepId] ?? [];
  await putRow("merged_from", keepId, [...merged.filter((m) => m.id !== dropId), { id: dropId, title: dropTitle, at: nowIso() }]);
  await conn.execute(
    `INSERT OR IGNORE INTO task_data (store, task_id, value, updated_at)
     SELECT store, $1, value, $3 FROM task_data
     WHERE task_id = $2 AND store IN ('priority_overrides', 'due_overrides', 'session_links', 'description_overrides', 'refined_descriptions', 'project_overrides')`,
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

/**
 * Undoes a merge: `dropId` is its own task again (its data was copied into keep, not moved, so it's
 * all still there), and the pair is remembered as different work, so neither a refresh nor the
 * merge pass joins them again. Sources a refresh had folded into drop before the merge stay with keep.
 */
/** Hides a merge's note on the kept task's card, keeping the merge. */
export async function hideMergedNote(keepId: string, dropId: string) {
  const merged = (await getMergedFrom())[keepId] ?? [];
  await putRow("merged_from", keepId, merged.map((m) => (m.id === dropId ? { ...m, hidden: true } : m)));
}

export async function separateTasks(keepId: string, dropId: string) {
  await (await db()).execute("DELETE FROM task_sources WHERE ref = $1 AND task_id = $2", [dropId, keepId]);
  await markNotDuplicate(keepId, dropId);
  const rest = ((await getMergedFrom())[keepId] ?? []).filter((m) => m.id !== dropId);
  if (rest.length) await putRow("merged_from", keepId, rest);
  else await deleteRow("merged_from", keepId);
}

/** Pairs the user said aren't duplicates, as "a|b" with a < b. */
export const getNotDuplicates = async () => new Set(Object.keys(await getRows<true>("not_duplicates")));

export const notDuplicateKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export const markNotDuplicate = (a: string, b: string) => putRow("not_duplicates", notDuplicateKey(a, b), true);

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

/** Adds a task of the user's own; returns its id. */
export async function addManualTask(title: string, projectId: string | null = null, description: string | null = null): Promise<string> {
  const id = `manual:${crypto.randomUUID()}`;
  await (await db()).execute("INSERT INTO manual_tasks (id, title, project_id, created_at, description) VALUES ($1, $2, $3, $4, $5)", [
    id,
    title,
    projectId,
    nowIso(),
    description,
  ]);
  return id;
}

/** The user's own notes on tasks they added, as typed, by task id, kept when a short title replaced them. */
export async function getTaskBriefs(): Promise<Record<string, string>> {
  try {
    return JSON.parse((await getSetting("task_briefs")) ?? "{}");
  } catch {
    return {};
  }
}

/**
 * Gives a task added as a detailed note its short title, keeping what the user typed as its brief
 * (plans and sessions are given it word for word). Only if the title is still `original`, the one
 * the assessment read: an edit made meanwhile is the user's and stays. The first brief is kept, so
 * a later re-assessment can't replace the user's note with an earlier short title.
 */
export async function retitleManualTask(id: string, title: string, original: string) {
  const { rowsAffected } = await (await db()).execute("UPDATE manual_tasks SET title = $1 WHERE id = $2 AND title = $3", [title, id, original]);
  if (!rowsAffected) return;
  const briefs = await getTaskBriefs();
  if (briefs[id]) return;
  briefs[id] = original;
  await setSetting("task_briefs", JSON.stringify(briefs));
}

/** Gives a task of the user's own a description, only if it still has none. */
export async function describeManualTaskIfEmpty(id: string, description: string) {
  await (await db()).execute("UPDATE manual_tasks SET description = $1 WHERE id = $2 AND (description IS NULL OR trim(description) = '')", [description, id]);
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
  if (next.status === "done" && current.status !== "done") announceTaskDone();
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

// ---- feedback: the user's corrections, and the lessons distilled from them

export type FeedbackKind =
  | "description_edit"
  | "priority_change"
  | "dismiss"
  | "task_merge"
  | "not_duplicate"
  | "check_verdict"
  | "plan_change"
  | "message_edit"
  | "project_rename"
  | "project_split"
  | "project_merge"
  | "project_create"
  | "project_track"
  | "project_focus"
  | "channel_unlink"
  | "note";

export interface Feedback {
  id: number;
  at: string;
  kind: FeedbackKind;
  subject: "task" | "project" | "plan" | "message" | "briefing";
  subject_id: string | null;
  project_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  reason_source: "user" | "chat" | "inferred" | null;
  source: "ui" | "chat";
  distilled: boolean;
}

export type NewFeedback = Pick<Feedback, "kind" | "subject"> &
  Partial<Pick<Feedback, "before" | "after" | "reason" | "reason_source" | "source">> & { subject_id?: string | null; project_id?: string | null };

/** Records a correction; returns its id, for adding the reason later. */
export async function logFeedback(f: NewFeedback): Promise<number> {
  const res = await (await db()).execute(
    `INSERT INTO feedback (at, kind, subject, subject_id, project_id, before, after, reason, reason_source, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      nowIso(),
      f.kind,
      f.subject,
      f.subject_id ?? null,
      f.project_id ?? null,
      f.before === undefined ? null : JSON.stringify(f.before),
      f.after === undefined ? null : JSON.stringify(f.after),
      f.reason ?? null,
      f.reason ? (f.reason_source ?? "user") : null,
      f.source ?? "ui",
    ],
  );
  return res.lastInsertId ?? 0;
}

export async function setFeedbackReason(id: number, reason: string, source: "user" | "inferred") {
  await (await db()).execute("UPDATE feedback SET reason = $1, reason_source = $2 WHERE id = $3", [reason, source, id]);
}

interface FeedbackRow extends Omit<Feedback, "before" | "after" | "distilled"> {
  before: string | null;
  after: string | null;
  distilled: number;
}

/** Corrections, newest first: all of them, or those about one project or one subject. */
export async function listFeedback(filter: { projectId?: string; subjectId?: string; undistilled?: boolean; limit?: number } = {}): Promise<Feedback[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.projectId) where.push(`project_id = $${args.push(filter.projectId)}`);
  if (filter.subjectId) where.push(`subject_id = $${args.push(filter.subjectId)}`);
  if (filter.undistilled) where.push("distilled = 0");
  const rows = await (await db()).select<FeedbackRow[]>(
    `SELECT * FROM feedback ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${filter.limit ?? 200}`,
    args,
  );
  return rows.map((r) => ({ ...r, before: json(r.before), after: json(r.after), distilled: r.distilled === 1 }));
}

export async function markDistilled(ids: number[]) {
  if (!ids.length) return;
  await (await db()).execute(`UPDATE feedback SET distilled = 1 WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(", ")})`, ids);
}

export interface Lesson {
  id: number;
  scope: string;
  text: string;
  evidence: number[];
  origin: "learned" | "user";
  updated_at: string;
}

/** A lesson's text, for spotting the same lesson twice (case, spacing and end punctuation aside). */
const lessonKey = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/, "").trim();

export async function listLessons(): Promise<Lesson[]> {
  const rows = await (await db()).select<(Omit<Lesson, "evidence"> & { evidence: string })[]>("SELECT * FROM lessons ORDER BY scope, id");
  const lessons = rows.map((r) => ({ ...r, evidence: json<number[]>(r.evidence) ?? [] }));
  // A learned lesson that only repeats one the user wrote is left out: theirs is the one that counts.
  const yours = new Set(lessons.filter((l) => l.origin === "user").map((l) => lessonKey(l.text)));
  return lessons.filter((l) => l.origin === "user" || !yours.has(lessonKey(l.text)));
}

/** Replaces the learned lessons with a new set; the ones the user wrote or edited stay as they are. */
export async function replaceLearnedLessons(lessons: { scope: string; text: string; evidence: number[] }[]) {
  const d = await db();
  await d.execute("DELETE FROM lessons WHERE origin = 'learned'");
  // Never one that repeats a lesson the user wrote.
  const yours = new Set((await d.select<{ text: string }[]>("SELECT text FROM lessons WHERE origin = 'user'")).map((l) => lessonKey(l.text)));
  for (const l of lessons.filter((x) => !yours.has(lessonKey(x.text))))
    await d.execute("INSERT INTO lessons (scope, text, evidence, origin, updated_at) VALUES ($1, $2, $3, 'learned', $4)", [
      l.scope,
      l.text,
      JSON.stringify(l.evidence),
      nowIso(),
    ]);
}

/** A lesson the user stated (in a chat); it's theirs, so distilling never rewrites it. */
export async function addLesson(scope: string, text: string) {
  const d = await db();
  const have = await d.select<{ id: number }[]>("SELECT id FROM lessons WHERE scope = $1 AND lower(text) = lower($2)", [scope, text]);
  if (have.length) return;
  await d.execute("INSERT INTO lessons (scope, text, evidence, origin, updated_at) VALUES ($1, $2, '[]', 'user', $3)", [scope, text, nowIso()]);
}

/** The user's edit of a lesson; it's theirs from then on. */
export async function saveLesson(id: number, text: string) {
  await (await db()).execute("UPDATE lessons SET text = $1, origin = 'user', updated_at = $2 WHERE id = $3", [text, nowIso(), id]);
}

export async function deleteLesson(id: number) {
  await (await db()).execute("DELETE FROM lessons WHERE id = $1", [id]);
}

// ---- project focus: what a project is, as the user means it

export interface ProjectFocus {
  project_id: string;
  pinned_name: string | null;
  focus: string | null;
  in_scope: string | null;
  out_of_scope: string | null;
  aliases: string[];
  /** Context entries the user wrote or edited; refreshes keep to them. */
  context: string[];
  /** Entries Demian wrote that the user removed; refreshes leave them out. */
  removed: string[];
  /** When the user last changed any of it. */
  updated_at?: string;
}

export async function listFocus(): Promise<Map<string, ProjectFocus>> {
  const rows = await (await db()).select<(Omit<ProjectFocus, "aliases" | "context" | "removed"> & { aliases: string; context: string; removed: string })[]>(
    "SELECT * FROM project_focus",
  );
  return new Map(
    rows.map((r) => [r.project_id, { ...r, aliases: json<string[]>(r.aliases) ?? [], context: json<string[]>(r.context) ?? [], removed: json<string[]>(r.removed) ?? [] }]),
  );
}

/** Updates part of a project's focus, keeping the rest. */
export async function saveFocus(projectId: string, patch: Partial<Omit<ProjectFocus, "project_id">>) {
  const current = (await listFocus()).get(projectId);
  const next = { pinned_name: null, focus: null, in_scope: null, out_of_scope: null, aliases: [], context: [], removed: [], ...current, ...patch };
  await (await db()).execute(
    `INSERT INTO project_focus (project_id, pinned_name, focus, in_scope, out_of_scope, aliases, context, removed, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(project_id) DO UPDATE SET pinned_name = excluded.pinned_name, focus = excluded.focus, in_scope = excluded.in_scope,
       out_of_scope = excluded.out_of_scope, aliases = excluded.aliases, context = excluded.context, removed = excluded.removed, updated_at = excluded.updated_at`,
    [projectId, next.pinned_name, next.focus, next.in_scope, next.out_of_scope, JSON.stringify(next.aliases), JSON.stringify(next.context), JSON.stringify(next.removed), nowIso()],
  );
}

/** Keeps the profile a refresh is about to replace, the last ten per project. */
export async function archiveProfile(projectId: string, profile: ProjectProfile) {
  const d = await db();
  await d.execute("INSERT INTO project_profile_history (project_id, profile, at) VALUES ($1, $2, $3)", [projectId, JSON.stringify(profile), nowIso()]);
  await d.execute(
    "DELETE FROM project_profile_history WHERE project_id = $1 AND id NOT IN (SELECT id FROM project_profile_history WHERE project_id = $1 ORDER BY id DESC LIMIT 10)",
    [projectId],
  );
}
