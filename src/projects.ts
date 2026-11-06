import type { Project } from "./db";
import type { Discovery, ProjectProfile, ProjectSnapshot, RelatedChannel } from "./schema";

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

/** #tmp- channels are project channels by convention, so their projects go straight on the board. */
export const isTmpChannel = (name: string) => name.startsWith("tmp-");

export interface DiscoveryPlan {
  newProjects: { id: string; name: string; tracked: boolean; reason: string }[];
  links: { channel_id: string; project_id: string; name: string; role: "primary" | "related"; reason: string }[];
  renames: { channel_id: string; name: string }[];
}

/**
 * Turns what discovery found into changes, leaving what's already known in place: a channel already
 * linked to a project stays with it, channels the user unlinked are skipped, and new channels join
 * the project they were found with (an existing one when any of its channels is known). A new
 * project is keyed by its primary channel, and is tracked when it has a #tmp- channel; otherwise
 * it's a suggestion for the user to accept or ignore.
 */
export function planDiscovery(found: Discovery["projects"], known: ProjectChannel[], projectIds: Set<string>): DiscoveryPlan {
  const byChannel = new Map(known.map((c) => [c.channel_id, c]));
  const plan: DiscoveryPlan = { newProjects: [], links: [], renames: [] };
  const linked = new Set<string>();
  for (const group of found) {
    for (const c of group.channels) {
      const k = byChannel.get(c.channel_id);
      if (k && k.name !== c.name && !plan.renames.some((r) => r.channel_id === c.channel_id))
        plan.renames.push({ channel_id: c.channel_id, name: c.name });
    }
    const channels = group.channels.filter((c) => byChannel.get(c.channel_id)?.role !== "excluded");
    let target =
      (group.project_id && projectIds.has(group.project_id) ? group.project_id : null) ??
      channels.map((c) => byChannel.get(c.channel_id)?.project_id).find((id) => id && projectIds.has(id)) ??
      null;
    const fresh = channels.filter((c) => !byChannel.has(c.channel_id) && !linked.has(c.channel_id));
    if (!target) {
      if (!fresh.length) continue;
      const primary =
        fresh.find((c) => c.role === "primary" && isTmpChannel(c.name)) ??
        fresh.find((c) => isTmpChannel(c.name)) ??
        fresh.find((c) => c.role === "primary") ??
        fresh[0];
      target = primary.channel_id;
      plan.newProjects.push({ id: target, name: primary.name, tracked: fresh.some((c) => isTmpChannel(c.name)), reason: group.reason });
      plan.links.push({ channel_id: primary.channel_id, project_id: target, name: primary.name, role: "primary", reason: group.reason });
      linked.add(primary.channel_id);
    }
    for (const c of fresh) {
      if (linked.has(c.channel_id)) continue;
      plan.links.push({ channel_id: c.channel_id, project_id: target, name: c.name, role: "related", reason: group.reason });
      linked.add(c.channel_id);
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
export function projectName(p: Pick<Project, "name" | "snapshot"> & { focus?: { pinned_name: string | null } | null }): string {
  return p.focus?.pinned_name || p.snapshot?.name || nameFromChannel(p.name);
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
    people: union(next.people, prev.people, (p) => norm(p.name), 16),
    resources: union(next.resources, prev.resources, (r) => norm(r.link), 16),
    milestones: dedupeStatements(union(next.milestones, prev.milestones, (m) => `${norm(m.what)}|${m.date ?? ""}`, 24)).slice(0, 12).sort(byDate),
    decisions: dedupeStatements(union(next.decisions, prev.decisions, (d) => norm(d.link) || norm(d.what), 30)).slice(0, 15).sort((a, b) => byDate(b, a)),
  };
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
  | { kind: "person"; name: string };

/**
 * Reads a send target: a thread's permalink, an ID, "#channel", or a person for a DM ("@U0123ABCD",
 * "@Ana Lee", "<@U0123ABCD>", or just their name, "DM with Ana Lee" included).
 */
export function slackTarget(to: string): SlackTarget {
  const t = to.trim();
  const thread = slackThread(t);
  if (thread) return { kind: "thread", ...thread };
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

/**
 * The project's status as shown: one the user set, until a refresh after it has looked again (told to
 * keep it unless something has clearly changed since); otherwise the latest refresh's.
 */
export function projectStatus(p: Pick<Project, "snapshot" | "last_refreshed_at" | "status_override">): ProjectSnapshot["status"] | undefined {
  const o = p.status_override;
  if (o && (!p.last_refreshed_at || o.at > p.last_refreshed_at)) return o.status;
  return p.snapshot?.status;
}
