import type { PersonRecord, Project, StoredProgress, StoredRequirements } from "./db";
import type { Discovery, PathStep, PathToShip, ProfilePerson, ProjectKind, ProjectPriority, ProjectProfile, ProjectSnapshot, RelatedChannel, Requirement, RequirementsRead, RequirementStatus } from "./schema";

/** A Slack channel's link to a project. */
export interface ProjectChannel {
  channel_id: string;
  project_id: string;
  name: string;
  /** "excluded": the user unlinked it, so discovery and refreshes leave it alone. */
  role: "primary" | "related" | "excluded";
  /** Links the user made are never changed by discovery. */
  origin: "discovered" | "user";
  reason: string | null;
}

/** A Jira epic's link to a project; an epic belongs to one project. */
export interface ProjectEpicLink {
  epic_key: string;
  project_id: string;
  /** The epic's summary, as it was when linked or last seen. */
  title: string;
  /** Its page in Jira, once a refresh has seen it. */
  link?: string | null;
  /** Links the user made are never changed by discovery or refreshes. */
  origin: "discovered" | "user";
  /** The user unlinked it, so discovery and refreshes leave it alone. */
  excluded: boolean;
  at: string;
}

/**
 * A new project's id, Demian's own: "p:3f9a1c2e". A project is Demian's record of a body of work;
 * its channels and epics are sources it reads, which can move, be shared or be unlinked, so its id
 * never comes from one. (Projects from before were keyed by their first channel, or "jira:<key>";
 * those ids stay, and mean nothing more than this one.)
 */
export function newProjectId(fresh: () => string = () => crypto.randomUUID()): string {
  return `p:${fresh().replace(/-/g, "").slice(0, 12)}`;
}

/** An epic key from what someone typed or pasted: "pay-123", a /browse/PAY-123 link, or a board link with selectedIssue=PAY-123. */
export function epicKeyFrom(text: string): string | null {
  const t = text.trim();
  const fromLink = t.match(/[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]+-\d+)/) ?? t.match(/\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)/);
  if (fromLink) return fromLink[1].toUpperCase();
  const bare = t.match(/^([A-Za-z][A-Za-z0-9_]+-\d+)$/);
  return bare ? bare[1].toUpperCase() : null;
}

/**
 * A channel another project owns that this one reads too: one channel for two projects, as when a
 * project is split but its channel can't be (see splitProject).
 */
export interface SharedChannel {
  channel_id: string;
  name: string;
}

/** #tmp- channels are project channels by convention, so their projects go straight on the board. */
export const isTmpChannel = (name: string) => name.startsWith("tmp-");

export interface DiscoveryPlan {
  newProjects: { id: string; name: string; tracked: boolean; reason: string }[];
  links: { channel_id: string; project_id: string; name: string; role: "primary" | "related"; reason: string }[];
  renames: { channel_id: string; name: string }[];
  /** Epics to link to projects, as discovery found them. */
  epicLinks: { epic_key: string; project_id: string; title: string }[];
}

/**
 * Turns what discovery found into changes, leaving what's already known in place: a channel or epic
 * already linked to a project stays with it, ones the user unlinked are skipped, and new ones join
 * the project they were found with (an existing one when any of its channels or epics is known).
 * A new project is keyed by its primary channel, or by its first epic when it has no channel; it's
 * tracked when it has a #tmp- channel, otherwise it's a suggestion for the user to accept or ignore.
 */
type FoundGroup = Discovery["projects"][number];

export function planDiscovery(
  found: (Omit<FoundGroup, "channels" | "epics"> & { channels?: FoundGroup["channels"]; epics?: FoundGroup["epics"] })[],
  known: ProjectChannel[],
  projectIds: Set<string>,
  knownEpics: ProjectEpicLink[] = [],
  newId: () => string = () => crypto.randomUUID(),
): DiscoveryPlan {
  const byChannel = new Map(known.map((c) => [c.channel_id, c]));
  const byEpic = new Map(knownEpics.map((e) => [e.epic_key.toUpperCase(), e]));
  const plan: DiscoveryPlan = { newProjects: [], links: [], renames: [], epicLinks: [] };
  const linked = new Set<string>();
  const linkedEpics = new Set<string>();
  for (const group of found) {
    const groupChannels = group.channels ?? [];
    for (const c of groupChannels) {
      const k = byChannel.get(c.channel_id);
      if (k && k.name !== c.name && !plan.renames.some((r) => r.channel_id === c.channel_id))
        plan.renames.push({ channel_id: c.channel_id, name: c.name });
    }
    const channels = groupChannels.filter((c) => byChannel.get(c.channel_id)?.role !== "excluded");
    const epics = (group.epics ?? []).map((e) => ({ ...e, key: e.key.trim().toUpperCase() })).filter((e) => e.key && !byEpic.get(e.key)?.excluded);
    let target =
      (group.project_id && projectIds.has(group.project_id) ? group.project_id : null) ??
      channels.map((c) => byChannel.get(c.channel_id)?.project_id).find((id) => id && projectIds.has(id)) ??
      epics.map((e) => byEpic.get(e.key)?.project_id).find((id) => id && projectIds.has(id)) ??
      null;
    const fresh = channels.filter((c) => !byChannel.has(c.channel_id) && !linked.has(c.channel_id));
    const freshEpics = epics.filter((e) => !byEpic.has(e.key) && !linkedEpics.has(e.key));
    if (!target) {
      if (fresh.length) {
        const primary =
          fresh.find((c) => c.role === "primary" && isTmpChannel(c.name)) ??
          fresh.find((c) => isTmpChannel(c.name)) ??
          fresh.find((c) => c.role === "primary") ??
          fresh[0];
        target = newProjectId(newId);
        plan.newProjects.push({ id: target, name: group.name || nameFromChannel(primary.name), tracked: fresh.some((c) => isTmpChannel(c.name)), reason: group.reason });
        plan.links.push({ channel_id: primary.channel_id, project_id: target, name: primary.name, role: "primary", reason: group.reason });
        linked.add(primary.channel_id);
      } else if (freshEpics.length) {
        // Found in Jira alone: always a suggestion, named as discovery named it.
        target = newProjectId(newId);
        plan.newProjects.push({ id: target, name: group.name || freshEpics[0].title, tracked: false, reason: group.reason });
      } else continue;
    }
    for (const c of fresh) {
      if (linked.has(c.channel_id)) continue;
      plan.links.push({ channel_id: c.channel_id, project_id: target, name: c.name, role: "related", reason: group.reason });
      linked.add(c.channel_id);
    }
    for (const e of freshEpics) {
      plan.epicLinks.push({ epic_key: e.key, project_id: target, title: e.title });
      linkedEpics.add(e.key);
    }
  }
  return plan;
}

/** Channels a refresh found the project in that aren't linked to any project yet (or unlinked by the user). */
export function newRelatedChannels(found: RelatedChannel[], known: ProjectChannel[]): RelatedChannel[] {
  const seen = new Set(known.map((c) => c.channel_id));
  return found.filter((c) => {
    if (seen.has(c.channel_id)) return false;
    seen.add(c.channel_id);
    return true;
  });
}

/** The project's main Slack channel, where reminders go: its own, else one it shares; null for a project with no channel. */
export function primaryChannel(p: Pick<Project, "channels"> & { shared_channels?: SharedChannel[] }): { channel_id: string; name: string } | null {
  return activeChannels(p)[0] ?? p.shared_channels?.[0] ?? null;
}

/** Every channel a project reads: its own, primary first, then the ones it shares with other projects. */
export function readChannels(p: Pick<Project, "channels"> & { shared_channels?: SharedChannel[] }): { channel_id: string; name: string; shared: boolean }[] {
  const own = activeChannels(p).map((c) => ({ channel_id: c.channel_id, name: c.name, shared: false }));
  const ids = new Set(own.map((c) => c.channel_id));
  return [...own, ...(p.shared_channels ?? []).filter((c) => !ids.has(c.channel_id)).map((c) => ({ ...c, shared: true }))];
}

/**
 * The other projects reading each of a project's channels, by channel id: for one it owns, the
 * projects sharing it; for one it shares, the owner and any others sharing it. Only channels read by
 * more than one project are listed.
 */
export function channelSharers(
  project: Pick<Project, "channel_id" | "channels"> & { shared_channels?: SharedChannel[] },
  all: (Pick<Project, "channel_id" | "channels" | "name" | "snapshot" | "state"> & { shared_channels?: SharedChannel[]; focus?: { pinned_name: string | null } | null })[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of readChannels(project)) {
    const others = all
      .filter((o) => o.channel_id !== project.channel_id && o.state !== "merged" && o.state !== "ignored")
      .filter((o) => readChannels(o).some((x) => x.channel_id === c.channel_id))
      .map((o) => projectName(o));
    if (others.length) out.set(c.channel_id, others);
  }
  return out;
}

/** The project's linked epics, unlinked ones left out, in the order they were linked. */
export function activeEpics(p: Pick<Project, "epics">): ProjectEpicLink[] {
  return p.epics.filter((e) => !e.excluded);
}

/**
 * An epic's page in Jira: its own link once a refresh has seen it, else one built on the Jira site
 * the project's other epic links and resources are on; null when there's none to go by.
 */
export function epicUrl(p: Pick<Project, "epics" | "profile">, key: string): string | null {
  const own = p.epics.find((e) => e.epic_key === key)?.link;
  if (own) return own;
  const links = [...p.epics.map((e) => e.link), ...(p.profile?.resources ?? []).map((r) => r.link)];
  const site = links.map((l) => l?.match(/^(https:\/\/[^/]+)\/browse\/[A-Z][A-Z0-9_]+-\d+/)?.[1]).find(Boolean);
  return site ? `${site}/browse/${key}` : null;
}

/** The Jira site a project's epics are on, "https://example.atlassian.net", from their links. */
export function jiraSite(links: (string | null | undefined)[]): string | null {
  return links.map((l) => l?.match(/^(https:\/\/[^/]+\.atlassian\.net)\/browse\/[A-Z][A-Z0-9_]+-\d+/)?.[1]).find(Boolean) ?? null;
}

/**
 * A Jira issue link moved onto the site the project's epics are on: links from before the move to the
 * cloud site (a self-hosted Jira, or an older atlassian.net site) still turn up in messages and docs,
 * and name the same issue by its key. Anything else is left as it is.
 */
export function cloudJiraLink<T extends string | null | undefined>(link: T, site: string | null): T {
  if (!link || !site) return link;
  const m = link.match(/^https?:\/\/([^/]+)\/browse\/([A-Z][A-Z0-9_]+-\d+)(?:[/?#].*)?$/);
  if (!m || `https://${m[1]}` === site || !/jira|atlassian\.net$/.test(m[1])) return link;
  return `${site}/browse/${m[2]}` as T;
}

/**
 * A refresh's record with its Jira links on the project's site: the path's steps and ship source, the
 * profile's resources and decisions, and the links (not the ids, which stay as they were found) of its
 * blockers, active work and updates.
 */
export function withCloudJiraLinks<S extends ProjectSnapshot, P extends ProjectProfile>(snapshot: S, profile: P, site: string | null): { snapshot: S; profile: P } {
  if (!site) return { snapshot, profile };
  const fix = <T extends string | null | undefined>(l: T) => cloudJiraLink(l, site);
  const path = snapshot.path
    ? {
        ...snapshot.path,
        ship: snapshot.path.ship ? { ...snapshot.path.ship, source: snapshot.path.ship.source ? { ...snapshot.path.ship.source, link: fix(snapshot.path.ship.source.link) } : snapshot.path.ship.source } : snapshot.path.ship,
        steps: snapshot.path.steps.map((s) => ({
          ...s,
          link: fix(s.link),
          epic: s.epic ? { ...s.epic, link: fix(s.epic.link) } : s.epic,
          items: (s.items ?? []).map((i) => ({ ...i, link: fix(i.link) })),
        })),
      }
    : snapshot.path;
  return {
    snapshot: {
      ...snapshot,
      path,
      blockers: snapshot.blockers.map((b) => ({ ...b, link: fix(b.link) })),
      active: (snapshot.active ?? []).map((a) => ({ ...a, link: fix(a.link) })),
      recent_updates: (snapshot.recent_updates ?? []).map((u) => ({ ...u, link: fix(u.link) })),
    },
    profile: {
      ...profile,
      resources: profile.resources.map((r) => ({ ...r, link: fix(r.link) ?? r.link })),
      decisions: profile.decisions.map((d) => ({ ...d, link: fix(d.link) })),
    },
  };
}

/** The project's linked channels, primary first; unlinked ones left out. */
export function activeChannels(p: Pick<Project, "channels">): ProjectChannel[] {
  return p.channels.filter((c) => c.role !== "excluded").sort((a, b) => (a.role === "primary" ? -1 : b.role === "primary" ? 1 : 0));
}

/** "tmp-asset-refunds" -> "Asset refunds", for projects Claude hasn't named yet. */
export function nameFromChannel(channel: string): string {
  const words = channel.replace(/^tmp-/, "").split(/[-_]+/).filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The project's proper name: the user's, if they named it (renamed or split it off); else Claude's
 * from the last refresh; else one derived from the channel.
 */
export function projectName(p: Pick<Project, "name" | "snapshot"> & { channel_id?: string; focus?: { pinned_name: string | null } | null }): string {
  // A project with an id of Demian's own (or found from its epic) already has a proper name, not a channel's.
  const named = !!p.channel_id && /^(jira|p):/.test(p.channel_id);
  return p.focus?.pinned_name || p.snapshot?.name || (named ? p.name : nameFromChannel(p.name));
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Little words that don't tell two statements apart. */
const FILLER = new Set(["a", "an", "the", "is", "are", "was", "were", "be", "to", "of", "and", "or", "in", "on", "for", "with", "when", "there", "that", "this", "it", "its", "by", "as", "at", "from"]);
const words = (s: string) => new Set(norm(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !FILLER.has(w)));

/** Whether two statements say the same thing: nearly all of the shorter one's words are in the other. */
function sameStatement(a: string, b: string): boolean {
  const [x, y] = [words(a), words(b)];
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  if (!small.size) return false;
  let shared = 0;
  for (const w of small) if (big.has(w)) shared++;
  return shared / small.size >= 0.8;
}

/**
 * Drops near-duplicates (the same decision or milestone reworded by another refresh, or once with a
 * link and once without): entries on the same date (or with none) saying the same thing. The one
 * with a link is kept, else the first.
 */
export function dedupeStatements<T extends { what: string; date?: string | null; link?: string | null }>(items: T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const i = out.findIndex((o) => (!o.date || !item.date || o.date === item.date) && sameStatement(o.what, item.what));
    if (i === -1) out.push(item);
    else if (!out[i].link && item.link) out[i] = item;
  }
  return out;
}

/** Items from `next` first, then the ones from `prev` it no longer lists, by key, up to `max`. */
function union<T>(next: T[], prev: T[], key: (t: T) => string, max: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of [...next, ...prev]) {
    const k = key(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, max);
}

/**
 * A refresh's profile folded into what was known, so a project's knowledge builds up instead of
 * being replaced: people, resources, milestones and decisions it no longer mentions are kept (the
 * oldest fall off past each cap), the user's own names for it are always among its aliases, and an
 * empty goal never replaces a known one.
 */
/**
 * A project's context as the user sees it: their own entries, then Demian's (from its refreshes)
 * that they haven't removed or rewritten. Each knows whose it is.
 */
export function projectContext(p: Pick<Project, "profile" | "focus">): { text: string; by: "you" | "demian" }[] {
  const mine = p.focus?.context ?? [];
  const removed = new Set((p.focus?.removed ?? []).map(norm));
  const have = new Set(mine.map(norm));
  const legacy = [p.profile?.focus, p.profile?.out_of_scope && `Not part of it: ${p.profile.out_of_scope}`].filter((t): t is string => !!t?.trim());
  const demians = (p.profile?.context?.length ? p.profile.context : legacy).filter((t) => t.trim() && !removed.has(norm(t)) && !have.has(norm(t)));
  return [...mine.map((text) => ({ text, by: "you" as const })), ...demians.map((text) => ({ text, by: "demian" as const }))];
}

export function mergeProfile(prev: ProjectProfile | null, next: ProjectProfile, pinnedAliases: string[] = []): ProjectProfile {
  if (!prev) return { ...next, aliases: union(pinnedAliases, next.aliases, norm, 10) };
  const byDate = (a: { date?: string | null }, b: { date?: string | null }) => (a.date ?? "").localeCompare(b.date ?? "");
  return {
    goal: next.goal?.trim() ? next.goal : prev.goal,
    context: next.context?.length ? next.context : (prev.context ?? []),
    aliases: union([...pinnedAliases, ...next.aliases], prev.aliases, norm, 10),
    people: mergePeople(next.people, prev.people),
    resources: union(next.resources, prev.resources, (r) => norm(r.link), 16),
    milestones: dedupeStatements(union(next.milestones, prev.milestones, (m) => `${norm(m.what)}|${m.date ?? ""}`, 24)).slice(0, 12).sort(byDate),
    decisions: dedupeStatements(union(next.decisions, prev.decisions, (d) => norm(d.link) || norm(d.what), 30)).slice(0, 15).sort((a, b) => byDate(b, a)),
  };
}

/**
 * The people a refresh read, then the ones from before it didn't mention (at most sixteen). What a
 * refresh left out about someone it did read (their Slack id, avatar, how central they are, what
 * they're on) is kept from before; what it says replaces it, "" for "on nothing now" included.
 */
export function mergePeople(next: ProfilePerson[], prev: ProfilePerson[]): ProfilePerson[] {
  const before = new Map(prev.map((p) => [norm(p.name), p]));
  return union(next, prev, (p) => norm(p.name), 16).map((p) => {
    const old = before.get(norm(p.name));
    if (!old || old === p) return p;
    return {
      ...p,
      slack_user_id: p.slack_user_id || old.slack_user_id || null,
      avatar: p.avatar || old.avatar || null,
      importance: p.importance ?? old.importance ?? null,
      working_on: p.working_on ?? old.working_on ?? null,
      raci: p.raci ?? old.raci ?? null,
    };
  });
}

/**
 * How central someone is to a project, 1 to 5: the refresh's call, or for people it hasn't rated
 * yet, from where they are in its list (most central first).
 */
export function importanceOf(person: Pick<ProfilePerson, "importance">, index: number): number {
  if (person.importance) return person.importance;
  return index < 2 ? 4 : index < 5 ? 3 : index < 10 ? 2 : 1;
}

/** A person's key in the people record: their Slack id, or their name when that isn't known. */
export function personKey(p: { name: string; slack_user_id?: string | null }): string {
  return p.slack_user_id || `name:${norm(p.name)}`;
}

/** A name as people are matched by it: trimmed, lowercased. */
export const personName = (name: string) => norm(name);

/**
 * The people record after a project's refresh: each person it lists has their part in the project
 * set (role, how central, what they're on) and their face kept up to date, found by Slack id or name
 * (a record kept by name moves to their Slack id once that's known); anyone recorded on the project
 * who's no longer listed is taken off it. Only the records that change are returned.
 */
export function recordedPeople(
  records: Record<string, PersonRecord>,
  projectId: string,
  people: ProfilePerson[],
  at: string,
): { put: [string, PersonRecord][]; remove: string[] } {
  const put = new Map<string, PersonRecord>();
  const remove = new Set<string>();
  const byName = new Map(Object.entries(records).map(([key, r]) => [norm(r.name), key]));
  const listed = new Set<string>();
  people.forEach((p, i) => {
    // Their record: by Slack id, else by name, unless that's someone else's Slack id.
    const direct = personKey(p);
    const named = byName.get(norm(p.name));
    const oldKey = records[direct] ? direct : named && (!p.slack_user_id || !records[named].slack_user_id) ? named : undefined;
    const old = oldKey ? (put.get(oldKey) ?? records[oldKey]) : undefined;
    const key = p.slack_user_id || old?.slack_user_id || `name:${norm(p.name)}`;
    const part = { role: p.role, importance: importanceOf(p, i), working_on: p.working_on ?? old?.projects[projectId]?.working_on ?? "", at };
    const was = old?.projects[projectId];
    const same = was && was.role === part.role && was.importance === part.importance && was.working_on === part.working_on;
    const avatar = p.avatar || old?.avatar || null;
    const slack = p.slack_user_id || old?.slack_user_id || null;
    listed.add(key);
    if (oldKey) listed.add(oldKey);
    if (old && same && oldKey === key && avatar === old.avatar && slack === old.slack_user_id) return;
    if (oldKey && oldKey !== key) {
      remove.add(oldKey);
      put.delete(oldKey);
    }
    put.set(key, {
      name: p.name,
      slack_user_id: slack,
      avatar,
      projects: { ...(old?.projects ?? {}), [projectId]: same ? was : part },
      at,
    });
  });
  for (const [key, r] of Object.entries(records)) {
    if (listed.has(key) || remove.has(key) || !r.projects[projectId]) continue;
    const { [projectId]: _gone, ...projects } = r.projects;
    put.set(key, { ...r, projects, at });
  }
  return { put: [...put], remove: [...remove] };
}

/** Faces from the people record, by name as matched (see personName). */
export function avatarIndex(records: PersonRecord[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of records) if (r.avatar) out[norm(r.name)] = r.avatar;
  return out;
}

/** Folds a merged-away project's knowledge into the one it joins: its name becomes another name for it. */
export function foldProfile(into: ProjectProfile | null, from: ProjectProfile | null, fromName: string): ProjectProfile {
  const base: ProjectProfile = into ?? { goal: from?.goal ?? "", context: [], aliases: [], people: [], resources: [], milestones: [], decisions: [] };
  return mergeProfile(from, base, [fromName]);
}

/** A link that opens the channel in the Slack app (or Slack on the web). */
export function slackChannelUrl(channelId: string, permalinks: (string | null | undefined)[] = []): string {
  // Enterprise Grid workspaces don't resolve app_redirect without a team, so use the
  // workspace's own domain, taken from a message permalink in the same channel, when there is one.
  const host = permalinks.map((link) => link?.match(/^https:\/\/([a-z0-9-]+\.slack\.com)\/archives\//)?.[1]).find(Boolean);
  return host ? `https://${host}/archives/${channelId}` : `https://slack.com/app_redirect?channel=${channelId}`;
}

/**
 * The channel and thread a Slack message permalink points at, so a reply can go in
 * its thread: https://x.slack.com/archives/C123/p1700000000000100?thread_ts=1699999999.000200
 */
export function slackThread(link: string | null | undefined): { channelId: string; threadTs: string } | null {
  // Any Slack address: workspace.slack.com, or workspace.enterprise.slack.com on Enterprise Grid.
  const m = link?.match(/^https:\/\/[a-z0-9.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!m) return null;
  const parent = link!.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1];
  return { channelId: m[1], threadTs: parent ?? `${m[2]}.${m[3]}` };
}

/** Where a message handed over to send goes, read from the target a chat wrote. */
export type SlackTarget =
  | { kind: "thread"; channelId: string; threadTs: string }
  /** A channel, DM or group DM by its ID (C…, D…, G…). */
  | { kind: "conversation"; id: string }
  /** A person by their user ID (U…, W…): a DM. */
  | { kind: "user"; id: string }
  /** A channel by name, "#name", to look up. */
  | { kind: "channel"; name: string }
  /** A person by name, "@Ana Lee" or "Ana Lee", to look up: a DM. */
  | { kind: "person"; name: string }
  /** Several people, by user ID or by name to look up: a group DM. */
  | { kind: "group"; ids: string[]; names: string[] };

/**
 * Reads a send target: a thread's permalink, an ID, "#channel", a person for a DM ("@U0123ABCD",
 * "@Ana Lee", "<@U0123ABCD>", or just their name, "DM with Ana Lee" included), or several people
 * for a group DM ("@U0123ABCD, @U0456EFGH", "Ana Lee, Ben Ross and Cara Diaz").
 */
export function slackTarget(to: string): SlackTarget {
  const t = to.trim();
  const thread = slackThread(t);
  if (thread) return { kind: "thread", ...thread };
  const people = t
    .replace(/^(?:a\s+)?group\s+DM\s+with\s+/i, "")
    .split(/\s*[,;&]\s*|\s+and\s+/i)
    .map((p) => p.replace(/^<?@/, "").replace(/>$/, "").trim())
    .filter(Boolean);
  // People only: a list with a channel in it isn't a group DM.
  if (people.length > 1 && !people.some((p) => /^#/.test(p) || /^[CDG][A-Z0-9]{6,}$/.test(p))) {
    const isId = (p: string) => /^[UW][A-Z0-9]{6,}$/.test(p);
    return { kind: "group", ids: people.filter(isId), names: people.filter((p) => !isId(p)) };
  }
  const mention = /^<?@/.test(t);
  const bare = t.replace(/^<?@/, "").replace(/>$/, "").trim();
  if (/^[UW][A-Z0-9]{6,}$/.test(bare)) return { kind: "user", id: bare };
  if (!mention && /^[CDG][A-Z0-9]{6,}$/.test(bare)) return { kind: "conversation", id: bare };
  if (!mention && /^#/.test(bare)) return { kind: "channel", name: bare.replace(/^#/, "") };
  // Slack's channel names are lowercase with no spaces; a person is named with @ or in words.
  if (!mention && /^[a-z0-9][a-z0-9._-]*$/.test(bare)) return { kind: "channel", name: bare };
  return { kind: "person", name: bare.replace(/^(?:a\s+)?DM\s+with\s+/i, "").trim() };
}

/**
 * How a Slack conversation is named in the app: a channel as "#name"; a group DM (Slack names those
 * "mpdm-ana--ben--cara-1") as its people, "ana, ben, cara"; a DM (its ID starts with D), or any name
 * that isn't a channel's ("Group DM with Ana, Ben"), as it is, without a pound sign.
 */
export function channelLabel(c: { name: string; channel_id?: string }): string {
  const name = c.name.replace(/^#/, "");
  const group = /^mpdm-(.+?)(?:-\d+)?$/.exec(name);
  if (group) return group[1].split("--").join(", ");
  if (c.channel_id?.startsWith("D")) return name;
  // Only a real channel name gets the pound sign: Slack's are lowercase with no spaces. Anything
  // else ("Group DM (Ana, Ben)", a person's name) names a conversation already.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return name;
  return `#${name}`;
}

export interface ShipTarget {
  what: string;
  /** YYYY-MM-DD, or null when nothing names one. */
  date: string | null;
  /** Where the date came from (an epic, the doc, a message); none for one the user set. */
  source: { title: string; link?: string | null } | null;
  /** The user set the date, and no refresh has looked again since. */
  byYou: boolean;
}

/**
 * What a project ships and when: a date the user set, until a refresh after it has looked again (told
 * to keep it unless something clearly moves it); otherwise what the latest refresh read. None for a
 * workstream, or before a refresh has read its path.
 */
export function shipTarget(p: Pick<Project, "snapshot" | "last_refreshed_at" | "ship_choice" | "kind_choice">): ShipTarget | null {
  if (projectKind(p) === "workstream") return null;
  const read = p.snapshot?.path?.ship ?? null;
  const mine = p.ship_choice;
  if (mine && (!p.last_refreshed_at || mine.at > p.last_refreshed_at)) return { what: read?.what ?? "", date: mine.date, source: null, byYou: true };
  if (!read && !mine) return null;
  // A source says where a date came from; without a date there's nothing to source.
  const date = read?.date ?? null;
  return { what: read?.what ?? "", date, source: date ? (read?.source ?? null) : null, byYou: false };
}

/** A project's path to shipping, as the latest refresh read it; none for a workstream. */
export function pathToShip(p: Pick<Project, "snapshot" | "kind_choice">): PathToShip | null {
  if (projectKind(p) === "workstream") return null;
  return p.snapshot?.path ?? null;
}

/** A step that's underway: in progress, or started and stuck. */
export const isUnderway = (s: Pick<PathStep, "status">) => s.status === "in_progress" || s.status === "blocked";

/**
 * The steps the project is on: every one underway, in path order (parts of a project often move at
 * the same time); when none is, the first still to come.
 */
export function stepsUnderway(steps: PathStep[]): PathStep[] {
  const on = steps.filter(isUnderway);
  if (on.length) return on;
  const next = steps.find((s) => s.status === "next");
  return next ? [next] : [];
}

/** One strand of a project's work, with its steps in path order. */
export interface PathTrack {
  name: string;
  steps: PathStep[];
}

/** A step's track, trimmed; "" when it has none. */
const trackName = (s: PathStep) => s.track?.trim() ?? "";

/**
 * A path's tracks, the strands of work that move at the same time, in the order they first appear
 * (names matched regardless of case). Steps without one go in "Other", last. Null when the path has
 * fewer than two tracks: it's one strand, and reads best as a list.
 */
export function pathTracks(steps: PathStep[]): PathTrack[] | null {
  const tracks = new Map<string, PathTrack>();
  const rest: PathStep[] = [];
  for (const s of steps) {
    const name = trackName(s);
    if (!name) rest.push(s);
    else {
      const key = name.toLowerCase();
      if (!tracks.has(key)) tracks.set(key, { name, steps: [] });
      tracks.get(key)!.steps.push(s);
    }
  }
  if (tracks.size < 2) return null;
  return rest.length ? [...tracks.values(), { name: "Other", steps: rest }] : [...tracks.values()];
}

/**
 * What the card says the project is doing now: the step it's on, or how many are underway (and how
 * many of those are stuck), by track when it has them. The title lists each step.
 */
export function nowText(steps: PathStep[]): { text: string; title: string } | null {
  const now = stepsUnderway(steps);
  if (!now.length) return null;
  if (now.length === 1) return { text: `now: ${now[0].what}`, title: now[0].what };
  const blocked = now.filter((s) => s.status === "blocked").length;
  const tracks = [...new Map(now.filter(trackName).map((s) => [trackName(s).toLowerCase(), trackName(s)])).values()];
  const count = `${now.length} underway${blocked ? ` (${blocked} blocked)` : ""}`;
  return {
    text: tracks.length ? `${count}: ${tracks.join(", ")}` : `now: ${now[0].what} and ${now.length - 1} more`,
    title: now.map((s) => `${s.status === "blocked" ? "Blocked: " : ""}${s.what}`).join("\n"),
  };
}

/**
 * A person's role as a refresh wrote it, split into their title and anything said after it: "eng, 6
 * issues in PAY-123" is "eng" with "6 issues in PAY-123", "PM (payments)" is "PM" with "payments".
 * Earlier refreshes put both in the role; a title alone has no detail.
 */
export function roleParts(role: string): { title: string; detail: string | null } {
  const m = role.trim().match(/^(.+?)(?:\s*[,;(—–]\s*|\s+-\s+)(.+)$/);
  if (!m) return { title: role.trim(), detail: null };
  const detail = m[2].replace(/\)\s*$/, "").trim();
  return { title: m[1].trim(), detail: detail || null };
}

/**
 * The project's priority as shown: one the user set by hand, which stays until they pick Automatic,
 * else the latest refresh's (with its reason); null before either.
 */
export function projectPriority(p: Pick<Project, "snapshot" | "priority_choice">): { level: ProjectPriority; reason: string | null; byYou: boolean } | null {
  if (p.priority_choice) return { level: p.priority_choice.level, reason: null, byYou: true };
  const read = p.snapshot?.priority;
  return read ? { level: read.level, reason: read.reason, byYou: false } : null;
}

/**
 * The project's status as shown: one the user set, until a refresh after it has looked again (told to
 * keep it unless something has clearly changed since); otherwise the latest refresh's.
 */
export function projectStatus(p: Pick<Project, "snapshot" | "last_refreshed_at" | "status_override">): ProjectSnapshot["status"] | undefined {
  const o = p.status_override;
  if (o && (!p.last_refreshed_at || o.at > p.last_refreshed_at)) return o.status;
  return p.snapshot?.status;
}

// ---- projects and workstreams

/** Project or workstream: the user's choice, else the latest refresh's; null before the first refresh. */
export function projectKind(p: Pick<Project, "kind_choice" | "snapshot">): ProjectKind | null {
  return p.kind_choice?.kind ?? p.snapshot?.kind?.value ?? null;
}

/** A project (not a workstream) with no guiding doc linked: its card says so. */
export function missingDoc(p: Pick<Project, "kind_choice" | "snapshot" | "docs">): boolean {
  return projectKind(p) === "project" && !p.docs?.doc;
}

/** How a doc's kind reads on its chip: "TDD", "PRD", "Spec"; nothing for "other" or none. */
export function docKindLabel(kind: string | null | undefined): string | null {
  const k = kind?.trim().toLowerCase();
  if (!k || k === "other") return null;
  if (k === "tdd" || k === "prd") return k.toUpperCase();
  if (k === "spec") return "Spec";
  return null;
}

/** The guiding doc's title: as read from the doc, else as it was linked. */
export function guideTitle(p: Pick<Project, "docs" | "requirements">): string | null {
  const doc = p.docs?.doc;
  if (!doc) return null;
  return (p.requirements?.link === doc.link && p.requirements.title?.trim()) || doc.title;
}

/** Long enough that a daily refresh reads the doc again each day. */
const READ_EVERY_MS = 20 * 60 * 60 * 1000;

/**
 * Whether the guiding doc should be read now: it never was, another doc was linked since, or it was
 * last tried most of a day ago (when unchanged, that's a quick check of its edit time).
 */
export function requirementsDue(p: Pick<Project, "docs" | "requirements">, now: Date, force = false): boolean {
  const doc = p.docs?.doc;
  if (!doc) return false;
  if (force) return true;
  const r = p.requirements;
  if (!r || r.link !== doc.link) return true;
  const last = r.triedAt ?? r.readAt;
  return !last || now.getTime() - new Date(last).getTime() >= READ_EVERY_MS;
}

export interface RequirementRow {
  requirement: Requirement;
  /** null until a refresh has looked at it. */
  progress: StoredProgress | null;
}

/** The linked doc's requirements, each with its progress; none while they're from another doc. */
export function requirementRows(p: Pick<Project, "docs" | "requirements">): RequirementRow[] {
  const r = p.requirements;
  const doc = p.docs?.doc;
  if (!r || !doc || r.link !== doc.link) return [];
  return r.requirements.map((requirement) => ({ requirement, progress: r.progress[requirement.id] ?? null }));
}

export type RequirementCounts = Record<RequirementStatus | "pending", number> & { total: number };

/** How many requirements are in each status ("pending": no refresh has looked yet). */
export function requirementCounts(rows: RequirementRow[]): RequirementCounts {
  const counts: RequirementCounts = { total: rows.length, done: 0, in_progress: 0, not_started: 0, at_risk: 0, descoped: 0, unclear: 0, pending: 0 };
  for (const r of rows) counts[r.progress?.status ?? "pending"]++;
  return counts;
}

/** Rows grouped by the doc's sections, in the doc's order; requirements with no section first. */
export function bySection(rows: RequirementRow[]): { section: string | null; rows: RequirementRow[] }[] {
  const groups: { section: string | null; rows: RequirementRow[] }[] = [];
  for (const row of rows) {
    const section = row.requirement.section?.trim() || null;
    const group = groups.find((g) => g.section === section);
    if (group) group.rows.push(row);
    else groups.push({ section, rows: [row] });
  }
  return groups.sort((a, b) => (a.section === null ? -1 : b.section === null ? 1 : 0));
}

/**
 * A read of the guiding doc folded into what was stored: new requirements, with the progress of the
 * ones still there kept (by id); only the time it was checked when the doc hasn't changed; the
 * requirements as they were, with the reason, when it couldn't be read. Another doc starts afresh.
 */
export function withRequirementsRead(
  prev: StoredRequirements | null,
  doc: { link: string; title: string; kind?: string | null },
  read: RequirementsRead,
  at: string,
): StoredRequirements {
  const same = prev?.link === doc.link ? prev : null;
  if (read.unchanged && same && !same.unreadable) return { ...same, readAt: at, triedAt: at, error: null };
  const unreadable = read.unreadable?.trim() || null;
  const requirements = unreadable ? (same?.requirements ?? []) : read.requirements;
  const ids = new Set(requirements.map((r) => r.id));
  return {
    link: doc.link,
    title: read.title?.trim() || same?.title || doc.title,
    kind: read.kind ?? same?.kind ?? doc.kind ?? null,
    readAt: at,
    triedAt: at,
    error: null,
    docUpdated: read.updated ?? null,
    unreadable,
    requirements,
    progress: Object.fromEntries(Object.entries(same?.progress ?? {}).filter(([id]) => ids.has(id))),
    progressAt: same?.progressAt ?? null,
  };
}
