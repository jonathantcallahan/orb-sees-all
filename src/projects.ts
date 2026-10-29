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

/** Opens the channel in the Slack app (or Slack on the web) without knowing the workspace. */
export function slackChannelUrl(channelId: string): string {
  return `https://slack.com/app_redirect?channel=${channelId}`;
}
