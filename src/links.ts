export type LinkKind =
  | "slack"
  | "gmail"
  | "docs"
  | "sheets"
  | "slides"
  | "drive"
  | "calendar"
  | "jira"
  | "confluence"
  | "github"
  | "figma"
  | "web";

export interface TaskLink {
  url: string;
  title: string;
  kind: LinkKind;
}

/** What a link points at, judged from its URL. */
export function linkKind(url: string): LinkKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "web";
  }
  const host = u.hostname;
  const path = u.pathname;
  if (host.endsWith("slack.com")) return "slack";
  if (host === "mail.google.com") return "gmail";
  if (host === "docs.google.com") {
    if (path.startsWith("/spreadsheets")) return "sheets";
    if (path.startsWith("/presentation")) return "slides";
    if (path.startsWith("/document")) return "docs";
    return "drive";
  }
  if (host === "drive.google.com") return "drive";
  if (host === "calendar.google.com") return "calendar";
  if (host.endsWith("atlassian.net") || host.includes("jira")) {
    return path.includes("/wiki") ? "confluence" : "jira";
  }
  if (host.includes("confluence")) return "confluence";
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host.endsWith("figma.com")) return "figma";
  return "web";
}

const KIND_NAME: Record<LinkKind, string> = {
  slack: "Slack thread",
  gmail: "Email",
  docs: "Doc",
  sheets: "Sheet",
  slides: "Slides",
  drive: "Drive file",
  calendar: "Event",
  jira: "Jira",
  confluence: "Confluence page",
  github: "GitHub",
  figma: "Figma",
  web: "Link",
};

/** A readable title for a link that came without one, e.g. "CPS-6931" for a Jira issue. */
export function fallbackTitle(url: string, kind: LinkKind = linkKind(url)): string {
  try {
    const u = new URL(url);
    if (kind === "jira") {
      const key = u.pathname.match(/[A-Z][A-Z0-9_]+-\d+/)?.[0];
      if (key) return key;
    }
    if (kind === "github") {
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/);
      if (m) return `${m[2]}#${m[4]}`;
    }
    if (kind === "web") return u.hostname.replace(/^www\./, "");
  } catch {
    // Not a URL; fall through.
  }
  return KIND_NAME[kind];
}

/** Titles that only say where a link lives (a channel, a URL) rather than what it is. */
function placeOnly(title: string): boolean {
  const t = title.trim();
  const channelName = /^#?[a-z0-9][a-z0-9_-]*$/.test(t) && /[#_-]/.test(t);
  return channelName || /^https?:\/\//.test(t) || /^(DM|Slack|Email|Gmail)$/i.test(t);
}

const URL_IN_TEXT = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;

/**
 * Every link relevant to a task, deduplicated, in order of relevance: the
 * source message, then links from the description, the plan and the last
 * double check. Titles given by a source win over guessed ones.
 */
export function collectLinks(sources: { url?: string | null; title?: string | null }[], texts: (string | null | undefined)[] = []): TaskLink[] {
  const byUrl = new Map<string, TaskLink>();
  const add = (url: string | null | undefined, title?: string | null) => {
    if (!url || !/^https?:\/\//.test(url)) return;
    const kind = linkKind(url);
    const existing = byUrl.get(url);
    if (existing) {
      if (title?.trim() && !placeOnly(title) && existing.title === fallbackTitle(url, kind)) existing.title = title.trim();
      return;
    }
    const given = title?.trim();
    byUrl.set(url, { url, kind, title: given && !placeOnly(given) ? given : fallbackTitle(url, kind) });
  };
  const [first, ...rest] = sources;
  if (first) add(first.url, first.title);
  for (const text of texts) for (const url of text?.match(URL_IN_TEXT) ?? []) add(url);
  for (const s of rest) add(s.url, s.title);
  return [...byUrl.values()];
}
