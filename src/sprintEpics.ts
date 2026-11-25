import type { EpicChildren, JiraIssueChanged, SprintChoice, SprintEpics } from "./schema";
import { pointsOf, pointsTally, SIZES_READ, type Points } from "./sizes";

/**
 * The Epics area's logic, kept pure so it can be tested: which Jira project it follows, when what it
 * read is old enough to read again, and how its epics and their issues are ordered and split.
 */

/** The setting that holds the Jira project the Epics area follows (its key, e.g. "ABC"). */
export const EPICS_PROJECT_SETTING = "epics_project";

/** Where a sprint is stored, and its job's key after "sprint:". */
export const sprintKey = (project: string, which: SprintChoice) => `${project}:${which}`;

/**
 * A Jira project's key from what was typed: the key itself in any case, or a link into the project (a
 * board's, "/projects/ABC/…", or an issue's, "/browse/ABC-12"). Null when it isn't one.
 */
export function projectKeyFrom(text: string): string | null {
  const t = text.trim();
  const fromLink = t.match(/\/projects\/([A-Za-z][A-Za-z0-9_]+)(?:[/?#]|$)/) ?? t.match(/\/browse\/([A-Za-z][A-Za-z0-9_]+)-\d+/) ?? t.match(/[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]+)-\d+/);
  const key = (fromLink ? fromLink[1] : t).toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,19}$/.test(key) ? key : null;
}

/** How long what was read stands before opening it reads it again: issues move during the day. */
export const STALE_MS = 60 * 60_000;

export const isStale = (at: string | undefined, now = Date.now(), ms = STALE_MS) => !at || !(now - Date.parse(at) < ms);

/** How old a read is before it's read again when Demian reads Jira itself (see jira.ts): it takes a moment and costs nothing. */
export const DIRECT_STALE_MS = 5 * 60_000;

export type SprintEpic = SprintEpics["epics"][number];

/**
 * How much of an epic is done, counting all its issues, not only those in the sprint: the sprint read's
 * count of them, else its issues as last read (only up to a hundred are read; see epicChildrenPrompt).
 * Null when neither has it.
 */
export function epicProgress(epic: SprintEpic, children?: Pick<EpicChildren, "issues" | "error">): { done: number; started: number; total: number } | null {
  if (epic.progress) return { ...epic.progress, started: epic.progress.started ?? 0 };
  if (children && !children.error && children.issues.length) return tally(children.issues);
  return null;
}

/** How many issues there are, how many are done and how many in progress. */
function tally(issues: { category: SprintEpic["category"] }[]): { done: number; started: number; total: number } {
  return { done: issues.filter((i) => i.category === "done").length, started: issues.filter((i) => i.category === "in_progress").length, total: issues.length };
}

/**
 * A sprint read from before it kept what the area now shows (each epic's counts, in progress too; the
 * issues in no epic; who has each issue): read again, whatever its age.
 */
export const oldRead = (
  sprint: { strays?: unknown; sizes_read?: unknown; epics: { progress?: unknown; assignee?: unknown; parents?: unknown; issues: ({ assignee?: unknown } & Record<string, unknown>)[] }[] } | undefined,
) =>
  !!sprint &&
  (sprint.strays === undefined ||
    // From before sizes were read the way they are now.
    sprint.sizes_read !== SIZES_READ ||
    sprint.epics.some(
      (e) =>
        e.progress === undefined ||
        (!!e.progress && typeof e.progress === "object" && !("started" in e.progress)) ||
        e.assignee === undefined ||
        // From before the issues an epic is under were kept, for its breadcrumb.
        e.parents === undefined ||
        e.issues.some((i) => i.assignee === undefined),
    ));

/** Every issue in the sprint, once each (as its epic lists it, when two lists have it): its epics' and those in no epic. */
export function sprintIssues(sprint: Pick<SprintEpics, "epics" | "strays">): SprintEpic["issues"] {
  const issues = new Map<string, SprintEpic["issues"][number]>();
  for (const i of [...sprint.epics.flatMap((e) => e.issues), ...(sprint.strays ?? [])]) if (!issues.has(i.key)) issues.set(i.key, i);
  return [...issues.values()];
}

/**
 * Who has the sprint's issues: each assignee with their avatar, how many of the sprint's issues they
 * have, and how many of those are done and in progress. The most issues first, then by name; the unassigned (name null)
 * last. None for a read from before assignees were kept.
 */
export function sprintPeople(
  sprint: Pick<SprintEpics, "epics" | "strays"> | undefined,
): { name: string | null; avatar: string | null; done: number; started: number; total: number; points: Points }[] {
  if (!sprint) return [];
  const issues = sprintIssues(sprint);
  // A read from before who has each issue was kept (being read again): nothing, rather than everyone unassigned.
  if (issues.some((i) => i.assignee === undefined)) return [];
  const mine = new Map<string | null, SprintEpic["issues"]>();
  for (const i of issues) {
    const name = i.assignee?.trim() || null;
    mine.set(name, [...(mine.get(name) ?? []), i]);
  }
  return [...mine.entries()]
    .map(([name, list]) => ({ name, avatar: list.find((i) => i.avatar)?.avatar ?? null, ...tally(list), points: pointsTally(list) }))
    .sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.points.total - a.points.total || b.total - a.total || (a.name ?? "").localeCompare(b.name ?? ""));
}

/** The Unaffiliated list's key, in place of an epic's: the sprint's issues that aren't in an epic. */
export const UNAFFILIATED = "unaffiliated";

/** A person's list of their issues in the sprint, in place of an epic's key: "person:" and their name ("" for the unassigned). */
export const PERSON = "person:";
export const personKey = (name: string | null) => `${PERSON}${name ?? ""}`;

/** Unaffiliated or a person's list: the sprint's issues, gathered other than by epic, read by their keys. */
export const isGathered = (key: string) => key === UNAFFILIATED || key.startsWith(PERSON);

/**
 * Where a list's issues are kept, beside the epics': an epic's under its key; Unaffiliated's and each
 * person's for each sprint.
 */
export const listStoreKey = (project: string, which: SprintChoice, key: string) => (isGathered(key) ? `${key}@${project}:${which}` : key);

/** A person's issues in the sprint, as a list of their own (see personKey): null when they have none. */
export function personEpic(sprint: Pick<SprintEpics, "epics" | "strays"> | undefined, key: string): SprintEpic | null {
  if (!sprint || !key.startsWith(PERSON)) return null;
  const name = key.slice(PERSON.length) || null;
  const issues = sprintIssues(sprint).filter((i) => (i.assignee?.trim() || null) === name);
  if (!issues.length) return null;
  return {
    key,
    title: name ?? "Unassigned",
    status: null,
    category: "todo",
    link: null,
    assignee: null,
    avatar: null,
    parents: null,
    issues,
    progress: tally(issues),
  };
}

/**
 * The sprint's issues that aren't in an epic, as an epic of their own for the list ("Unaffiliated"),
 * after the epics: its progress is theirs, all of them being in the sprint. Null when there are none.
 */
export function unaffiliatedEpic(sprint: Pick<SprintEpics, "strays"> | undefined): SprintEpic | null {
  const strays = sprint?.strays ?? [];
  if (!strays.length) return null;
  return {
    key: UNAFFILIATED,
    title: "Unaffiliated",
    status: null,
    category: "todo",
    link: null,
    parents: null,
    assignee: null,
    avatar: null,
    issues: strays,
    progress: tally(strays),
  };
}

/**
 * A burndown, a sprint's or an epic's: how many of its issues were left over time, from its start to now,
 * one step down each time one went done, and where our pace so far leads after now (`projection`).
 */
export interface Chart {
  total: number;
  left: number;
  start: number;
  end: number;
  /** Now, or the chart's end once it's over. */
  now: number;
  steps: { at: number; left: number }[];
  projection: { at: number; left: number } | null;
  /** When an even pace leaves none: the sprint's end, or the epic's due date; null for an epic without one. */
  paceTo: number | null;
  /** When our pace would leave none, for an epic not done (as its estimated completion); null otherwise. */
  estimate: number | null;
  /** Its end is that estimate (an epic with no due date, or one running past it), not a date anyone set. */
  endEstimated: boolean;
  /** Whether it counts issues or their points, and in points, how many issues have no size (and count for none). */
  unit: BurndownUnit;
  unsized: number;
}

const DAY_MS = 86_400_000;

/**
 * How many were left over time, from `start` to `until`: one step down as each went done. One done
 * before `start` counts from it, and one done with no date known counts from `until`.
 */
function stepsOf<T extends { category: SprintEpic["category"]; done_at?: string | null }>(issues: T[], start: number, until: number, weight: (i: T) => number = () => 1) {
  const doneAt = issues
    .filter((i) => i.category === "done")
    .map((i) => {
      const at = Date.parse(i.done_at ?? "");
      return { at: Number.isNaN(at) ? until : Math.max(start, Math.min(at, until)), w: weight(i) };
    })
    .sort((a, b) => a.at - b.at);
  const total = issues.reduce((n, i) => n + weight(i), 0);
  let left = total - doneAt.filter((d) => d.at <= start).reduce((n, d) => n + d.w, 0);
  const steps = [{ at: start, left }];
  for (const { at, w } of doneAt.filter((d) => d.at > start)) {
    if (!w) continue;
    left -= w;
    if (steps[steps.length - 1].at === at) steps[steps.length - 1].left = left;
    else steps.push({ at, left });
  }
  if (steps[steps.length - 1].at < until) steps.push({ at: until, left });
  // Our pace: how many went done since the start, over the time since.
  const perMs = until > start ? (steps[0].left - left) / (until - start) : 0;
  return { steps, left, total, perMs, lastDone: doneAt.at(-1)?.at ?? start };
}

/** What a burndown counts: issues, or their points (see sizes.ts). */
export type BurndownUnit = "tickets" | "points";

/** How much an issue counts for in a burndown of that unit: one ticket, or its points (none without a size). */
const weightFor = (unit: BurndownUnit) => (i: { size?: string | null }) => (unit === "points" ? (pointsOf(i.size) ?? 0) : 1);

/**
 * The sprint's burndown, by issues: how many of its issues were left over its days, from its start to
 * now (or its end, once it's over). And, while it runs, where our pace so far leads: how many would be
 * left at its end, or when none would be, whichever comes first. `only`: some of the sprint's issues
 * instead of all of them (Unaffiliated's, or a person's), over the same dates. Null for a sprint without
 * both dates, one that hasn't begun, or none of the issues.
 */
export function burndown(
  sprint: Pick<SprintEpics, "sprint" | "epics" | "strays"> | undefined,
  now = Date.now(),
  only?: SprintEpic["issues"],
  unit: BurndownUnit = "tickets",
): Chart | null {
  const start = Date.parse(sprint?.sprint?.start ?? "");
  const end = Date.parse(sprint?.sprint?.end ?? "");
  if (!sprint || !(start < end) || now < start) return null;
  const issues = only ?? sprintIssues(sprint);
  const until = Math.min(now, end);
  const { steps, left, total, perMs } = stepsOf(issues, start, until, weightFor(unit));
  if (!total) return null;
  let projection: { at: number; left: number } | null = null;
  if (until < end) {
    const zeroAt = perMs > 0 ? until + left / perMs : Infinity;
    projection = zeroAt <= end ? { at: zeroAt, left: 0 } : { at: end, left: Math.max(0, left - perMs * (end - until)) };
  }
  const unsized = unit === "points" ? issues.filter((i) => pointsOf(i.size) === null).length : 0;
  return { total, left, start, end, now: until, steps, projection, paceTo: end, estimate: null, endEstimated: false, unit, unsized };
}

/** A YYYY-MM-DD date's last moment, in local time; null when it isn't one. */
function endOfDay(date: string | null | undefined): number | null {
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime() : null;
}

/**
 * An epic's burndown over its life, from its first issue's creation: all its issues, one step down as
 * each went done (see stepsOf). An even pace from all of them at its start to none on its due date. Our
 * pace so far carried on from now: when it would leave none is its estimated completion. The chart runs
 * to its due date, or on to that estimate when it's later (or, with no due date, to the estimate alone),
 * though never further ahead than twice its life so far (and at least two weeks). Null with no issues,
 * or with none whose creation is known (read before it was kept).
 */
export function epicBurndown(
  issues: { category: SprintEpic["category"]; created?: string | null; done_at?: string | null; size?: string | null }[],
  due: string | null | undefined,
  now = Date.now(),
  unit: BurndownUnit = "tickets",
): Chart | null {
  const created = issues.map((i) => Date.parse(i.created ?? "")).filter((t) => !Number.isNaN(t));
  if (!issues.length || !created.length) return null;
  const start = Math.min(...created);
  if (now <= start) return null;
  const { steps, left, total, perMs, lastDone } = stepsOf(issues, start, now, weightFor(unit));
  if (!total) return null;
  const dueEnd = endOfDay(due);
  const zeroAt = left === 0 ? lastDone : perMs > 0 ? now + left / perMs : Infinity;
  const horizon = now + Math.max(2 * (now - start), 14 * DAY_MS);
  const ahead = Math.min(zeroAt, horizon);
  const end =
    left === 0
      ? Math.max(now, dueEnd ?? now)
      : dueEnd !== null
        ? Math.max(dueEnd, Number.isFinite(ahead) ? ahead : dueEnd, now + DAY_MS)
        : Number.isFinite(zeroAt) && zeroAt <= horizon
          ? zeroAt
          : now + Math.max((now - start) / 4, 7 * DAY_MS);
  const projection = left > 0 ? (zeroAt <= end ? { at: zeroAt, left: 0 } : { at: end, left: Math.max(0, left - perMs * (end - now)) }) : null;
  return {
    total,
    left,
    start,
    end,
    now,
    steps,
    projection,
    paceTo: dueEnd,
    estimate: left > 0 && Number.isFinite(zeroAt) && zeroAt <= horizon ? zeroAt : null,
    endEstimated: left > 0 && Number.isFinite(zeroAt) && end === zeroAt,
    unit,
    unsized: unit === "points" ? issues.filter((i) => pointsOf(i.size) === null).length : 0,
  };
}

/** How many issues the burndown has left at a time: as they were, up to now; along the projection, after. */
export function leftAt(b: Chart, t: number): number {
  if (t <= b.now || !b.projection) return b.steps.filter((s) => s.at <= t).at(-1)?.left ?? b.total;
  if (t >= b.projection.at) return b.projection.left;
  return b.left + ((b.projection.left - b.left) * (t - b.now)) / (b.projection.at - b.now);
}

/** Jira keys in number order: ABC-9 before ABC-10. */
function byKey(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * The sprint's epics, the most work in the sprint first: by its issues there that aren't done, then all
 * its issues there, then by key. Done epics go last.
 */
export function orderEpics(epics: SprintEpic[]): SprintEpic[] {
  const open = (e: SprintEpic) => e.issues.filter((i) => i.category !== "done").length;
  return [...epics].sort((a, b) => Number(a.category === "done") - Number(b.category === "done") || open(b) - open(a) || b.issues.length - a.issues.length || byKey(a.key, b.key));
}

type Issue = EpicChildren["issues"][number];

const CATEGORY_ORDER: Record<Issue["category"], number> = { in_progress: 0, todo: 1, done: 2 };

/**
 * An epic's issues, split into those in the sprint shown and the rest of the epic, each in progress
 * first, then to do, then done (Jira's order within each). An issue the sprint lists that the epic's
 * read doesn't have (moved since) isn't shown.
 */
export function splitIssues(issues: Issue[], inSprint: Set<string>): { sprint: Issue[]; rest: Issue[] } {
  const ordered = issues.map((issue, i) => ({ issue, i })).sort((a, b) => CATEGORY_ORDER[a.issue.category] - CATEGORY_ORDER[b.issue.category] || a.i - b.i).map((x) => x.issue);
  return { sprint: ordered.filter((i) => inSprint.has(i.key)), rest: ordered.filter((i) => !inSprint.has(i.key)) };
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * An epic's due date for its card ("Due Dec 12", from Jira's YYYY-MM-DD in local time), and whether it's
 * past due: the day gone and the epic not done. Null without a date.
 */
export function dueText(due: string | null | undefined, category: SprintEpic["category"], now = new Date()): { text: string; late: boolean } | null {
  const m = due?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sameYear = day.getFullYear() === now.getFullYear();
  const text = day.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return { text: `Due ${text}`, late: category !== "done" && day < today };
}

/** A sprint's number from its name ("24" from "Payments 2026 Sprint 24"): the last number in it, or null. */
export function sprintNumber(name: string | null | undefined): string | null {
  return name?.match(/(\d+)\D*$/)?.[1] ?? null;
}

/** A sprint's dates as "Nov 22 – Dec 7", "From Nov 22" or "Until Dec 7", in local time; null with neither. */
export function sprintDates(start: string | null | undefined, end: string | null | undefined): string | null {
  const ok = (d: string | null | undefined): d is string => !!d && !Number.isNaN(Date.parse(d));
  if (ok(start) && ok(end)) return `${day(start)} – ${day(end)}`;
  if (ok(start)) return `From ${day(start)}`;
  if (ok(end)) return `Until ${day(end)}`;
  return null;
}

/** A Jira issue as a change the user applied left it, and where it was before (see changeJiraIssue). */
export type ChangedIssue = NonNullable<JiraIssueChanged["issue"]>;
type Before = JiraIssueChanged["before"];
type Category = SprintEpic["category"];

/** An epic's counts with one issue of a category taken out (-1) or put in (+1). */
function recount(p: SprintEpic["progress"], category: Category, by: 1 | -1): SprintEpic["progress"] {
  if (!p) return p;
  return {
    total: Math.max(0, p.total + by),
    done: Math.max(0, p.done + (category === "done" ? by : 0)),
    started: Math.max(0, (p.started ?? 0) + (category === "in_progress" ? by : 0)),
  };
}

/**
 * A sprint read with one issue as a change left it, so the Epics area shows the change without reading
 * the sprint again: an epic's own fields, when it's one of the read's epics; otherwise the issue's
 * category and assignee where it's listed (its size kept), its epics' counts (out of the one it left, into the one it
 * joined), and whether it's listed at all (in the sprint, under its epic, or in no epic). `moved`: whether
 * the change moved it to another epic or sprint; when it didn't, it stays where the read has it. The
 * read as it was when the change doesn't touch it; null when it can't be brought up to date (the issue
 * joined this sprint, or an epic the read doesn't have, without knowing where it was before, or joined
 * a sprint whose sizes are read, its own unknown): read it again.
 */
export function sprintWithChange<T extends Pick<SprintEpics, "sprint" | "epics" | "strays" | "unparented"> & { size_field?: string | null }>(
  read: T,
  before: Before,
  issue: ChangedIssue,
  moved: { epic: boolean; sprint: boolean },
  now: string,
): T | null {
  if (read.epics.some((e) => e.key === issue.key))
    return {
      ...read,
      epics: read.epics.map((e) =>
        e.key === issue.key ? { ...e, title: issue.title ?? e.title, status: issue.status ?? e.status, category: issue.category, due: issue.due, assignee: issue.assignee, avatar: issue.avatar } : e,
      ),
    };
  const strays = read.strays ?? [];
  const found = [...read.epics.flatMap((e) => e.issues), ...strays].find((i) => i.key === issue.key);
  const foundIn = found ? (read.epics.find((e) => e.issues.some((i) => i.key === issue.key))?.key ?? null) : null;
  const was = found ? { category: found.category, epic: foundIn } : before;
  const name = read.sprint?.name;
  // Unmoved, it stays where it was (whatever the read back says of its sprints and epic).
  const inSprint = moved.sprint ? !!name && issue.sprints.includes(name) : !!found;
  const epic = moved.epic ? issue.epic : was ? was.epic : issue.epic;
  const touches = !!found || inSprint || read.epics.some((e) => e.key === epic || e.key === was?.epic);
  if (!touches) return read;
  if (!was) return null;
  // Where it's listed now: in its epic's issues, or in no epic's; nowhere once it's out of the sprint.
  if (inSprint && epic && !read.epics.some((e) => e.key === epic)) return null;
  // Joining a sprint whose points are counted: its size isn't known here.
  if (inSprint && !found && read.size_field) return null;
  const entry = {
    key: issue.key,
    category: issue.category,
    done_at: issue.category === "done" ? (found?.category === "done" ? (found.done_at ?? now) : now) : null,
    assignee: issue.assignee,
    avatar: issue.avatar,
    type: issue.type,
    size: found?.size ?? null,
  };
  let placed = false;
  const place = (list: SprintEpic["issues"], here: boolean) => {
    const out = list.flatMap((i) => (i.key !== issue.key ? [i] : here && inSprint ? [entry] : []));
    if (here && inSprint && !out.some((i) => i.key === issue.key)) out.push(entry);
    if (here && inSprint) placed = true;
    return out;
  };
  const epics = read.epics.map((e) => {
    let progress = e.progress;
    if (e.key === was.epic) progress = recount(progress, was.category, -1);
    if (e.key === epic) progress = recount(progress, issue.category, 1);
    return { ...e, progress, issues: place(e.issues, e.key === epic) };
  });
  const nextStrays = place(strays, epic === null);
  if (inSprint && !placed) return null;
  return { ...read, epics, strays: nextStrays, unparented: nextStrays.length };
}

/**
 * The reads of epics' issues (and of a person's or Unaffiliated's) that a change touched, brought up to
 * date: the issue's status, category, assignee and due date where it's listed; out of the epic it left and into
 * the one it joined (when `movedEpic`). Only those it changed, by store key. An issue added to an epic's
 * list has no creation date, so that epic's issues are read again for its burndown when it's next shown.
 */
export function childrenWithChange(reads: Record<string, StoredChildren>, issue: ChangedIssue, movedEpic: boolean, now: string): Record<string, StoredChildren> {
  const out: Record<string, StoredChildren> = {};
  const updated = (i: StoredChildren["issues"][number]) => ({
    ...i,
    title: issue.title ?? i.title,
    status: issue.status ?? i.status,
    category: issue.category,
    type: issue.type ?? i.type,
    assignee: issue.assignee,
    avatar: issue.avatar,
    due: issue.due,
    done_at: issue.category === "done" ? (i.category === "done" ? (i.done_at ?? now) : now) : null,
  });
  for (const [key, read] of Object.entries(reads)) {
    if (read.error) continue;
    const has = read.issues.some((i) => i.key === issue.key);
    if (isGathered(key.split("@")[0]) || !movedEpic) {
      if (has) out[key] = { ...read, issues: read.issues.map((i) => (i.key === issue.key ? updated(i) : i)) };
    } else if (key === issue.epic) {
      out[key] = has
        ? { ...read, issues: read.issues.map((i) => (i.key === issue.key ? updated(i) : i)) }
        : { ...read, issues: [...read.issues, { key: issue.key, title: issue.title ?? issue.key, status: issue.status ?? "", category: issue.category, type: issue.type, assignee: issue.assignee, avatar: issue.avatar, due: issue.due, link: issue.link, done_at: issue.category === "done" ? now : null }] };
    } else if (has) out[key] = { ...read, issues: read.issues.filter((i) => i.key !== issue.key) };
  }
  return out;
}

type StoredChildren = Pick<EpicChildren, "issues" | "error"> & { at: string };

