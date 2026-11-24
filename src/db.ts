import { withUpdate, type WatchedOutcome, type WatchedStatus, type WatchedTopic, type WatchedUpdate } from "./watched";
import type { SessionLink } from "./sessions";
import type { SessionScanDecision } from "./sessionScan";
import Database from "@tauri-apps/plugin-sql";
import type { AdhocTask, EpicChildren, BlockerCheck, CalendarDay, TaskCheck, ManualAssessment, Priority, NewsItem, PathToShip, ProfilePerson, ProjectKind, ProjectPriority, ProjectProfile, ProjectSnapshot, QuickReply, Requirement, RequirementProgress, RequirementsRead, TaskPlan } from "./schema";
import { withMovedUpdates } from "./inboxMoves";
import { avatarIndex, foldProfile, newProjectId, projectName, recordedPeople, withRequirementsRead, type DiscoveryPlan, type ProjectChannel, type ProjectEpicLink, type SharedChannel } from "./projects";
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
  /**
   * The project's id, which only identifies it: Demian's own "p:<id>" (see newProjectId), or for a
   * project from before, the channel it was first found in or "jira:<key>". Never a channel to read:
   * its channels can move, so reach them with primaryChannel and readChannels.
   */
  channel_id: string;
  /** Its first name: that channel's, or its epic's title. */
  name: string;
  /** Off the board: anything but tracked. */
  hidden: boolean;
  state: ProjectState;
  /** Why discovery thinks this is a project, for suggestions. */
  found_reason: string | null;
  merged_into: string | null;
  /** Every channel linked to the project, unlinked ones included (role "excluded"). */
  channels: ProjectChannel[];
  /** Every Jira epic linked to the project, unlinked ones included (excluded). */
  epics: ProjectEpicLink[];
  /** Channels other projects own that this one reads too (see SharedChannel). */
  shared_channels: SharedChannel[];
  /** A ship date the user set, overriding the one refreshes read (see shipTarget). */
  ship_choice: ShipChoice | null;
  /** A TDD Demian drafted for it, waiting for the user to review and create it (see draftProjectTdd). */
  doc_draft?: DocDraft | null;
  local_repos: string[];
  gh_repos: string[];
  last_refreshed_at: string | null;
  snapshot: ProjectSnapshot | null;
  profile: ProjectProfile | null;
  last_error: string | null;
  /** What the project is, as the user means it (see ProjectFocus); null until they say. */
  focus: ProjectFocus | null;
  /** A status the user set (through the Demian chat), when, and why; see projectStatus. */
  status_override: StatusOverride | null;
  /** Project or workstream, as the user set it; null leaves it to refreshes (see projectKind). */
  kind_choice: KindChoice | null;
  /** A priority the user set by hand, overriding the refreshes' until they pick Automatic (see projectPriority). */
  priority_choice?: PriorityChoice | null;
  /**
   * Faces from the people record, by name as matched (see personName): everyone known on any
   * project, so someone this project hasn't read yet still shows with theirs. The same for every project.
   */
  avatars?: Record<string, string>;
  /** Its guiding doc as the user linked it, and the suggestions they turned down. */
  docs: ProjectDocs | null;
  /** The guiding doc's requirements and how far along each is. */
  requirements: StoredRequirements | null;
}

export interface ShipChoice {
  /** YYYY-MM-DD. */
  date: string;
  at: string;
}

export interface KindChoice {
  kind: ProjectKind;
  at: string;
}

export interface PriorityChoice {
  level: ProjectPriority;
  at: string;
}

/** The document that sets out a project's requirements, as the user linked or confirmed it. */
export interface LinkedDoc {
  link: string;
  title: string;
  /** "TDD", "PRD", "spec" or "other", when known. */
  kind: string | null;
  at: string;
}

/** A project's requirements doc: one the user linked or had Demian draft and create, never one it picked. */
export interface ProjectDocs {
  doc: LinkedDoc | null;
}

export type StoredProgress = RequirementProgress & { at: string };

/** A guiding doc's requirements as last read, and their progress as the refreshes found it. */
export interface StoredRequirements {
  /** The doc they were read from; a different doc linked since means they're stale. */
  link: string;
  title: string | null;
  kind: string | null;
  /** When it was last read (or found unchanged). */
  readAt: string | null;
  /** When it was last tried, and why that failed, if it did. */
  triedAt: string | null;
  error: string | null;
  /** When the doc itself was last edited, as its file says. */
  docUpdated: string | null;
  /** Why the doc couldn't be read, when it couldn't. */
  unreadable: string | null;
  requirements: Requirement[];
  /** By requirement id; ids no longer in requirements are left out when shown. */
  progress: Record<string, StoredProgress>;
  progressAt: string | null;
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
  last_error: string | null;
}

export async function listProjectChannels(): Promise<ProjectChannel[]> {
  return (await db()).select<ProjectChannel[]>("SELECT channel_id, project_id, name, role, origin, reason FROM project_channels ORDER BY added_at");
}

export async function listProjects(): Promise<Project[]> {
  const d = await db();
  const [rows, channels, focus, statuses, kinds, priorities, docs, requirements, epics, ships, shared, drafts, people] = await Promise.all([
    d.select<ProjectRow[]>("SELECT * FROM projects ORDER BY name"),
    listProjectChannels(),
    listFocus(),
    getStatusOverrides(),
    getRows<KindChoice>("project_kind"),
    getRows<PriorityChoice>("project_priority"),
    getRows<ProjectDocs>("project_docs"),
    getRows<StoredRequirements>("project_requirements"),
    listProjectEpics(),
    getRows<ShipChoice>("project_ship"),
    getRows<SharedChannel[]>("project_shared_channels"),
    getRows<DocDraft>("project_doc_draft"),
    getRows<PersonRecord>("people"),
  ]);
  const avatars = avatarIndex(Object.values(people));
  return rows.map((r) => ({
    ...r,
    hidden: r.hidden === 1,
    channels: channels.filter((c) => c.project_id === r.channel_id),
    epics: epics.filter((e) => e.project_id === r.channel_id),
    shared_channels: shared[r.channel_id] ?? [],
    ship_choice: ships[r.channel_id] ?? null,
    doc_draft: drafts[r.channel_id] ?? null,
    local_repos: JSON.parse(r.local_repos),
    gh_repos: JSON.parse(r.gh_repos),
    snapshot: json<ProjectSnapshot>(r.snapshot),
    profile: json<ProjectProfile>(r.profile),
    focus: focus.get(r.channel_id) ?? null,
    status_override: statuses[r.channel_id] ?? null,
    kind_choice: kinds[r.channel_id] ?? null,
    priority_choice: priorities[r.channel_id] ?? null,
    docs: docs[r.channel_id] ?? null,
    requirements: requirements[r.channel_id] ?? null,
    avatars,
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
  for (const e of plan.epicLinks) await linkEpic(e.project_id, { key: e.epic_key, title: e.title }, "discovered");
}

// ---- a project's Jira epics: one row per epic in task_data, keyed by its key

export async function listProjectEpics(): Promise<ProjectEpicLink[]> {
  const rows = await getRows<Omit<ProjectEpicLink, "epic_key">>("project_epics");
  return Object.entries(rows)
    .map(([epic_key, e]) => ({ ...e, epic_key }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Links an epic to a project. A user's link replaces whatever link the epic had; a discovered one
 * never replaces an existing link (or an unlinking), only fills in a newer title for it.
 */
export async function linkEpic(projectId: string, epic: { key: string; title?: string | null; link?: string | null }, origin: "discovered" | "user") {
  const key = epic.key.trim().toUpperCase();
  const prev = (await getRows<Omit<ProjectEpicLink, "epic_key">>("project_epics"))[key];
  const title = epic.title?.trim() || prev?.title || key;
  const link = epic.link?.trim() || prev?.link || null;
  if (origin === "discovered" && prev) {
    if (prev.project_id === projectId && !prev.excluded && (title !== prev.title || link !== (prev.link ?? null))) await putRow("project_epics", key, { ...prev, title, link });
    return;
  }
  await putRow("project_epics", key, { project_id: projectId, title, link, origin, excluded: false, at: nowIso() } satisfies Omit<ProjectEpicLink, "epic_key">);
}

/** Unlinks an epic from a project; remembered, so refreshes and discovery don't link it again. False if it isn't linked there. */
export async function unlinkEpic(projectId: string, key: string): Promise<boolean> {
  const k = key.trim().toUpperCase();
  const prev = (await getRows<Omit<ProjectEpicLink, "epic_key">>("project_epics"))[k];
  if (!prev || prev.project_id !== projectId || prev.excluded) return false;
  await putRow("project_epics", k, { ...prev, origin: "user", excluded: true, at: nowIso() });
  return true;
}

/** Sets the ship date the user knows (YYYY-MM-DD), or with null goes back to the one refreshes read. */
export async function setShipChoice(projectId: string, date: string | null) {
  if (date) await putRow("project_ship", projectId, { date, at: nowIso() } satisfies ShipChoice);
  else await deleteRow("project_ship", projectId);
}

/** A requirements doc Demian drafted for a project, in Markdown, with what it drew on. */
export interface DocDraft {
  at: string;
  title: string;
  markdown: string;
  sources: { title: string; link: string }[];
  /** When its chat (or the user, by hand) last changed it after it was drafted. */
  updated?: string | null;
}

export async function saveDocDraft(projectId: string, draft: DocDraft) {
  await putRow("project_doc_draft", projectId, draft);
}

export async function deleteDocDraft(projectId: string) {
  await deleteRow("project_doc_draft", projectId);
}

/** Links a channel to a project. A user's link replaces whatever link the channel had. */
export async function linkChannel(projectId: string, c: { channel_id: string; name: string; reason?: string | null }, origin: "discovered" | "user") {
  const before = (await listProjectChannels()).find((x) => x.channel_id === c.channel_id);
  const sql =
    origin === "user"
      ? "INSERT OR REPLACE INTO project_channels (channel_id, project_id, name, role, origin, reason, added_at) VALUES ($1, $2, $3, 'related', 'user', $4, $5)"
      : "INSERT OR IGNORE INTO project_channels (channel_id, project_id, name, role, origin, reason, added_at) VALUES ($1, $2, $3, 'related', 'discovered', $4, $5)";
  await (await db()).execute(sql, [c.channel_id, projectId, c.name, c.reason ?? null, nowIso()]);
  // Taken from another project: that one picks a new main channel; this one has one.
  if (origin === "user" && before && before.project_id !== projectId) await ensurePrimary(before.project_id);
  await ensurePrimary(projectId);
}

/**
 * Keeps a project's main channel (where reminders go) among its own: when its main one moved away or
 * was unlinked, the longest-linked of the rest takes over. A project with no channels has none.
 */
export async function ensurePrimary(projectId: string) {
  const own = (await listProjectChannels()).filter((c) => c.project_id === projectId && c.role !== "excluded");
  if (!own.length || own.some((c) => c.role === "primary")) return;
  await (await db()).execute("UPDATE project_channels SET role = 'primary' WHERE channel_id = $1 AND project_id = $2", [own[0].channel_id, projectId]);
}

/**
 * Unlinks one of a project's channels, its main one included (another takes over, if it has one);
 * remembered, so discovery won't link it again. False if it isn't one of the project's.
 */
export async function unlinkChannel(channelId: string, projectId: string): Promise<boolean> {
  const { rowsAffected } = await (await db()).execute(
    "UPDATE project_channels SET role = 'excluded', origin = 'user' WHERE channel_id = $1 AND project_id = $2 AND role IN ('related', 'primary')",
    [channelId, projectId],
  );
  if (rowsAffected > 0) await ensurePrimary(projectId);
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
  // The channels it shared, the other project now shares (unless it owns them).
  const shared = (await getRows<SharedChannel[]>("project_shared_channels"))[fromId] ?? [];
  const intoOwns = new Set((await listProjectChannels()).filter((c) => c.project_id === intoId).map((c) => c.channel_id));
  for (const c of shared) if (!intoOwns.has(c.channel_id)) await shareChannel(intoId, c);
  if (shared.length) await deleteRow("project_shared_channels", fromId);
  // Its epics join the other project too.
  for (const e of await listProjectEpics())
    if (e.project_id === fromId) await putRow("project_epics", e.epic_key, { project_id: intoId, title: e.title, origin: "user", excluded: e.excluded, at: e.at });
  await d.execute("UPDATE projects SET state = 'merged', merged_into = $1, hidden = 1 WHERE channel_id = $2", [intoId, fromId]);
  await d.execute("UPDATE manual_tasks SET project_id = $1 WHERE project_id = $2", [intoId, fromId]);
}

/**
 * A project the user named (from the global chat): tracked, with its channels (the first its main
 * one) and its epics; either can be empty.
 */
export async function createProject(name: string, channels: { channel_id: string; name: string }[], reason?: string | null, epics: string[] = []) {
  const d = await db();
  const id = newProjectId();
  // Projects whose channels this one takes: each picks a new main channel after.
  const owners = new Set((await listProjectChannels()).filter((c) => channels.some((x) => x.channel_id === c.channel_id)).map((c) => c.project_id));
  await d.execute(
    "INSERT INTO projects (channel_id, name, hidden, state, found_reason) VALUES ($1, $2, 0, 'tracked', $3) ON CONFLICT(channel_id) DO UPDATE SET name = excluded.name, hidden = 0, state = 'tracked', merged_into = NULL",
    [id, name, reason ?? null],
  );
  for (const [i, c] of channels.entries())
    await d.execute(
      "INSERT OR REPLACE INTO project_channels (channel_id, project_id, name, role, origin, reason, added_at) VALUES ($1, $2, $3, $4, 'user', $5, $6)",
      [c.channel_id, id, c.name.replace(/^#/, ""), i === 0 ? "primary" : "related", reason ?? null, nowIso()],
    );
  for (const owner of owners) await ensurePrimary(owner);
  for (const key of epics) await linkEpic(id, { key }, "user");
  // The user named it, so that name holds through refreshes.
  await saveFocus(id, { pinned_name: name });
  return id;
}

/**
 * Splits part of a project off into a new one: channels and epics that move to it (any of them, its
 * main channel too), and channels both keep reading, as when two projects grew up in one channel.
 * Each project's record notes the split, so refreshes keep them apart. Returns the new project's id.
 */
export async function splitProject(
  fromId: string,
  name: string,
  channelIds: string[],
  reason?: string | null,
  epicKeys: string[] = [],
  sharedChannelIds: string[] = [],
) {
  const [channels, epics, from] = await Promise.all([listProjectChannels(), listProjectEpics(), getProject(fromId)]);
  const own = channels.filter((c) => c.project_id === fromId && c.role !== "excluded");
  const moving = channelIds.map((id) => own.find((c) => c.channel_id === id)).filter((c): c is ProjectChannel => !!c);
  if (channelIds.length && moving.length < channelIds.length) throw new Error("Some of those channels aren't that project's");

  const keys = [...new Set(epicKeys.map((k) => k.trim().toUpperCase()))];
  const missing = keys.filter((k) => !epics.some((e) => e.epic_key === k && e.project_id === fromId && !e.excluded));
  if (missing.length) throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} linked to that project`);
  // Channels it reads, its own or ones it already shares, that both projects will read.
  const readable = [...own, ...(from?.shared_channels ?? [])];
  const sharing = sharedChannelIds
    .filter((id) => !moving.some((c) => c.channel_id === id))
    .map((id) => readable.find((c) => c.channel_id === id))
    .filter((c): c is { channel_id: string; name: string } => !!c);
  if (sharedChannelIds.length && sharing.length < sharedChannelIds.filter((id) => !moving.some((c) => c.channel_id === id)).length)
    throw new Error("Some of the channels to share aren't that project's");
  if (!moving.length && !keys.length && !sharing.length) throw new Error("Nothing to split off: name channels or epics to move, or a channel to share");
  const id = await createProject(name, moving, reason, keys);
  for (const c of sharing) await shareChannel(id, c);
  // Each record says what the split was, in the user's context entries, which refreshes keep to.
  const fromName = from ? projectName(from) : "the other project";
  await saveFocus(id, { context: [`Split off from "${fromName}"${reason?.trim() ? `: ${reason.trim().replace(/\.$/, "")}` : ""}.`] });
  if (from) await saveFocus(fromId, { context: [...(from.focus?.context ?? []), `Not part of it: ${name}, split off into its own project.`] });
  return id;
}

/** Has a project read a channel another project owns, too. */
export async function shareChannel(projectId: string, channel: { channel_id: string; name: string }) {
  const all = await getRows<SharedChannel[]>("project_shared_channels");
  const list = all[projectId] ?? [];
  if (list.some((c) => c.channel_id === channel.channel_id)) return;
  await putRow("project_shared_channels", projectId, [...list, { channel_id: channel.channel_id, name: channel.name.replace(/^#/, "") }]);
}

/** Stops a project reading a channel it shared. False if it wasn't sharing it. */
export async function unshareChannel(projectId: string, channelId: string): Promise<boolean> {
  const list = (await getRows<SharedChannel[]>("project_shared_channels"))[projectId] ?? [];
  const next = list.filter((c) => c.channel_id !== channelId);
  if (next.length === list.length) return false;
  if (next.length) await putRow("project_shared_channels", projectId, next);
  else await deleteRow("project_shared_channels", projectId);
  return true;
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

/**
 * The dependencies between tickets the old map of a project found (before the plan kept its own, see
 * PathItem.waits_on), to show and carry over until a refresh has read them into the plan.
 */
export async function oldMapDependencies(projectId: string): Promise<{ from: string; to: string; source: "jira" | "assumed"; reason: string | null }[]> {
  const stored = (await getRows<{ map?: { links?: { from: string; to: string; source?: string; reason?: string | null }[] } }>("project_map"))[projectId];
  const key = /^[A-Z][A-Z0-9_]+-\d+$/;
  return (stored?.map?.links ?? [])
    .filter((l) => key.test(l.from) && key.test(l.to))
    .map((l) => ({ from: l.from, to: l.to, source: l.source === "jira" ? ("jira" as const) : ("assumed" as const), reason: l.reason ?? null }));
}

// ---- the people record: one row per person, keyed by their Slack id (or name), across projects

/**
 * Someone Demian has seen on the user's projects: their face, and their part in each project they're
 * on (role, how central, what they're doing on it now), kept up to date by each project's refresh.
 */
export interface PersonRecord {
  name: string;
  slack_user_id: string | null;
  avatar: string | null;
  /** Their part in each project they're on, by project id. */
  projects: Record<string, PersonInvolvement>;
  /** When anything about them last changed. */
  at: string;
}

export interface PersonInvolvement {
  role: string;
  importance: number;
  working_on: string;
  at: string;
}

export async function listPeople(): Promise<PersonRecord[]> {
  return Object.values(await getRows<PersonRecord>("people"));
}

/** Records who's on a project after its refresh (see recordedPeople). */
export async function recordPeople(projectId: string, people: ProfilePerson[], at: string) {
  const { put, remove } = recordedPeople(await getRows<PersonRecord>("people"), projectId, people, at);
  for (const [key, record] of put) await putRow("people", key, record);
  for (const key of remove) await deleteRow("people", key);
}

/** Changes the project's path as it's stored, without a refresh: after Demian applied a plan change in Jira. */
export async function updatePath(projectId: string, change: (path: PathToShip) => PathToShip) {
  const project = await getProject(projectId);
  const path = project?.snapshot?.path;
  if (!project?.snapshot || !path) return;
  const snapshot = { ...project.snapshot, path: change(path) };
  await (await db()).execute("UPDATE projects SET snapshot = $1 WHERE channel_id = $2", [JSON.stringify(snapshot), projectId]);
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

/** The Slack and email refresh's tasks, inbox and news, as it last wrote them. */
export async function getStoredAdhoc(): Promise<AdhocStore> {
  const stored = json<Partial<AdhocStore>>(await getSetting("adhoc"));
  return { tasks: [], replies: [], news: [], refreshed_at: null, ...stored };
}

/** The Slack and email refresh's tasks, inbox and news, with the updates you moved to the inbox in it. */
export async function getAdhoc(): Promise<AdhocStore> {
  const [adhoc, moved] = await Promise.all([getStoredAdhoc(), getRows<QuickReply>("inbox_moves")]);
  return { ...adhoc, replies: withMovedUpdates(adhoc.replies, Object.values(moved)) };
}

/** Puts an update in the inbox (see inboxMoves.ts), kept apart from what the refresh writes there. */
export const moveToInbox = (item: QuickReply) => putRow("inbox_moves", item.id, item);

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
  | "inbox_moves"
  | "project_overrides"
  | "session_scan"
  | "project_kind"
  | "project_priority"
  | "project_docs"
  | "project_requirements"
  | "project_epics"
  | "project_ship"
  | "project_shared_channels"
  | "project_map"
  | "project_doc_draft"
  | "people";

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

// ---- projects and workstreams, guiding docs and their requirements

/** Sets a project's kind as the user sees it, or with null hands it back to refreshes. */
export async function setProjectKind(projectId: string, kind: ProjectKind | null) {
  if (kind) await putRow("project_kind", projectId, { kind, at: nowIso() } satisfies KindChoice);
  else await deleteRow("project_kind", projectId);
}

/** Sets a project's priority by hand, or with null hands it back to refreshes. */
export async function setProjectPriority(projectId: string, level: ProjectPriority | null) {
  if (level) await putRow("project_priority", projectId, { level, at: nowIso() } satisfies PriorityChoice);
  else await deleteRow("project_priority", projectId);
}

async function getProjectDocs(projectId: string): Promise<ProjectDocs> {
  return (await getRows<ProjectDocs>("project_docs"))[projectId] ?? { doc: null };
}

/** Links a project's guiding doc, or with null removes it. */
export async function setProjectDoc(projectId: string, doc: { link: string; title: string; kind?: string | null } | null) {
  const docs = await getProjectDocs(projectId);
  await putRow("project_docs", projectId, {
    ...docs,
    doc: doc ? { link: doc.link, title: doc.title, kind: doc.kind ?? null, at: nowIso() } : null,
  } satisfies ProjectDocs);
}

async function getStoredRequirements(projectId: string): Promise<StoredRequirements | null> {
  return (await getRows<StoredRequirements>("project_requirements"))[projectId] ?? null;
}

/**
 * Records a read of a project's guiding doc: new requirements (the progress of ones still there is
 * kept), or just when it was checked when the doc hasn't changed. Another doc starts afresh.
 */
export async function saveRequirementsRead(projectId: string, doc: { link: string; title: string; kind?: string | null }, read: RequirementsRead) {
  await putRow("project_requirements", projectId, withRequirementsRead(await getStoredRequirements(projectId), doc, read, nowIso()));
}

/** Records that reading a project's guiding doc failed, keeping what was read before. */
export async function saveRequirementsError(projectId: string, doc: { link: string; title: string; kind?: string | null }, error: string) {
  const prev = await getStoredRequirements(projectId);
  const base: StoredRequirements =
    prev?.link === doc.link
      ? prev
      : { link: doc.link, title: doc.title, kind: doc.kind ?? null, readAt: null, triedAt: null, error: null, docUpdated: null, unreadable: null, requirements: [], progress: {}, progressAt: null };
  await putRow("project_requirements", projectId, { ...base, error, triedAt: nowIso() } satisfies StoredRequirements);
}

/** Records a refresh's progress on the requirements of the doc it was given. */
export async function saveRequirementsProgress(projectId: string, link: string, progress: RequirementProgress[]) {
  const prev = await getStoredRequirements(projectId);
  if (!prev || prev.link !== link || !progress.length) return;
  const at = nowIso();
  const ids = new Set(prev.requirements.map((r) => r.id));
  const next = { ...prev.progress };
  for (const p of progress) if (ids.has(p.id)) next[p.id] = { ...p, at };
  await putRow("project_requirements", projectId, { ...prev, progress: next, progressAt: at } satisfies StoredRequirements);
}

export const getSessionLinks = () => getRows<SessionLink>("session_links");

export const saveSessionLink = (taskId: string, link: SessionLink) => putRow("session_links", taskId, link);

/** Stops a task following its session (the session itself is left as it is). */
export const deleteSessionLink = (taskId: string) => deleteRow("session_links", taskId);

/** What the session scan decided for each Claude Code session it looked at, by session id (see sessionScan.ts). */
export const getSessionScan = () => getRows<SessionScanDecision>("session_scan");

export const saveSessionScanDecision = (sessionId: string, d: SessionScanDecision) => putRow("session_scan", sessionId, d);

/** Changes part of a task's session link, keeping the rest as it is now (not as the caller last saw it). */
/**
 * Changes a chat's link. Changes run one at a time, each on the link as the last one left it, so two
 * at once (a turn ending, a click on a card) can't drop either's. `patch` may be worked out from the
 * link as it is then, for a change that adds to what's there.
 */
let linkUpdates: Promise<unknown> = Promise.resolve();
export function updateSessionLink(taskId: string, patch: Partial<SessionLink> | ((current: SessionLink) => Partial<SessionLink>)): Promise<void> {
  const run = linkUpdates.then(async () => {
    const current = (await getSessionLinks())[taskId];
    if (current) await saveSessionLink(taskId, { ...current, ...(typeof patch === "function" ? patch(current) : patch) });
  });
  linkUpdates = run.catch(() => {});
  return run;
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

/** The calendars saved for these days, as last refreshed, oldest first (days never fetched are left out). */
export async function getCalendarDays(dates: string[]): Promise<CalendarDay[]> {
  if (!dates.length) return [];
  const params = dates.map((_, i) => "$" + (i + 1)).join(", ");
  const rows = await (await db()).select<{ data: string }[]>(`SELECT data FROM calendar_days WHERE date IN (${params}) ORDER BY date`, dates);
  return rows.map((r) => JSON.parse(r.data) as CalendarDay);
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
  const rows = await (await db()).select<{ task_id: string; status: TaskStatus | null; done: number; dismissed: number; today_on: string | null; updated_at: string | null }[]>(
    "SELECT * FROM task_state",
  );
  return new Map(
    rows.map((r) => {
      const status = r.status ?? (r.done === 1 ? "done" : "todo");
      return [r.task_id, { status, dismissed: r.dismissed === 1, todayOn: r.today_on, done: status === "done", doneAt: status === "done" ? r.updated_at : null }];
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

/**
 * When each job last finished without an error, by its name in the log ("calendar", "adhoc", "watch"
 * …), plus "all" for the last full refresh. What Refresh's menu shows beside each line.
 */
export async function lastUpdated(): Promise<Record<string, string>> {
  const rows = await (await db()).select<{ job: string; at: string }[]>(
    "SELECT job, MAX(finished_at) AS at FROM refresh_log WHERE status = 'ok' AND finished_at IS NOT NULL GROUP BY job",
  );
  const times: Record<string, string> = Object.fromEntries(rows.map((r) => [r.job, r.at]));
  const all = await getSetting("last_full_refresh_at");
  if (all) times.all = all;
  return times;
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
  | "session_unlink"
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
