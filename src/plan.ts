/**
 * A project's path to ship as a plan, the way Jira's plan view lays work out: its epics in order, each
 * with its issues, who's on them and how they stand, and a timeline of when each epic runs. Pure
 * helpers for the view (see PlanView).
 */

import { normalizeMap } from "./projectMap";
import type { MapItem, MapLink, PathInitiative, PathItem, PathStep, PathToShip, ProjectMap } from "./schema";

const DAY = 86_400_000;
/** How long an epic is taken to run when only one end of it is known: four weeks (epics take two to six). */
export const EPIC_DAYS = 28;
/** How far before today the timeline reaches back, at most. */
const BACK_DAYS = 42;
/** How far past today it reaches, at most. */
const AHEAD_DAYS = 26 * 7;

/** A YYYY-MM-DD date as a day number (days since 1970-01-01, UTC); null when it isn't one. */
export function dayOf(date: string | null | undefined): number | null {
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(t) ? null : Math.round(t / DAY);
}

/** A day number as a short date in the user's locale: "Nov 17". */
export function dayLabel(day: number): string {
  return new Date(day * DAY).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Today as a day number, in the user's time zone. */
export function today(now = new Date()): number {
  return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY);
}

/**
 * When an epic runs: from its start to its target date. With only one of them, it's taken to run four
 * weeks (assumed, drawn lighter); with neither, its issues' due dates end it. Null when nothing dates it.
 */
export function epicSpan(step: Pick<PathStep, "start" | "date" | "items">): { start: number; end: number; assumed: boolean } | null {
  const start = dayOf(step.start);
  const due = dayOf(step.date) ?? Math.max(...(step.items ?? []).map((i) => dayOf(i.date) ?? -Infinity));
  const end = Number.isFinite(due) ? due : null;
  if (start !== null && end !== null) return end >= start ? { start, end, assumed: false } : { start: end, end: start, assumed: false };
  if (end !== null) return { start: end - EPIC_DAYS + 1, end, assumed: true };
  if (start !== null) return { start, end: start + EPIC_DAYS - 1, assumed: true };
  return null;
}

/** How many of an epic's issues are done, of how many it lists. */
export function epicProgress(step: Pick<PathStep, "items">): { done: number; total: number } {
  const items = step.items ?? [];
  return { done: items.filter((i) => i.status === "done").length, total: items.length };
}

/** The people on an epic: its owners, then whoever its open issues are assigned to, each once. */
export function epicPeople(step: Pick<PathStep, "owners" | "items">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...step.owners, ...(step.items ?? []).filter((i) => i.status !== "done").map((i) => i.assignee ?? "")]) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name.trim());
  }
  return out;
}

export interface Timeline {
  /** The first and last day it shows. */
  from: number;
  to: number;
  /** Where its date labels go. */
  ticks: { day: number; label: string }[];
  today: number;
  /** The ship date, when it's on the timeline. */
  ship: number | null;
}

/**
 * The span the plan's timeline covers: every epic's run, today and the ship date, with a little room
 * either side, reaching back six weeks at most (older work runs off its left edge) and ahead six
 * months. Labeled on Mondays, a week or more apart so about four labels fit. Null when nothing is dated.
 */
export function planTimeline(steps: Pick<PathStep, "start" | "date" | "items">[], shipDate: string | null | undefined, now = today()): Timeline | null {
  const spans = steps.map(epicSpan).filter((s): s is NonNullable<typeof s> => !!s);
  const ship = dayOf(shipDate);
  if (!spans.length && ship === null) return null;
  const first = Math.min(now, ...spans.map((s) => s.start));
  const last = Math.max(now + 14, ship ?? -Infinity, ...spans.map((s) => s.end));
  const from = Math.max(first, now - BACK_DAYS) - 2;
  const to = Math.min(last, now + AHEAD_DAYS) + 3;
  // The timeline column is narrow: about four labels at most.
  const weeks = (to - from) / 7;
  const step = weeks <= 4 ? 7 : weeks <= 8 ? 14 : weeks <= 16 ? 28 : 56;
  // Labels on Mondays (day 4 was a Monday: 1970-01-05).
  const firstMonday = from + ((4 - from) % 7 + 7) % 7;
  const ticks: Timeline["ticks"] = [];
  for (let d = firstMonday; d <= to - 2; d += step) ticks.push({ day: d, label: dayLabel(d) });
  return { from, to, ticks, today: now, ship: ship !== null && ship >= from && ship <= to ? ship : null };
}

/** Where a day falls on the timeline, as a percentage of its width (clamped to it). */
export function at(t: Pick<Timeline, "from" | "to">, day: number): number {
  return Math.min(100, Math.max(0, ((day - t.from) / (t.to - t.from + 1)) * 100));
}

/** An issue's label in the key column: its Jira key, or that no ticket covers it yet. */
export const itemKey = (item: Pick<PathItem, "key">) => item.key?.trim() || null;

/**
 * Where each of the guiding doc's requirements goes in the plan: under the story or task that delivers
 * it, else its epic, else its initiative, each in one place only (the first one named). Ids the doc no longer has are
 * dropped; the rest, which no epic covers, are left over.
 */
export function placeRequirements(
  steps: Pick<PathStep, "requirements" | "items">[],
  ids: string[],
  initiatives: Pick<PathInitiative, "id" | "requirements">[] = [],
): { byStep: Map<number, string[]>; byItem: Map<string, string[]>; byInitiative: Map<string, string[]>; rest: string[] } {
  const known = new Set(ids);
  const placed = new Set<string>();
  const take = (list: string[] | undefined) => (list ?? []).filter((id) => known.has(id) && !placed.has(id) && (placed.add(id), true));
  const byStep = new Map<number, string[]>();
  const byItem = new Map<string, string[]>();
  const byInitiative = new Map<string, string[]>();
  steps.forEach((s, i) => {
    (s.items ?? []).forEach((item, j) => {
      const mine = take(item.requirements);
      if (mine.length) byItem.set(`${i}:${j}`, mine);
    });
    const own = take(s.requirements);
    if (own.length) byStep.set(i, own);
  });
  for (const init of initiatives) {
    const own = take(init.requirements);
    if (own.length) byInitiative.set(init.id, own);
  }
  return { byStep, byItem, byInitiative, rest: ids.filter((id) => !placed.has(id)) };
}

/**
 * The guiding doc's requirements a plan leaves out, in the doc's order: on no story, task, epic or
 * initiative of it, and not descoped. Every other one belongs somewhere in it.
 */
export function unplacedRequirements(
  path: { steps: Pick<PathStep, "requirements" | "items">[]; initiatives?: Pick<PathInitiative, "id" | "requirements">[] } | null | undefined,
  ids: string[],
  descoped: Iterable<string> = [],
): string[] {
  const out = new Set(descoped);
  return placeRequirements(path?.steps ?? [], ids, path?.initiatives ?? []).rest.filter((id) => !out.has(id));
}

/**
 * The plan with each requirement it left out (see unplacedRequirements) in the epic that holds the
 * most of the rest of its section of the doc (the first of them on a tie), as a story that epic
 * proposes for it (see PathStep.requirements). One whose section no epic has stays out: better in no
 * epic, where the plan says it wasn't placed, than in the wrong one.
 */
export function placeLeftovers<P extends { steps: PathStep[]; initiatives?: Pick<PathInitiative, "id" | "requirements">[] }>(
  path: P,
  requirements: { id: string; section?: string | null }[],
  descoped: Iterable<string> = [],
): P {
  const left = unplacedRequirements(path, requirements.map((r) => r.id), descoped);
  if (!left.length) return path;
  const section = new Map(requirements.map((r) => [r.id, r.section?.trim().toLowerCase() || null]));
  const onStep = path.steps.map((s) => [...(s.requirements ?? []), ...(s.items ?? []).flatMap((i) => i.requirements ?? [])]);
  const extra = new Map<number, string[]>();
  for (const id of left) {
    const own = section.get(id);
    if (!own) continue;
    let best = -1;
    let most = 0;
    onStep.forEach((ids, i) => {
      const n = ids.filter((other) => section.get(other) === own).length;
      if (n > most) [best, most] = [i, n];
    });
    if (best >= 0) extra.set(best, [...(extra.get(best) ?? []), id]);
  }
  if (!extra.size) return path;
  return { ...path, steps: path.steps.map((s, i) => (extra.has(i) ? { ...s, requirements: [...(s.requirements ?? []), ...extra.get(i)!] } : s)) };
}

/** The Jira projects an epic could go in: its stories' projects, most of them first, then the project's other epics'. */
export function epicProjectKeys(step: Pick<PathStep, "items">, otherEpicKeys: string[]): string[] {
  const prefix = (key: string | null | undefined) => key?.match(/^([A-Z][A-Z0-9_]+)-\d+$/)?.[1] ?? null;
  const counts = new Map<string, number>();
  for (const i of step.items ?? []) {
    const p = prefix(i.key);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const fromItems = [...counts].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  return [...new Set([...fromItems, ...otherEpicKeys.map(prefix).filter((p): p is string => !!p)])];
}

/**
 * A proposed epic's description for Jira, for the user to review: what it delivers, its stories and
 * tasks (with their keys, or that no ticket covers them yet), and the requirements it delivers.
 */
export function epicDescription(step: Pick<PathStep, "summary" | "items">, requirements: string[], doc: string | null): string {
  const parts = [step.summary?.trim() ?? ""];
  const items = step.items ?? [];
  if (items.length) parts.push(`Stories and tasks:\n${items.map((i) => `- ${i.key ? `${i.key} ` : ""}${i.title}${i.key ? "" : ` (${(i.type || "task").toLowerCase()}, no ticket yet)`}`).join("\n")}`);
  if (requirements.length) parts.push(`Requirements it delivers${doc ? ` (from ${doc})` : ""}:\n${requirements.map((r) => `- ${r}`).join("\n")}`);
  return parts.filter(Boolean).join("\n\n");
}

type Path = Pick<PathToShip, "steps"> & { initiatives?: PathInitiative[]; created?: PathToShip["created"] };

/**
 * The path once a proposed epic is in Jira: the step of that name that has no epic yet takes the new
 * one's key, link and name, and the stories moved into it are under it in Jira now. Nothing else
 * changes; the next refresh reads it all from Jira.
 */
export function withEpicCreated<P extends Path>(path: P, what: string, epic: { key: string; link: string | null }, title: string, moved: string[] = []): P {
  let done = false;
  const steps = path.steps.map((s) => {
    if (done || s.epic || s.what !== what) return s;
    done = true;
    return { ...s, epic, what: title, items: inEpic(s.items, moved, epic.key) };
  });
  return { ...path, steps };
}

/**
 * A proposed story or task's description for Jira, for the user to review: the epic it's part of, and
 * the requirements it delivers.
 */
export function itemDescription(step: Pick<PathStep, "what" | "epic"> | null, requirements: string[], doc: string | null, code: string[] = []): string {
  const parts = step ? [`Part of ${step.epic ? `${step.epic.key}, ` : ""}${step.what}.`] : [];
  if (requirements.length) parts.push(`Requirements it delivers${doc ? ` (from ${doc})` : ""}:\n${requirements.map((r) => `- ${r}`).join("\n")}`);
  if (code.length) parts.push(`Pull requests and branches:\n${code.map((url) => `- ${url}`).join("\n")}`);
  return parts.join("\n\n");
}

/**
 * The path once a proposed story or task is in Jira: the work with no ticket of that id (by its title,
 * for a path from before ids) takes the new ticket's key and link, in its epic when it went in one.
 * The code it was proposed for that its description kept is linked from the ticket now.
 */
export function withItemCreated<P extends Path>(
  path: P,
  which: { id?: string | null; title: string },
  ticket: { key: string; link: string | null },
  parent: string | null,
  description = "",
): P {
  let done = false;
  const steps = path.steps.map((s) => ({
    ...s,
    items: (s.items ?? []).map((i) => {
      if (done || i.key || !(which.id ? i.id === which.id : i.title === which.title)) return i;
      done = true;
      const linked = (i.suggested_code ?? []).filter((url) => description.includes(url));
      return {
        ...i,
        key: ticket.key,
        link: ticket.link ?? i.link,
        jira_parent: parent,
        code: [...(i.code ?? []), ...linked],
        suggested_code: (i.suggested_code ?? []).filter((url) => !linked.includes(url)),
      };
    }),
  }));
  return { ...path, steps };
}

/**
 * The path once the story proposed for a requirement no issue delivered is in Jira: it's one of its
 * epic's stories now (the epic of that name), delivering the requirement, which the epic no longer
 * holds itself. With no epic on the plan (or none of that name any more), the ticket is kept in
 * `created`, so the plan shows it in the proposal's place until a refresh places it.
 */
export function withRequirementIssue<P extends Path>(
  path: P,
  stepWhat: string | null,
  requirement: string,
  ticket: { key: string; link: string | null; title: string; type: string; parent: string | null },
): P {
  let done = false;
  const steps = path.steps.map((s) => {
    if (done || stepWhat === null || s.what !== stepWhat) return s;
    done = true;
    const item = { key: ticket.key, title: ticket.title, type: ticket.type, status: "next" as const, assignee: null, date: null, link: ticket.link, requirements: [requirement], jira_parent: ticket.parent, realign: null, id: null, waits_on: [], code: [], suggested_code: [] };
    return { ...s, items: [...(s.items ?? []), item], requirements: (s.requirements ?? []).filter((id) => id !== requirement) };
  });
  if (done) return { ...path, steps };
  return { ...path, created: [...(path.created ?? []).filter((c) => c.requirement !== requirement), { requirement, key: ticket.key, link: ticket.link, title: ticket.title, type: ticket.type }] };
}

/** Items whose keys are in `moved`, now under `epic` in Jira. */
const inEpic = (items: PathItem[] | undefined, moved: string[], epic: string) => (items ?? []).map((i) => (i.key && moved.includes(i.key) ? { ...i, jira_parent: epic } : i));

/**
 * The path once an initiative is in Jira: it has its Jira key (and isn't an epic to realign any more),
 * the epics created under it have theirs (by name), and what moved is under its new parent.
 */
export function withInitiativeApplied<P extends Path>(
  path: P,
  id: string,
  initiative: { key: string; link: string | null },
  created: { name: string; key: string; link?: string | null }[],
  moved: string[],
): P {
  const initiatives = (path.initiatives ?? []).map((i) => (i.id === id ? { ...i, jira: initiative, realign: null } : i));
  const steps = path.steps.map((s) => {
    if (s.initiative !== id) return s;
    const made = !s.epic ? created.find((c) => c.name.trim().toLowerCase() === s.what.trim().toLowerCase()) : null;
    const epic = made ? { key: made.key, link: made.link ?? null } : s.epic;
    return { ...s, epic, items: epic ? inEpic(s.items, moved, epic.key) : s.items };
  });
  return { ...path, initiatives, steps };
}

/** The path once a story-sized epic is a story in Jira: its item is a plain story, under its epic, keyed as Jira has it now. */
export function withStoryApplied<P extends Path>(path: P, epicKey: string, story: { key: string; link: string | null }, into: string): P {
  const steps = path.steps.map((s) => ({
    ...s,
    items: (s.items ?? []).map((i) => (i.key === epicKey && i.realign ? { ...i, key: story.key, link: story.link ?? i.link, realign: null, jira_parent: into } : i)),
  }));
  return { ...path, steps };
}

/** The path once an issue is moved into the epic the plan puts it in. */
export function withItemMoved<P extends Path>(path: P, key: string, into: string): P {
  return { ...path, steps: path.steps.map((s) => (s.epic?.key === into ? { ...s, items: inEpic(s.items, [key], into) } : s)) };
}

/**
 * Where an issue would move from, when the plan puts it somewhere other than Jira has it: the epic
 * it's in now (null for none). Undefined when it's where Jira has it, has no ticket, or it's a
 * story-sized epic (that's a change of its own), or for a path from before Demian knew.
 */
export function proposedMove(item: Pick<PathItem, "key" | "jira_parent" | "realign">, step: Pick<PathStep, "epic">): string | null | undefined {
  if (!item.key || item.realign || item.jira_parent === undefined) return undefined;
  const here = step.epic?.key ?? null;
  if (here && item.jira_parent === here) return undefined;
  return item.jira_parent ?? null;
}

/**
 * The Jira keys a pull request or branch names, in its title or branch name ("pay-7772-fix" names
 * PAY-7772). A key may sit against underscores ("xy_pay-7772_fix"), so it's bounded by what can't
 * continue it rather than by word boundaries, which count "_" as part of a word.
 */
export function keysIn(text: string): string[] {
  return [...new Set(text.toUpperCase().match(/(?<![A-Z0-9])[A-Z][A-Z0-9]+-\d+(?!\d)/g) ?? [])];
}

/**
 * A GitHub pull request's or branch's link, as what it points at: "pr:owner/repo#12" or
 * "branch:owner/repo:name" (as tracking names them), whatever else the URL has after it. Null for
 * any other link.
 */
export function codeLink(url: string): { id: string; kind: "pr" | "branch"; repo: string; name: string } | null {
  const m = url.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|tree)\/([^\s?#]+)/i);
  if (!m) return null;
  const repo = `${m[1]}/${m[2].replace(/\.git$/i, "")}`.toLowerCase();
  if (m[3].toLowerCase() === "pull") {
    const n = m[4].match(/^\d+/)?.[0];
    return n ? { id: `pr:${repo}#${n}`, kind: "pr", repo, name: `#${n}` } : null;
  }
  let name = m[4].replace(/\/+$/, "");
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded after all: the name as it is.
  }
  return { id: `branch:${repo}:${name}`, kind: "branch", repo, name };
}

/**
 * A pull request or branch where the plan puts it, and why: "linked" when the ticket links it itself
 * (see PathItem.code); else only suggested, "named" by the ticket's key in its title or branch, or
 * "found" by the refresh as this work (see PathItem.suggested_code).
 */
export interface PlacedMark<T> {
  code: T;
  tie: "linked" | "named" | "found";
}

/** Pull requests and branches by the work in the plan they're for (see placeCode). */
export interface PlacedCode<T> {
  byItem: Map<string, PlacedMark<T>[]>;
  byStep: Map<number, PlacedMark<T>[]>;
  byInitiative: Map<string, PlacedMark<T>[]>;
  rest: T[];
}

type CodePlace = { item: string } | { step: number } | { initiative: string };

/**
 * Where each pull request or branch goes in the plan: with the ticket that links it itself (linked),
 * else under the first Jira key it names that's on the plan (named): that story or task ("i:j", the
 * j-th under the i-th epic), else that epic, else that initiative; else with the work the refresh
 * found it's for (found). The rest aren't this project's work: left over. With `fromLink`, a link no
 * tracked one matches (a repo not read yet, say) is shown from its link alone.
 */
export function placeCode<T extends { title: string; detail?: string | null; url?: string | null }>(path: Path, code: T[], fromLink?: (url: string) => T): PlacedCode<T> {
  const where = new Map<string, CodePlace>();
  const linkedAt = new Map<string, { at: CodePlace; url: string }>();
  const foundAt = new Map<string, { at: CodePlace; url: string }>();
  const link = (into: typeof linkedAt, urls: string[] | undefined, at: CodePlace) => {
    for (const url of urls ?? []) {
      const id = codeLink(url)?.id;
      if (id && !into.has(id)) into.set(id, { at, url });
    }
  };
  path.steps.forEach((s, i) => {
    (s.items ?? []).forEach((it, j) => {
      const key = itemKey(it);
      if (key && !where.has(key.toUpperCase())) where.set(key.toUpperCase(), { item: `${i}:${j}` });
      link(linkedAt, it.code, { item: `${i}:${j}` });
      link(foundAt, it.suggested_code, { item: `${i}:${j}` });
    });
  });
  path.steps.forEach((s, i) => {
    if (s.epic && !where.has(s.epic.key.toUpperCase())) where.set(s.epic.key.toUpperCase(), { step: i });
    link(linkedAt, s.code, { step: i });
  });
  for (const init of path.initiatives ?? []) if (init.jira && !where.has(init.jira.key.toUpperCase())) where.set(init.jira.key.toUpperCase(), { initiative: init.id });
  const out: PlacedCode<T> = { byItem: new Map(), byStep: new Map(), byInitiative: new Map(), rest: [] };
  const add = (at: CodePlace, mark: PlacedMark<T>) => {
    const put = <K>(map: Map<K, PlacedMark<T>[]>, key: K) => map.set(key, [...(map.get(key) ?? []), mark]);
    if ("item" in at) put(out.byItem, at.item);
    else if ("step" in at) put(out.byStep, at.step);
    else put(out.byInitiative, at.initiative);
  };
  const shown = new Set<string>();
  for (const c of code) {
    const id = c.url ? codeLink(c.url)?.id : undefined;
    if (id) shown.add(id);
    const linked = id ? linkedAt.get(id) : undefined;
    const named = keysIn(`${c.title} ${c.detail ?? ""}`)
      .map((k) => where.get(k))
      .find(Boolean);
    const found = id ? foundAt.get(id) : undefined;
    if (linked) add(linked.at, { code: c, tie: "linked" });
    else if (named) add(named, { code: c, tie: "named" });
    else if (found) add(found.at, { code: c, tie: "found" });
    else out.rest.push(c);
  }
  if (fromLink) {
    for (const [id, { at, url }] of linkedAt) if (!shown.has(id)) (shown.add(id), add(at, { code: fromLink(url), tie: "linked" }));
    for (const [id, { at, url }] of foundAt) if (!shown.has(id)) (shown.add(id), add(at, { code: fromLink(url), tie: "found" }));
  }
  return out;
}

/**
 * What a project's code is (see CodeScope in tracking): the Jira keys on its plan and of its epics
 * (and a workstream's epics' issues), and the pull request and branch links its plan has.
 */
export function codeScope(path: Path | null | undefined, epics: { key: string; issues?: string[] | null }[] = []): { keys: string[]; links: string[] } {
  const keys = new Set<string>();
  const links = new Set<string>();
  const key = (k: string | null | undefined) => {
    if (k?.trim()) keys.add(k.trim().toUpperCase());
  };
  for (const s of path?.steps ?? []) {
    key(s.epic?.key);
    for (const url of s.code ?? []) links.add(url);
    for (const i of s.items ?? []) {
      key(itemKey(i));
      for (const url of [...(i.code ?? []), ...(i.suggested_code ?? [])]) links.add(url);
    }
  }
  for (const init of path?.initiatives ?? []) key(init.jira?.key);
  for (const e of epics) [e.key, ...(e.issues ?? [])].forEach(key);
  return { keys: [...keys], links: [...links] };
}

/** The plan's top level, in order: each initiative with its epics, and the epics that stand alone. */
export type PlanGroup = { initiative: PathInitiative | null; steps: { step: PathStep; index: number }[] };

export function planGroups(path: Path): PlanGroup[] {
  const byId = new Map((path.initiatives ?? []).map((i) => [i.id, i]));
  const groups: PlanGroup[] = [];
  const seen = new Map<string, PlanGroup>();
  path.steps.forEach((step, index) => {
    const initiative = step.initiative ? byId.get(step.initiative) : undefined;
    if (!initiative) return groups.push({ initiative: null, steps: [{ step, index }] });
    let group = seen.get(initiative.id);
    if (!group) {
      group = { initiative, steps: [] };
      seen.set(initiative.id, group);
      groups.push(group);
    }
    group.steps.push({ step, index });
  });
  return groups;
}

/** An initiative's status, from its epics': done when all are, else underway (blocked when the ones underway are), else to do. */
export function initiativeStatus(steps: Pick<PathStep, "status">[]): PathStep["status"] {
  if (steps.length && steps.every((s) => s.status === "done")) return "done";
  const on = steps.filter((s) => s.status === "in_progress" || s.status === "blocked");
  if (on.length) return on.every((s) => s.status === "blocked") ? "blocked" : "in_progress";
  return steps.some((s) => s.status === "done") ? "in_progress" : "next";
}

/** When an initiative runs: from its first epic's start to its last one's end. */
export function initiativeSpan(steps: Pick<PathStep, "start" | "date" | "items">[]): { start: number; end: number; assumed: boolean } | null {
  const spans = steps.map(epicSpan).filter((x): x is NonNullable<typeof x> => !!x);
  if (!spans.length) return null;
  return { start: Math.min(...spans.map((x) => x.start)), end: Math.max(...spans.map((x) => x.end)), assumed: spans.every((x) => x.assumed) };
}

/**
 * The plan's work as tasks and dependencies (see layoutMap): its stories and tasks, one lane per epic
 * in the plan's order (an epic with nothing under it is a block of its own), and a line from each piece
 * of work to what waits on it. The same work as the plan, seen by the order it has to happen in, with
 * the user's own tasks on the project beside the work they move forward. `proposed`: the lanes of
 * epics Demian proposes, which aren't in Jira yet.
 */
export function planMap(
  path: Path,
  extra: {
    /** The user's own open tasks on the project, each shown with the work it moves forward. */
    tasks?: { id: string; title: string; status: PathStep["status"]; moves: string[]; due?: string | null }[];
    /** Dependencies known from elsewhere (an older map), for work the plan has none for yet. */
    links?: MapLink[];
  } = {},
): { map: ProjectMap; lanes: string[]; proposed: string[] } {
  const items: MapItem[] = [];
  const proposed: string[] = [];
  const links: MapLink[] = [];
  const lanes: string[] = [];
  const taken = new Set<string>();
  for (const group of planGroups(path)) {
    for (const { step, index } of group.steps) {
      // Lanes are matched by name, so two epics of the same name get told apart.
      let lane = step.epic ? `${step.epic.key} ${step.what}` : step.epic === null ? `Proposed: ${step.what}` : step.what;
      if (taken.has(lane.toLowerCase())) lane = `${lane} (${index + 1})`;
      taken.add(lane.toLowerCase());
      lanes.push(lane);
      if (step.epic === null) proposed.push(lane);
      const work = step.items ?? [];
      if (!work.length) {
        items.push({
          id: `epic:${index}`,
          title: step.what,
          detail: step.summary ?? "",
          owner: step.owners[0] ?? null,
          status: step.status,
          track: lane,
          jira: step.epic ? { key: step.epic.key, link: step.epic.link ?? null } : null,
          reason: step.epic ? null : "An epic Demian proposes, with nothing under it yet.",
          date: step.date ?? null,
        });
        continue;
      }
      work.forEach((item, j) => {
        const id = item.key?.trim() || item.id?.trim() || `w${index}-${j}`;
        items.push({
          id,
          title: item.title,
          detail: item.realign ? `An epic in Jira that Demian reads as a single issue's worth of work${item.realign.reason ? `: ${item.realign.reason}` : "."}` : "",
          owner: item.assignee ?? null,
          status: item.status,
          track: lane,
          jira: item.key ? { key: item.key, link: item.link ?? null } : null,
          reason: item.key ? null : "No ticket covers this work yet.",
          date: item.date ?? null,
        });
        for (const w of item.waits_on ?? []) links.push({ from: w.id.trim(), to: id, source: w.source, reason: w.reason ?? null });
      });
    }
  }
  // The user's tasks: each in the lane of the first work it moves, with a line to each; the rest in a lane of their own.
  const laneOf = new Map(items.map((i) => [i.id, i.track ?? ""]));
  const taskLinks: MapLink[] = [];
  const YOURS = "Your tasks";
  for (const task of extra.tasks ?? []) {
    const id = `task:${task.id}`;
    const moves = task.moves.map((m) => m.trim()).filter((m) => laneOf.has(m));
    const lane = moves.length ? laneOf.get(moves[0])! : YOURS;
    if (lane === YOURS && !lanes.includes(YOURS)) lanes.unshift(YOURS);
    items.push({ id, title: task.title, detail: "", owner: "You", status: task.status, track: lane, jira: null, reason: "Your task", date: task.due ?? null, mine: true });
    for (const m of moves) taskLinks.push({ from: id, to: m, source: "assumed", reason: "your task moves it forward" });
  }
  // Older dependencies only stand in while the plan has none of its own.
  const all = [...(links.length ? [] : (extra.links ?? [])), ...links, ...taskLinks];
  return { map: normalizeMap({ items, links: all, note: null }), lanes, proposed };
}
