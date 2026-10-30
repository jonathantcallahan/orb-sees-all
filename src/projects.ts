import type { Project } from "./db";

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
  // Enterprise Grid workspaces (like Unity's) don't resolve app_redirect without a team, so use the
  // workspace's own domain, taken from a message permalink in the same channel, when there is one.
  const host = permalinks.map((link) => link?.match(/^https:\/\/([a-z0-9-]+\.slack\.com)\/archives\//)?.[1]).find(Boolean);
  return host ? `https://${host}/archives/${channelId}` : `https://slack.com/app_redirect?channel=${channelId}`;
}
