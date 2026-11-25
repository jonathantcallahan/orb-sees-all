import type { StoredEpicChildren, StoredSprintEpics } from "./db";
import { epicKeyFrom } from "./projects";
import type { PathToShip } from "./schema";
import { isGathered } from "./sprintEpics";

/**
 * Each Jira issue's type, as far as the planner has read it: for the mark before a link to it (see
 * JiraLinkMark), wherever the link is, in a chat or a project's text. Kept pure so it can be tested.
 */

/** The Jira issue a link opens (".../browse/ABC-123", or a board with "selectedIssue=ABC-123"), by its key; null for any other link. */
export function jiraIssueKey(href: string | null | undefined): string | null {
  if (!href) return null;
  let host: string;
  try {
    host = new URL(href).host;
  } catch {
    return null;
  }
  if (!host.endsWith("atlassian.net") && !host.includes("jira")) return null;
  // A Confluence page on the same site isn't an issue.
  if (/\/wiki\//.test(href)) return null;
  return /\/browse\/|[?&]selectedIssue=/.test(href) ? epicKeyFrom(href) : null;
}

/**
 * Every issue type the planner knows, by key: the Epics area's epics and their issues (and the
 * sprint's issues, when the read has their types), each project's epics, and its plan's initiatives,
 * epics, stories and tasks. What a read says of an issue's type wins over what a key's place implies.
 */
export function issueTypesFrom(read: {
  sprints: Record<string, StoredSprintEpics>;
  children: Record<string, StoredEpicChildren>;
  projects: { epics: { epic_key: string }[]; snapshot: { path?: PathToShip | null } | null }[];
}): Map<string, string> {
  const types = new Map<string, string>();
  const put = (key: string | null | undefined, type: string | null | undefined, sure = false) => {
    const k = key?.trim().toUpperCase();
    if (!k || !type?.trim()) return;
    if (sure || !types.has(k)) types.set(k, type.trim());
  };
  for (const p of read.projects) {
    for (const e of p.epics) put(e.epic_key, "Epic");
    const path = p.snapshot?.path;
    if (!path) continue;
    // A Jira epic the plan reads as an initiative's worth of work is still an epic in Jira.
    for (const i of path.initiatives ?? []) put(i.jira?.key, i.realign ? "Epic" : "Initiative");
    for (const s of path.steps) {
      put(s.epic?.key, "Epic");
      for (const item of s.items ?? []) put(item.key, item.type);
    }
    for (const c of path.created ?? []) put(c.key, c.type);
  }
  for (const s of Object.values(read.sprints)) {
    for (const e of s.epics) {
      put(e.key, "Epic", true);
      for (const p of e.parents ?? []) put(p.key, p.type, true);
      for (const i of e.issues) put(i.key, i.type, true);
    }
    for (const i of s.strays ?? []) put(i.key, i.type, true);
  }
  for (const [key, c] of Object.entries(read.children)) {
    if (!isGathered(key.split("@")[0])) put(key, "Epic", true);
    for (const i of c.issues) put(i.key, i.type, true);
  }
  return types;
}
