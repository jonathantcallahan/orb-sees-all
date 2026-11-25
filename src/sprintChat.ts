import type { StoredEpicChildren, StoredSprintEpics } from "./db";
import { epicPoints, OVERLOAD_POINTS, pointsOf, sizeOf } from "./sizes";
import { burndown, listStoreKey, orderEpics, personEpic, personKey, sprintIssues, sprintKey, sprintPeople, UNAFFILIATED, type SprintEpic } from "./sprintEpics";

/**
 * The Epics area's chats: the area's own, about the Jira project's sprints as a whole; one about an
 * epic; and one about a person's work in the sprint. Each is a Demian chat (its key starts like the
 * Demian chat's, so it's treated as one: the planner's context, and changes proposed as cards) told
 * each turn what the Epics area shows about its subject.
 */
export const SPRINTS_CHAT = "global:sprints:";
export const EPIC_CHAT = "global:epic:";
export const PERSON_CHAT = "global:person:";

/** What an Epics area chat is about: the project's sprints, an epic, or a person's work in the project's sprints. */
export type SprintChatAbout =
  | { kind: "sprints"; project: string }
  | { kind: "epic"; epic: string; title: string }
  | { kind: "person"; name: string | null; project: string };

/** The Epics area's own chat, by the Jira project it follows. */
export const sprintsChatKey = (project: string) => `${SPRINTS_CHAT}${project}`;

/** An epic's chat, by its Jira key. */
export const epicChatKey = (epic: string) => `${EPIC_CHAT}${epic}`;

/** A person's chat, by the Jira project the Epics area follows and their name ("" for the unassigned). */
export const personChatKey = (project: string, name: string | null) => `${PERSON_CHAT}${project}:${name ?? ""}`;

/** What a chat is about, from its key: a project's sprints, an epic, a person in a project's sprints, or none of these. */
export function sprintChatSubject(
  key: string,
): { kind: "sprints"; project: string } | { kind: "epic"; epic: string } | { kind: "person"; project: string; name: string | null } | null {
  if (key.startsWith(SPRINTS_CHAT)) return key.length > SPRINTS_CHAT.length ? { kind: "sprints", project: key.slice(SPRINTS_CHAT.length) } : null;
  if (key.startsWith(EPIC_CHAT)) return { kind: "epic", epic: key.slice(EPIC_CHAT.length) };
  if (!key.startsWith(PERSON_CHAT)) return null;
  const rest = key.slice(PERSON_CHAT.length);
  const at = rest.indexOf(":");
  if (at < 0) return null;
  return { kind: "person", project: rest.slice(0, at), name: rest.slice(at + 1) || null };
}

const WHICH = ["current", "upcoming"] as const;
const SPRINT_WORD = { current: "current sprint", upcoming: "upcoming sprint" };

/** An issue as a line: its key, status, title and who has it, from its details when they've been read. */
function issueLine(i: SprintEpic["issues"][number], read: StoredEpicChildren | undefined): string {
  const d = read?.issues.find((x) => x.key === i.key);
  const status = d?.status ?? { done: "done", in_progress: "in progress", todo: "to do" }[i.category];
  const who = (d?.assignee ?? i.assignee) || "unassigned";
  const size = sizeOf(i.size ?? d?.size);
  return `- ${i.key} [${status}]${d ? ` ${d.title}` : ""}; ${who}${size ? `; size ${size} (${pointsOf(size)} points)` : ""}${d?.link ? ` ${d.link}` : ""}`;
}

/** A moment as its day, YYYY-MM-DD, in local time. */
function isoDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The Jira project's sprints as the Epics area shows them, for its own chat: for the current sprint
 * and the upcoming one (each that's been read), its dates, how many of its issues are done and in
 * progress, where our pace leads, its epics (the most open work first) with their status, due date and
 * counts and their issues in it, those in no epic, and who has them. Null when neither has been read.
 */
export function sprintsChatText(project: string, sprints: Record<string, StoredSprintEpics>, children: Record<string, StoredEpicChildren>, now = Date.now()): string | null {
  const out: string[] = [`This chat is about the Jira project ${project}'s sprints, as my planner's Epics area shows them now.`];
  let any = false;
  for (const which of WHICH) {
    const sprint = sprints[sprintKey(project, which)];
    if (!sprint) continue;
    any = true;
    out.push("");
    if (!sprint.sprint) {
      out.push(which === "current" ? "No sprint is under way." : "No upcoming sprint is planned yet.");
      continue;
    }
    const s = sprint.sprint;
    const issues = sprintIssues(sprint);
    const done = issues.filter((i) => i.category === "done").length;
    const started = issues.filter((i) => i.category === "in_progress").length;
    const dates = s.start && s.end ? `, ${s.start.slice(0, 10)} to ${s.end.slice(0, 10)}` : "";
    out.push(`The ${SPRINT_WORD[which]}, ${s.name}${dates}: ${issues.length} issues, ${done} done and ${started} in progress.`);
    const p = burndown(sprint, now)?.projection;
    if (p) out.push(p.left > 0 ? `At our pace so far, ${Math.round(p.left)} would be left at its end.` : `At our pace so far, all would be done by ${isoDay(p.at)}.`);
    for (const e of orderEpics(sprint.epics)) {
      const pts = epicPoints(e.sized, e.progress?.total);
      const all = `${e.progress ? `; all its issues ${e.progress.done} of ${e.progress.total} done, ${e.progress.started ?? 0} in progress` : ""}${pts && pts.total ? `; ${pts.done} of its ${pts.total} points done` : ""}`;
      out.push(`Epic ${e.key}, "${e.title}" (${e.status || e.category}${e.due ? `, due ${e.due}` : ", no due date"}${e.assignee ? `, assigned to ${e.assignee}` : ""}${all})${e.link ? ` ${e.link}` : ""}. Its issues in this sprint:`);
      for (const i of e.issues) out.push(issueLine(i, children[e.key]));
    }
    if (sprint.strays?.length) {
      out.push("In no epic:");
      const read = children[listStoreKey(project, which, UNAFFILIATED)];
      for (const i of sprint.strays) out.push(issueLine(i, read));
    }
    const people = sprintPeople(sprint);
    if (people.length)
      out.push(
        `Who has them: ${people.map((x) => `${x.name ?? "unassigned"}, ${x.total} (${x.done} done, ${x.started} in progress)${sprint.size_field ? `, ${x.points.total} points${x.name && x.points.total > OVERLOAD_POINTS ? ", more than one person's sprint" : ""}` : ""}`).join("; ")}`,
      );
    if (sprint.size_field) out.push(`Sizes are T-shirt sizes, in Fibonacci points: XS 1, S 2, M 3, L 5, XL 8, XXL 13. More than ${OVERLOAD_POINTS} points is too much for one person in a sprint.`);
    if (sprint.error) out.push(`Its last read failed: ${sprint.error}`);
  }
  return any ? out.join("\n") : null;
}

/**
 * An epic as the Epics area shows it, for its chat: its title, status, due date and counts, the sprints
 * it has work in, and its issues as last read (those in a sprint marked so). Null when no sprint read
 * has it.
 */
export function epicChatText(epicKey: string, sprints: Record<string, StoredSprintEpics>, children: Record<string, StoredEpicChildren>): string | null {
  const found = Object.entries(sprints).flatMap(([key, s]) => {
    const e = s.epics.find((x) => x.key === epicKey);
    return e ? [{ key, sprint: s, epic: e }] : [];
  });
  if (!found.length) return null;
  const { epic } = found[0];
  const read = children[epicKey];
  const out: string[] = [];
  out.push(`This chat is about the Jira epic ${epic.key}, "${epic.title}"${epic.link ? ` (${epic.link})` : ""}. As my planner's Epics area shows it now:`);
  out.push(`Status: ${epic.status || epic.category}${epic.due ? `; due ${epic.due}` : "; no due date"}${epic.assignee ? `; assigned to ${epic.assignee}` : ""}`);
  if (epic.progress) out.push(`All its issues: ${epic.progress.done} of ${epic.progress.total} done, ${epic.progress.started ?? 0} in progress`);
  for (const f of found) {
    const name = f.sprint.sprint?.name ?? f.key;
    out.push(`In ${name}: ${f.epic.issues.map((i) => i.key).join(", ") || "none of its issues"}`);
  }
  const inSprint = new Set(found.flatMap((f) => f.epic.issues.map((i) => i.key)));
  if (read && !read.error && read.issues.length) {
    out.push(`Its issues, as last read (${read.at}):`);
    for (const d of read.issues) out.push(`- ${d.key} [${d.status}] ${d.title}; ${d.assignee || "unassigned"}${inSprint.has(d.key) ? " (in a sprint shown)" : ""}${d.link ? ` ${d.link}` : ""}`);
  } else out.push("Its issues haven't been read in full yet: read them from Jira (parent = its key) when you need them.");
  return out.join("\n");
}

/**
 * A person's work in the Jira project's sprints, for their chat: for the current sprint and the
 * upcoming one (each that's been read), their issues there and how many are done. Null when neither
 * sprint has any of theirs.
 */
export function personChatText(
  project: string,
  name: string | null,
  sprints: Record<string, StoredSprintEpics>,
  children: Record<string, StoredEpicChildren>,
): string | null {
  const who = name ?? "no one (the unassigned issues)";
  const out: string[] = [`This chat is about ${name ?? "the unassigned issues"} in the Jira project ${project}'s sprints. As my planner's Epics area shows it now:`];
  let any = false;
  for (const which of WHICH) {
    const sprint = sprints[sprintKey(project, which)];
    const mine = personEpic(sprint, personKey(name));
    if (!sprint?.sprint || !mine) continue;
    any = true;
    const p = mine.progress!;
    out.push(`The ${SPRINT_WORD[which]}, ${sprint.sprint.name}: ${p.total} issues for ${who}, ${p.done} done and ${p.started} in progress:`);
    const read = children[listStoreKey(project, which, personKey(name))];
    for (const i of mine.issues) {
      const epic = sprint.epics.find((e) => e.issues.some((x) => x.key === i.key));
      out.push(`${issueLine(i, read)}${epic ? ` (epic ${epic.key}, ${epic.title})` : " (in no epic)"}`);
    }
  }
  return any ? out.join("\n") : null;
}
