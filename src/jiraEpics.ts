import {
  avatarOf,
  categoryOf,
  countIssues,
  epicLinkFieldOf,
  epicOf,
  fieldText,
  ISSUE_KEY,
  issueLink,
  JiraError,
  jiraFields,
  jqlString,
  PROJECT_KEY,
  searchIssues,
  sizeFieldCandidates,
  sprintFieldOf,
  sprintsOf,
  type Jira,
  type RawIssue,
  type RawSprint,
} from "./jira";
import type { EpicChildren, JiraIssueChanged, SprintChoice, SprintEpics } from "./schema";
import { sizeFieldJql, sizeOf } from "./sizes";
import { sprintNumber } from "./sprintEpics";

/**
 * The Epics area's reads, and the chats' changes to an issue, done through Demian's own connection to
 * Jira (see jira.ts) rather than a Claude run: the same results the prompts ask Claude for
 * (sprintEpicsPrompt, epicChildrenPrompt, issuesByKeyPrompt, changeJiraIssuePrompt), from a handful of
 * REST requests.
 */

/** The fields an issue's card shows. */
const DETAIL_FIELDS = ["summary", "status", "issuetype", "duedate", "assignee", "created", "statuscategorychangedate"];

/** The most of an epic's (or a list's) issues read. */
export const ISSUES_READ = 500;

/** An issue's T-shirt size from a field, or null. */
const sizeIn = (fields: Record<string, any>, field: string | null | undefined) => (field ? sizeOf(fieldText(fields[field])) : null);

/** Whether an issue is an epic. */
const isEpic = (r: RawIssue) => r.fields.issuetype?.hierarchyLevel === 1 || /^epic$/i.test(r.fields.issuetype?.name ?? "");

/** Runs a read over keys in groups (a JQL `in` list can't be endless), together. */
async function inGroups<T>(keys: string[], size: number, read: (group: string[]) => Promise<T[]>): Promise<T[]> {
  const groups: string[][] = [];
  for (let i = 0; i < keys.length; i += size) groups.push(keys.slice(i, i + size));
  return (await Promise.all(groups.map(read))).flat();
}

/**
 * A search over some keys, `jql` making it from each group of them (a JQL list can't be endless). Jira
 * turns down a whole search (400) when one key in it doesn't exist or isn't shown to the account: such a
 * group is searched again in halves, down to that key, so the others are still found. The keys that
 * couldn't be searched go in `failed`.
 */
function searchKeys(
  jira: Jira,
  keys: string[],
  size: number,
  jql: (group: string[]) => string,
  fields: string[],
  { limit, failed }: { limit?: number; failed?: Set<string> } = {},
): Promise<RawIssue[]> {
  const read = async (group: string[]): Promise<RawIssue[]> => {
    try {
      return await searchIssues(jira, jql(group), fields, limit);
    } catch (e) {
      if (!(e instanceof JiraError) || e.status !== 400) throw e;
      if (group.length === 1) {
        failed?.add(group[0]);
        return [];
      }
      const half = Math.ceil(group.length / 2);
      return (await Promise.all([read(group.slice(0, half)), read(group.slice(half))])).flat();
    }
  };
  return inGroups(keys, size, read);
}

/**
 * The open sprints (in `state`) that a search's issues are in: each round finds issues in sprints not
 * seen yet (an issue is in at most one open sprint), until there are none.
 */
async function sprintsFound(jira: Jira, jql: string, sprintField: string, state: "active" | "future"): Promise<RawSprint[]> {
  const seen = new Map<number, RawSprint>();
  for (let round = 0; round < 20; round++) {
    const not = seen.size ? ` AND sprint not in (${[...seen.keys()].join(", ")})` : "";
    const issues = await searchIssues(jira, `${jql}${not}`, [sprintField], 100);
    const fresh = issues.flatMap((i) => sprintsOf(i.fields, sprintField)).filter((s) => s.state === state && !seen.has(s.id));
    if (!fresh.length) break;
    for (const s of fresh) seen.set(s.id, s);
  }
  return [...seen.values()];
}

/** Future sprints with no start date and names like these are buckets ("Backlog", "Ready for refinement"), not sprints. */
const BUCKET = /backlog|refine|icebox|parking|later|someday|triage|ideas/i;

/**
 * The upcoming sprint, of the future ones: the one that starts soonest; when none has a start date,
 * the one numbered next after the sprint under way (or the lowest numbered), never a bucket.
 */
export function upcomingSprint(future: RawSprint[], current: RawSprint | null): RawSprint | null {
  const dated = future.filter((s) => s.startDate && !Number.isNaN(Date.parse(s.startDate))).sort((a, b) => Date.parse(a.startDate!) - Date.parse(b.startDate!));
  if (dated.length) return dated[0];
  const num = (s: RawSprint) => Number(sprintNumber(s.name));
  const numbered = future.filter((s) => !BUCKET.test(s.name) && sprintNumber(s.name) !== null).sort((a, b) => num(a) - num(b));
  const after = current && sprintNumber(current.name) !== null ? Number(sprintNumber(current.name)) : null;
  return (after === null ? numbered[0] : numbered.find((s) => num(s) > after)) ?? null;
}

/** The sprint under way: when the project's issues are in more than one (teams on separate boards), the one with the most of them. */
async function currentSprint(jira: Jira, base: string, sprintField: string): Promise<RawSprint | null> {
  const active = await sprintsFound(jira, `${base} AND sprint in openSprints() AND sprint not in futureSprints()`, sprintField, "active");
  if (active.length <= 1) return active[0] ?? null;
  const counts = await Promise.all(active.map((s) => countIssues(jira, `${base} AND sprint = ${s.id}`).catch(() => 0)));
  return active[counts.indexOf(Math.max(...counts))];
}

type Parent = { key: string; type: string | null; title: string | null };

/** An issue's parent as its parent field gives it: its key, type and title; null for none. */
const parentIn = (fields: Record<string, any> | undefined): Parent | null =>
  typeof fields?.parent?.key === "string" ? { key: fields.parent.key, type: fields.parent.fields?.issuetype?.name ?? null, title: fields.parent.fields?.summary ?? null } : null;

/** How far above an epic its breadcrumb goes: an initiative, and what's above that. */
const ANCESTORS_READ = 3;

/**
 * The issues each of some issues is under, from the top down, each with its type, title and link: their
 * parents, read up a level at a time (an epic's initiative, then what that's under). Null for an issue
 * not among them.
 */
async function ancestors(jira: Jira, issues: RawIssue[]): Promise<(key: string) => (Parent & { link: string })[] | null> {
  const up = new Map<string, Parent | null>(issues.map((i) => [i.key, parentIn(i.fields)]));
  let ask = [...new Set(issues.map((i) => up.get(i.key)?.key).filter((k): k is string => !!k && ISSUE_KEY.test(k) && !up.has(k)))];
  for (let level = 1; level < ANCESTORS_READ && ask.length; level++) {
    const found = await searchKeys(jira, ask, 100, (g) => `key in (${g.join(", ")})`, ["parent"]).catch(() => []);
    for (const k of ask) up.set(k, null);
    for (const f of found) up.set(f.key, parentIn(f.fields));
    ask = [...new Set(found.map((f) => up.get(f.key)?.key).filter((k): k is string => !!k && ISSUE_KEY.test(k) && !up.has(k)))];
  }
  return (key) => {
    if (!up.has(key)) return null;
    const chain: (Parent & { link: string })[] = [];
    for (let p = up.get(key) ?? null; p && chain.length < ANCESTORS_READ && !chain.some((c) => c.key === p!.key); p = up.get(p.key) ?? null)
      chain.unshift({ ...p, link: issueLink(jira.site, p.key) });
    return chain;
  };
}

/** A Jira project's current or upcoming sprint and the epics with work in it, for the Epics area (as sprintEpicsPrompt asks Claude). */
export async function readSprintEpics(jira: Jira, project: string, which: SprintChoice, sizeField: string | null | undefined): Promise<SprintEpics> {
  if (!PROJECT_KEY.test(project)) throw new Error(`Not a Jira project key: ${project}`);
  const base = `project = ${project} AND issuetype not in subTaskIssueTypes()`;
  const fields = await jiraFields(jira);
  const sprintField = sprintFieldOf(fields);
  const epicLink = epicLinkFieldOf(fields);
  const sprint =
    which === "current"
      ? await currentSprint(jira, base, sprintField)
      : await sprintsFound(jira, `${base} AND sprint in futureSprints()`, sprintField, "future").then(async (future) =>
          // Only when no future sprint has a start date does it go by the numbering from the sprint under way.
          upcomingSprint(future, future.some((s) => s.startDate) ? null : await currentSprint(jira, base, sprintField)),
        );
  if (!sprint)
    return {
      sprint: null,
      epics: [],
      unparented: 0,
      strays: [],
      error: null,
      size_field: sizeField ?? null,
      sizes_read: null,
    };

  // The size field: the one given, or (not known yet) whichever of the likely ones most of the sprint's issues have a size in.
  const candidates = sizeField === undefined ? sizeFieldCandidates(fields) : sizeField ? [sizeField] : [];
  const raw = await searchIssues(jira, `${base} AND sprint = ${sprint.id}`, [
    "parent",
    "assignee",
    "issuetype",
    "status",
    "statuscategorychangedate",
    ...(epicLink ? [epicLink] : []),
    ...candidates,
  ]);
  const found =
    sizeField !== undefined
      ? sizeField
      : (candidates
          .map((id) => [id, raw.filter((r) => sizeIn(r.fields, id)).length] as const)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null);

  const issueOf = (r: RawIssue) => {
    const category = categoryOf(r.fields.status);
    return {
      key: r.key,
      category,
      done_at: category === "done" ? (r.fields.statuscategorychangedate ?? null) : null,
      assignee: r.fields.assignee?.displayName ?? null,
      avatar: avatarOf(r.fields.assignee),
      type: r.fields.issuetype?.name ?? null,
      size: sizeIn(r.fields, found),
    };
  };
  // Each issue under its epic, or among those in none; an epic in the sprint itself is listed too.
  const byEpic = new Map<string, ReturnType<typeof issueOf>[]>();
  const strays: ReturnType<typeof issueOf>[] = [];
  for (const r of raw) {
    if (isEpic(r)) {
      if (!byEpic.has(r.key)) byEpic.set(r.key, []);
      continue;
    }
    const epic = epicOf(r.fields, epicLink);
    if (epic && ISSUE_KEY.test(epic)) byEpic.set(epic, [...(byEpic.get(epic) ?? []), issueOf(r)]);
    else strays.push(issueOf(r));
  }
  const keys = [...byEpic.keys()];

  // The epics themselves, and all their issues (in any sprint or none) for their counts and sizes.
  const parentOf = (c: RawIssue) => (typeof c.fields.parent?.key === "string" ? (c.fields.parent.key as string) : null);
  // Epics whose issues couldn't be counted (not shown to this account, say): no counts rather than none.
  const uncounted = new Set<string>();
  const [details, children] = await Promise.all([
    // An epic that can't be read (gone, or not shown to this account) keeps its key as its title.
    searchKeys(jira, keys, 100, (g) => `key in (${g.join(", ")})`, ["summary", "status", "duedate", "assignee", "parent"]).catch(() => []),
    searchKeys(jira, keys, 50, (g) => `parent in (${g.join(", ")})`, ["parent", "status", ...(found ? [found] : [])], { limit: 5000, failed: uncounted }).catch(() => null),
  ]);
  const tally = new Map<string, { done: number; started: number; total: number; sized: string[] }>();
  const count = (epic: string | null, c: RawIssue) => {
    if (!epic) return;
    const t = tally.get(epic) ?? { done: 0, started: 0, total: 0, sized: [] };
    const category = categoryOf(c.fields.status);
    t.total += 1;
    if (category === "done") t.done += 1;
    if (category === "in_progress") t.started += 1;
    const size = sizeIn(c.fields, found);
    if (size) t.sized.push(`${size}:${category}`);
    tally.set(epic, t);
  };
  for (const c of children ?? []) count(parentOf(c), c);
  // Epics whose issues are linked to them by the Epic Link field rather than as their parent.
  const unlinked = keys.filter((k) => !tally.has(k) && !uncounted.has(k) && (byEpic.get(k)?.length ?? 0) > 0);
  if (children && epicLink && unlinked.length) {
    const linked = await searchKeys(jira, unlinked, 50, (g) => `${sizeFieldJql(epicLink)} in (${g.join(", ")})`, [epicLink, "status", ...(found ? [found] : [])], {
      limit: 5000,
      failed: uncounted,
    }).catch(() => []);
    for (const c of linked) count(typeof c.fields[epicLink] === "string" ? c.fields[epicLink] : null, c);
  }

  const detail = new Map(details.map((d) => [d.key, d.fields]));
  const parents = await ancestors(jira, details);
  const epics = keys.map((key) => {
    const d = detail.get(key);
    const t = tally.get(key);
    const counted = !!children && !uncounted.has(key);
    return {
      key,
      title: d?.summary ?? key,
      status: d?.status?.name ?? null,
      category: categoryOf(d?.status),
      link: issueLink(jira.site, key),
      due: d?.duedate ?? null,
      assignee: d?.assignee?.displayName ?? null,
      avatar: avatarOf(d?.assignee),
      parents: detail.has(key) ? (parents(key) ?? []) : null,
      sized: found && counted ? (t?.sized ?? []) : null,
      issues: byEpic.get(key) ?? [],
      progress: counted ? { done: t?.done ?? 0, started: t?.started ?? 0, total: t?.total ?? 0 } : null,
    };
  });
  return {
    sprint: {
      name: sprint.name,
      start: sprint.startDate ?? null,
      end: sprint.endDate ?? null,
    },
    epics,
    unparented: strays.length,
    strays,
    error: null,
    size_field: found,
    sizes_read: null,
  };
}

/** An issue for a card: as epicChildrenPrompt and issuesByKeyPrompt ask Claude for each. */
function detailOf(r: RawIssue, site: string, sizeField: string | null | undefined): EpicChildren["issues"][number] {
  const f = r.fields;
  const category = categoryOf(f.status);
  return {
    key: r.key,
    title: f.summary ?? r.key,
    status: f.status?.name ?? "",
    category,
    type: f.issuetype?.name ?? null,
    due: f.duedate ?? null,
    size: sizeIn(f, sizeField),
    assignee: f.assignee?.displayName ?? null,
    avatar: avatarOf(f.assignee),
    link: issueLink(site, r.key),
    created: f.created ?? null,
    done_at: category === "done" ? (f.statuscategorychangedate ?? null) : null,
  };
}

/** An epic's issues, each for its card. */
export async function readEpicChildren(jira: Jira, key: string, sizeField: string | null | undefined): Promise<EpicChildren> {
  if (!ISSUE_KEY.test(key)) throw new Error(`Not a Jira issue key: ${key}`);
  const fields = [...DETAIL_FIELDS, ...(sizeField ? [sizeField] : [])];
  const order = "ORDER BY status ASC, updated DESC";
  let raw = await searchIssues(jira, `parent = ${key} ${order}`, fields, ISSUES_READ);
  // Some projects link issues to their epic with the Epic Link field instead.
  if (!raw.length) {
    const link = epicLinkFieldOf(await jiraFields(jira));
    if (link) raw = await searchIssues(jira, `${sizeFieldJql(link)} = ${key} ${order}`, fields, ISSUES_READ).catch(() => []);
  }
  return {
    issues: raw.map((r) => detailOf(r, jira.site, sizeField)),
    error: null,
    size_field: sizeField ?? null,
  };
}

/** Issues by their keys (the Epics area's Unaffiliated list, and each person's), each for its card; one gone since, or not shown to this account, is left out. */
export async function readIssuesByKey(jira: Jira, keys: string[], sizeField: string | null | undefined): Promise<EpicChildren> {
  const fields = [...DETAIL_FIELDS, ...(sizeField ? [sizeField] : [])];
  const valid = [...new Set(keys)].filter((k) => ISSUE_KEY.test(k)).slice(0, ISSUES_READ);
  const raw = await searchKeys(jira, valid, 100, (g) => `key in (${g.join(", ")}) ORDER BY status ASC, updated DESC`, fields);
  return {
    issues: raw.map((r) => detailOf(r, jira.site, sizeField)),
    error: null,
    size_field: sizeField ?? null,
  };
}

/** A change to one issue, as a chat's card has it (see the change_jira_issue action). */
export interface IssueChange {
  key: string;
  status?: string | null;
  assignee?: string | null;
  due?: string | null;
  summary?: string | null;
  priority?: string | null;
  epic?: string | null;
  sprint?: string | null;
  comment?: string | null;
}

const isNone = (v: string) => v.trim().toLowerCase() === "none";

/** Text as a Jira comment's body (Atlassian's document format): its paragraphs, and its lines within them. */
export function commentBody(text: string) {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.split("\n"));
  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((lines) => ({
      type: "paragraph",
      content: lines.flatMap((line, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]),
    })),
  };
}

/** The account of whoever a name (or email) means, among those who can be assigned the issue; null when no one, or more than one, matches. */
async function assignable(jira: Jira, key: string, name: string): Promise<string | null> {
  const users = await jira.get<{ accountId?: string; displayName?: string; emailAddress?: string }[]>(
    `/rest/api/3/user/assignable/search?issueKey=${key}&query=${encodeURIComponent(name.trim())}&maxResults=20`,
  );
  const want = name.trim().toLowerCase();
  const exact = (users ?? []).filter((u) => u.displayName?.toLowerCase() === want || u.emailAddress?.toLowerCase() === want);
  const pick = exact.length === 1 ? exact[0] : users?.length === 1 ? users[0] : null;
  return pick?.accountId ?? null;
}

/** An open (active or future) sprint by name, from the issues in it, else from the boards of the issue's project. */
async function openSprintNamed(jira: Jira, key: string, name: string, sprintField: string): Promise<RawSprint | null> {
  const want = name.trim().toLowerCase();
  const open = (s: RawSprint) => (s.state === "active" || s.state === "future") && s.name.trim().toLowerCase() === want;
  const inIssues = await searchIssues(jira, `sprint = ${jqlString(name.trim())}`, [sprintField], 20).catch(() => []);
  const found = inIssues.flatMap((i) => sprintsOf(i.fields, sprintField)).find(open);
  if (found) return found;
  // A sprint with no issues in it yet: look on the project's boards.
  const project = key.split("-")[0];
  const boards = await jira.get<{ values?: { id: number }[] }>(`/rest/agile/1.0/board?projectKeyOrId=${project}&type=scrum&maxResults=50`).catch(() => ({ values: [] }));
  for (const b of boards.values ?? []) {
    const sprints = await jira.get<{ values?: RawSprint[] }>(`/rest/agile/1.0/board/${b.id}/sprint?state=active,future&maxResults=50`).catch(() => ({ values: [] }));
    const s = (sprints.values ?? []).find(open);
    if (s) return s;
  }
  return null;
}

/**
 * Makes a change a chat proposed to one issue, as the user applied it from its card: each field given,
 * once, and nothing else (as changeJiraIssuePrompt asks Claude). It reads the issue before and after, so
 * the Epics area can bring what it shows up to date without reading the sprint again.
 */
export async function changeIssue(jira: Jira, c: IssueChange): Promise<JiraIssueChanged> {
  const key = c.key.trim().toUpperCase();
  if (!ISSUE_KEY.test(key)) throw new Error(`Not a Jira issue key: ${c.key}`);
  const fields = await jiraFields(jira);
  const sprintField = sprintFieldOf(fields);
  const epicLink = epicLinkFieldOf(fields);
  const path = `/rest/api/3/issue/${key}`;
  const read = (names: string[]) => jira.get<RawIssue>(`${path}?fields=${names.join(",")}`);
  const changed: string[] = [];
  const notChanged: string[] = [];
  const errors: string[] = [];
  const refused = (name: string, why: string) => {
    notChanged.push(name);
    errors.push(`${name[0].toUpperCase()}${name.slice(1)}: ${why}`);
  };
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const before = await read(["status", "parent", ...(epicLink ? [epicLink] : [])]).then(
    (r) => ({
      category: categoryOf(r.fields.status),
      epic: epicOf(r.fields, epicLink),
    }),
    () => null,
  );

  // Status: the transition that leads there; none is chained to get there.
  if (c.status) {
    try {
      const { transitions = [] } = await jira.get<{
        transitions?: { id: string; to?: { name?: string } }[];
      }>(`${path}/transitions`);
      const want = c.status.trim().toLowerCase();
      const t = transitions.find((x) => x.to?.name?.trim().toLowerCase() === want);
      if (!t) {
        const can = [...new Set(transitions.map((x) => x.to?.name).filter(Boolean))].join(", ");
        refused("status", `it can't move to "${c.status}" from where it is${can ? `; it can move to ${can}` : ""}.`);
      } else {
        await jira.post(`${path}/transitions`, { transition: { id: t.id } });
        changed.push("status");
      }
    } catch (e) {
      refused("status", reason(e));
    }
  }

  // Field changes: together, and when Jira refuses that, each on its own, to see which it refuses.
  const edits: [string, Record<string, unknown>][] = [];
  if (c.assignee) {
    if (isNone(c.assignee)) edits.push(["assignee", { assignee: null }]);
    else {
      try {
        const id = await assignable(jira, key, c.assignee);
        if (id) edits.push(["assignee", { assignee: { accountId: id } }]);
        else refused("assignee", `no one, or more than one person, who can be assigned it matches "${c.assignee}".`);
      } catch (e) {
        refused("assignee", reason(e));
      }
    }
  }
  if (c.due) edits.push(["due", { duedate: isNone(c.due) ? null : c.due.trim() }]);
  if (c.summary) edits.push(["summary", { summary: c.summary }]);
  if (c.priority) edits.push(["priority", { priority: { name: c.priority.trim() } }]);
  if (c.epic) {
    const epic = c.epic.trim().toUpperCase();
    if (isNone(c.epic)) edits.push(["epic", { parent: null }]);
    else if (ISSUE_KEY.test(epic)) edits.push(["epic", { parent: { key: epic } }]);
    else refused("epic", `"${c.epic}" isn't an issue key.`);
  }
  if (edits.length) {
    try {
      await jira.put(path, {
        fields: Object.assign({}, ...edits.map(([, f]) => f)),
      });
      changed.push(...edits.map(([name]) => name));
    } catch {
      for (const [name, f] of edits) {
        try {
          await jira.put(path, { fields: f });
          changed.push(name);
        } catch (e) {
          // Taken out of its epic by clearing its Epic Link, where that's how it's linked.
          if (name === "epic" && "parent" in f && f.parent === null && epicLink) {
            const cleared = await jira.put(path, { fields: { [epicLink]: null } }).then(
              () => true,
              () => false,
            );
            if (cleared) {
              changed.push(name);
              continue;
            }
          }
          refused(name, reason(e));
        }
      }
    }
  }

  // Sprint: into the open sprint by that name, or back to the backlog.
  if (c.sprint) {
    try {
      if (c.sprint.trim().toLowerCase() === "backlog") {
        await jira.post("/rest/agile/1.0/backlog/issue", { issues: [key] });
        changed.push("sprint");
      } else {
        const s = await openSprintNamed(jira, key, c.sprint, sprintField);
        if (!s) refused("sprint", `there's no open sprint named "${c.sprint}".`);
        else {
          await jira.post(`/rest/agile/1.0/sprint/${s.id}/issue`, {
            issues: [key],
          });
          changed.push("sprint");
        }
      }
    } catch (e) {
      refused("sprint", reason(e));
    }
  }

  if (c.comment?.trim()) {
    try {
      await jira.post(`${path}/comment`, { body: commentBody(c.comment) });
      changed.push("comment");
    } catch (e) {
      refused("comment", reason(e));
    }
  }

  const issue = await read(["summary", "status", "issuetype", "assignee", "duedate", "parent", sprintField, ...(epicLink ? [epicLink] : [])]).then(
    (r) => ({
      key,
      title: r.fields.summary ?? null,
      status: r.fields.status?.name ?? null,
      category: categoryOf(r.fields.status),
      type: r.fields.issuetype?.name ?? null,
      assignee: r.fields.assignee?.displayName ?? null,
      avatar: avatarOf(r.fields.assignee),
      due: r.fields.duedate ?? null,
      link: issueLink(jira.site, key),
      epic: epicOf(r.fields, epicLink),
      sprints: sprintsOf(r.fields, sprintField)
        .filter((s) => s.state === "active" || s.state === "future")
        .map((s) => s.name),
    }),
    () => null,
  );
  return {
    sent: changed.length > 0,
    changed,
    not_changed: notChanged,
    before,
    issue,
    error: errors.join(" ") || null,
  };
}
