import type { Project } from "./db";
import type { Discovery, RelatedChannel } from "./schema";

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

/** The project's proper name: Claude's from the last refresh, else one derived from the channel. */
export function projectName(p: Pick<Project, "name" | "snapshot">): string {
  return p.snapshot?.name || nameFromChannel(p.name);
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
  const m = link?.match(/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!m) return null;
  const parent = link!.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1];
  return { channelId: m[1], threadTs: parent ?? `${m[2]}.${m[3]}` };
}
