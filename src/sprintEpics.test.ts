import { describe, expect, it } from "vitest";
import { EpicChildren, SprintEpics } from "./schema";
import { burndown, childrenWithChange, dueText, epicBurndown, epicProgress, isStale, leftAt, oldRead, sprintPeople, orderEpics, projectKeyFrom, splitIssues, sprintDates, sprintKey, sprintNumber, STALE_MS, listStoreKey, personEpic, personKey, UNAFFILIATED, unaffiliatedEpic, type SprintEpic } from "./sprintEpics";
import { ATLASSIAN_RULE } from "./baseLessons";
import { changeJiraIssuePrompt, issuesByKeyPrompt, sprintEpicsPrompt } from "./prompts";
import { sprintWithChange, type ChangedIssue } from "./sprintEpics";
import { SIZES_READ } from "./sizes";

const epic = (key: string, cats: ("done" | "in_progress" | "todo")[], category: SprintEpic["category"] = "in_progress"): SprintEpic => ({
  key,
  title: `Epic ${key}`,
  status: null,
  category,
  link: null,
  assignee: null,
  avatar: null,
  parents: [],
  issues: cats.map((c, i) => ({ key: `${key}-${i}`, category: c, assignee: null, avatar: null })),
  progress: null,
});

describe("the Epics area's project", () => {
  it("takes a key in any case, or a link into the project", () => {
    expect(projectKeyFrom(" pay ")).toBe("PAY");
    expect(projectKeyFrom("https://example.atlassian.net/jira/software/c/projects/PAY/boards/12")).toBe("PAY");
    expect(projectKeyFrom("https://example.atlassian.net/browse/PAY-123")).toBe("PAY");
    expect(projectKeyFrom("https://example.atlassian.net/jira/software/c/projects/PAY/boards/12?selectedIssue=PAY-4")).toBe("PAY");
    expect(projectKeyFrom("https://example.atlassian.net/issues/?selectedIssue=AB_2-9")).toBe("AB_2");
    expect(projectKeyFrom("")).toBeNull();
    expect(projectKeyFrom("P")).toBeNull();
    expect(projectKeyFrom("not a key")).toBeNull();
    expect(projectKeyFrom("9AB")).toBeNull();
  });

  it("keeps each sprint under its project", () => {
    expect(sprintKey("PAY", "current")).toBe("PAY:current");
    expect(sprintKey("PAY", "upcoming")).toBe("PAY:upcoming");
  });

  it("reads again what's an hour old, or was never read", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(isStale(undefined, now)).toBe(true);
    expect(isStale(new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(isStale(new Date(now - STALE_MS - 1).toISOString(), now)).toBe(true);
    expect(isStale("garbage", now)).toBe(true);
  });
});

describe("the sprint's epics", () => {
  it("puts the most open work first, done epics last", () => {
    const list = orderEpics([epic("PAY-10", ["todo"]), epic("PAY-2", ["done", "done", "done"]), epic("PAY-9", ["todo"]), epic("PAY-3", ["todo", "in_progress", "done"]), epic("PAY-1", ["todo", "todo"], "done")]);
    expect(list.map((e) => e.key)).toEqual(["PAY-3", "PAY-9", "PAY-10", "PAY-2", "PAY-1"]);
  });

  it("counts how much of the whole epic is done, not only its work in the sprint", () => {
    const inSprint = epic("PAY-3", ["todo", "done"]);
    expect(epicProgress({ ...inSprint, progress: { done: 7, started: 2, total: 12 } })).toEqual({ done: 7, started: 2, total: 12 });
    // Without the read's count, from its issues as last read; never from the sprint's issues alone.
    const issue = (key: string, category: "done" | "in_progress" | "todo") => ({ key, title: key, status: category, category });
    expect(epicProgress(inSprint, { issues: [issue("A", "done"), issue("B", "done"), issue("C", "todo"), issue("D", "in_progress")] })).toEqual({ done: 2, started: 1, total: 4 });
    expect(epicProgress(inSprint, { issues: [], error: "Forbidden" })).toBeNull();
    expect(epicProgress(inSprint)).toBeNull();
  });

  it("reads again a sprint read from before it kept the epics' counts and the issues in no epic", () => {
    expect(oldRead({ strays: [], epics: [{ ...epic("PAY-3", ["todo"]), progress: undefined }] })).toBe(true);
    expect(oldRead({ epics: [epic("PAY-3", ["todo"])] })).toBe(true);
    expect(oldRead({ strays: [], sizes_read: SIZES_READ, epics: [epic("PAY-3", ["todo"]), { ...epic("PAY-4", []), progress: { done: 0, started: 1, total: 2 } }] })).toBe(false);
    // Or before it read sizes the way it does now (the first way could keep a field the sprint doesn't use).
    expect(oldRead({ strays: [], epics: [epic("PAY-3", ["todo"]), { ...epic("PAY-4", []), progress: { done: 0, started: 1, total: 2 } }] })).toBe(true);
    expect(oldRead({ strays: [], sizes_read: 1, epics: [{ ...epic("PAY-4", []), progress: { done: 0, started: 1, total: 2 } }] })).toBe(true);
    // Or before it counted what's in progress.
    expect(oldRead({ strays: [], epics: [{ ...epic("PAY-4", []), progress: { done: 0, total: 2 } as { done: number; started: number; total: number } }] })).toBe(true);
    // Or before it kept who has each issue.
    expect(oldRead({ strays: [], epics: [{ ...epic("PAY-3", []), progress: { done: 0, started: 0, total: 1 }, issues: [{ key: "PAY-5", category: "todo" }] }] })).toBe(true);
    // Or one from before each epic's assignee was kept.
    const { assignee: _, ...ownerless } = epic("PAY-3", []);
    expect(oldRead({ strays: [], epics: [{ ...ownerless, progress: { done: 0, started: 0, total: 1 } }] })).toBe(true);
    // Or one from before the issues an epic is under were kept, for its breadcrumb.
    const { parents: __, ...orphan } = epic("PAY-3", []);
    expect(oldRead({ strays: [], sizes_read: SIZES_READ, epics: [{ ...orphan, progress: { done: 0, started: 0, total: 1 } }] })).toBe(true);
    expect(oldRead(undefined)).toBe(false);
  });

  it("lists the issues in no epic last, as Unaffiliated, with their own progress", () => {
    expect(unaffiliatedEpic({ strays: [] })).toBeNull();
    expect(unaffiliatedEpic(undefined)).toBeNull();
    const stray = (key: string, category: "done" | "todo" | "in_progress") => ({ key, category, assignee: null, avatar: null });
    const u = unaffiliatedEpic({ strays: [stray("PAY-7", "done"), stray("PAY-8", "todo"), stray("PAY-9", "in_progress")] })!;
    expect(u).toMatchObject({ key: UNAFFILIATED, title: "Unaffiliated", link: null, progress: { done: 1, started: 1, total: 3 } });
    expect(epicProgress(u)).toEqual({ done: 1, started: 1, total: 3 });
    // Kept for each sprint, as each person's list is; an epic's under its key.
    expect(listStoreKey("PAY", "upcoming", UNAFFILIATED)).toBe("unaffiliated@PAY:upcoming");
    expect(listStoreKey("PAY", "current", personKey("Ana"))).toBe("person:Ana@PAY:current");
    expect(listStoreKey("PAY", "current", "PAY-3")).toBe("PAY-3");
  });

  it("splits an epic's issues into the sprint's and the rest, in progress first", () => {
    const issue = (key: string, category: "done" | "in_progress" | "todo") => ({ key, title: key, status: category, category });
    const { sprint, rest } = splitIssues([issue("A", "done"), issue("B", "todo"), issue("C", "in_progress"), issue("D", "todo"), issue("E", "in_progress")], new Set(["A", "B", "C", "Z"]));
    expect(sprint.map((i) => i.key)).toEqual(["C", "B", "A"]);
    expect(rest.map((i) => i.key)).toEqual(["E", "D"]);
  });

  it("says when an epic is due, and whether it's past due", () => {
    const now = new Date(2026, 10, 24, 15);
    expect(dueText("2026-12-12", "in_progress", now)).toEqual({ text: `Due ${new Date(2026, 11, 12).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, late: false });
    expect(dueText("2026-11-24", "todo", now)!.late).toBe(false);
    expect(dueText("2026-11-23", "todo", now)!.late).toBe(true);
    expect(dueText("2026-11-23", "done", now)!.late).toBe(false);
    expect(dueText("2027-01-08", "todo", now)!.text).toContain("2027");
    expect(dueText(null, "todo", now)).toBeNull();
    expect(dueText("soon", "todo", now)).toBeNull();
  });

  it("reads a sprint's number from its name", () => {
    expect(sprintNumber("Payments 2026 Sprint 24")).toBe("24");
    expect(sprintNumber("Sprint 7 (holiday)")).toBe("7");
    expect(sprintNumber("Backlog")).toBeNull();
    expect(sprintNumber(null)).toBeNull();
  });

  it("says a sprint's dates however many it has", () => {
    expect(sprintDates("2026-11-22T13:00:00.000Z", "2026-12-06T13:00:00.000Z")).toMatch(/^Nov 2\d – Dec \d$/);
    expect(sprintDates("2026-11-22T13:00:00.000Z", null)).toMatch(/^From Nov 2\d$/);
    expect(sprintDates(null, "2026-12-06T13:00:00.000Z")).toMatch(/^Until Dec \d$/);
    expect(sprintDates(null, undefined)).toBeNull();
    expect(sprintDates("soon", "later")).toBeNull();
  });
});

describe("the sprint's burndown", () => {
  const day = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
  type Item = { key: string; category: "done" | "todo"; done_at?: string | null; assignee?: string | null; avatar?: string | null };
  const full = (i: Item) => ({ assignee: null, avatar: null, ...i });
  const sprint = (issues: Item[], strays: Item[] = []) => ({
    sprint: { name: "Sprint 24", start: day(16, 9), end: day(30, 9) },
    epics: [{ ...epic("PAY-1", []), issues: issues.map(full) }],
    strays: strays.map(full),
  });

  it("steps down as each issue went done, from the sprint's start to now", () => {
    const b = burndown(sprint([{ key: "A", category: "done", done_at: day(18) }, { key: "B", category: "done", done_at: day(20) }, { key: "C", category: "todo" }], [{ key: "D", category: "todo" }]), Date.parse(day(24)))!;
    expect(b).toMatchObject({ total: 4, left: 2, start: Date.parse(day(16, 9)), end: Date.parse(day(30, 9)), now: Date.parse(day(24)) });
    expect(b.steps).toEqual([
      { at: Date.parse(day(16, 9)), left: 4 },
      { at: Date.parse(day(18)), left: 3 },
      { at: Date.parse(day(20)), left: 2 },
      { at: Date.parse(day(24)), left: 2 },
    ]);
  });

  it("counts work done before the sprint from its start, and done with no date from now", () => {
    const b = burndown(sprint([{ key: "A", category: "done", done_at: day(10) }, { key: "B", category: "done", done_at: null }, { key: "C", category: "todo" }]), Date.parse(day(24)))!;
    expect(b.steps[0]).toEqual({ at: Date.parse(day(16, 9)), left: 2 });
    expect(b.steps.at(-1)).toEqual({ at: Date.parse(day(24)), left: 1 });
  });

  it("stops at the sprint's end, and counts an issue in two lists once", () => {
    const b = burndown(sprint([{ key: "A", category: "done", done_at: day(29) }, { key: "B", category: "todo" }], [{ key: "B", category: "todo" }]), Date.parse(day(28 + 5)))!;
    expect(b.total).toBe(2);
    expect(b.now).toBe(Date.parse(day(30, 9)));
    expect(b.steps.at(-1)).toEqual({ at: Date.parse(day(30, 9)), left: 1 });
  });

  it("projects our pace to the sprint's end, or to when none would be left", () => {
    // 2 of 4 done in the first 8 days: at that pace, none left 8 days on, past the end (6 days on).
    const slow = burndown(sprint([{ key: "A", category: "done", done_at: day(18) }, { key: "B", category: "done", done_at: day(20) }, { key: "C", category: "todo" }, { key: "D", category: "todo" }]), Date.parse(day(24, 9)))!;
    expect(slow.projection!.at).toBe(Date.parse(day(30, 9)));
    expect(slow.projection!.left).toBeCloseTo(0.5, 5);
    expect(leftAt(slow, Date.parse(day(27, 9)))).toBeCloseTo(1.25, 5);
    expect(leftAt(slow, Date.parse(day(19)))).toBe(3);
    // 3 of 4 done in 4 days: the last one 1⅓ days on, before the end.
    const fast = burndown(sprint([{ key: "A", category: "done", done_at: day(17) }, { key: "B", category: "done", done_at: day(18) }, { key: "C", category: "done", done_at: day(19) }, { key: "D", category: "todo" }]), Date.parse(day(20, 9)))!;
    expect(fast.projection).toEqual({ at: Date.parse(day(20, 9)) + (4 / 3) * 86_400_000, left: 0 });
    expect(leftAt(fast, Date.parse(day(29)))).toBe(0);
    // Nothing done yet: level to the end. Over: none.
    expect(burndown(sprint([{ key: "A", category: "todo" }]), Date.parse(day(20)))!.projection).toEqual({ at: Date.parse(day(30, 9)), left: 1 });
    expect(burndown(sprint([{ key: "A", category: "todo" }]), Date.parse(day(31)))!.projection).toBeNull();
  });

  it("tallies who has the sprint's issues, the most first and the unassigned last", () => {
    const people = sprintPeople(
      sprint(
        [
          { key: "A", category: "done", assignee: "Ana", avatar: "https://a.example/ana.png" },
          { key: "B", category: "todo", assignee: "Ben" },
          { key: "C", category: "todo", assignee: "Ana" },
          { key: "D", category: "todo" },
        ],
        [{ key: "E", category: "done", assignee: "Ben", avatar: "https://a.example/ben.png" }, { key: "F", category: "todo", assignee: "Cy" }, { key: "A", category: "done", assignee: "Ana" }],
      ),
    );
    expect(people.map(({ points: _, ...p }) => p)).toEqual([
      { name: "Ana", avatar: "https://a.example/ana.png", done: 1, started: 0, total: 2 },
      { name: "Ben", avatar: "https://a.example/ben.png", done: 1, started: 0, total: 2 },
      { name: "Cy", avatar: null, done: 0, started: 0, total: 1 },
      { name: null, avatar: null, done: 0, started: 0, total: 1 },
    ]);
    expect(sprintPeople(undefined)).toEqual([]);
    // A read from before assignees were kept shows no one, not everyone unassigned.
    const old = sprint([{ key: "A", category: "todo" }]);
    expect(sprintPeople({ ...old, epics: [{ ...old.epics[0], issues: [{ key: "A", category: "todo" } as (typeof old.epics)[0]["issues"][0]] }] })).toEqual([]);
  });

  it("charts some of the sprint's issues over its dates: an epic's, or a person's", () => {
    const s = sprint([{ key: "A", category: "done", done_at: day(18) }, { key: "B", category: "done", done_at: day(20) }, { key: "C", category: "todo" }]);
    const some = burndown(s, Date.parse(day(24)), [s.epics[0].issues[1], s.epics[0].issues[2]])!;
    expect(some).toMatchObject({ total: 2, left: 1, start: Date.parse(day(16, 9)), end: Date.parse(day(30, 9)) });
    expect(some.steps.map((x) => x.left)).toEqual([2, 1, 1]);
    expect(burndown(s, Date.parse(day(24)), [])).toBeNull();
  });

  it("has none for a sprint not begun, without dates, or without issues", () => {
    expect(burndown(sprint([{ key: "A", category: "todo" }]), Date.parse(day(15)))).toBeNull();
    expect(burndown({ ...sprint([{ key: "A", category: "todo" }]), sprint: { name: "S", start: null, end: day(30) } }, Date.parse(day(20)))).toBeNull();
    expect(burndown(sprint([]), Date.parse(day(20)))).toBeNull();
    expect(burndown(undefined)).toBeNull();
  });
});

describe("reading a sprint", () => {
  it("parses what a read returns, filling in what's missing", () => {
    const read = SprintEpics.parse({ sprint: { name: "Sprint 3" }, epics: [{ key: "PAY-1", title: "Refunds", category: "unknown" }] });
    expect(read.sprint).toEqual({ name: "Sprint 3" });
    expect(read.epics[0]).toMatchObject({ category: "todo", issues: [], progress: null, assignee: null, avatar: null });
    // A read that leaves out an epic's owner still has one (no one), so it isn't taken for an old read.
    expect(oldRead({ ...read, sizes_read: SIZES_READ })).toBe(false);
    expect(SprintEpics.parse({ sprint: null, epics: [{ key: "PAY-1", title: "R", assignee: "Ana", avatar: "https://a.example/ana.png" }] }).epics[0]).toMatchObject({ assignee: "Ana", avatar: "https://a.example/ana.png" });
    expect(SprintEpics.parse({ sprint: null, epics: [{ key: "PAY-1", title: "R", progress: { done: 3, started: 2, total: 9 } }] }).epics[0].progress).toEqual({ done: 3, started: 2, total: 9 });
    expect(SprintEpics.parse({ sprint: null, epics: [{ key: "PAY-1", title: "R", progress: { done: 3, total: 9 } }] }).epics[0].progress).toEqual({ done: 3, started: 0, total: 9 });
    expect(SprintEpics.parse({ sprint: null, epics: [{ key: "PAY-1", title: "R", progress: { done: "some" } }] }).epics[0].progress).toBeNull();
    expect(read.unparented).toBe(0);
    expect(read.strays).toEqual([]);
    expect(SprintEpics.parse({ sprint: null, strays: [{ key: "PAY-7", category: "done", done_at: "2026-11-20T10:00:00.000+0000", assignee: "Ana", avatar: "https://a.example/ana.png" }, { key: "PAY-8" }] }).strays).toEqual([
      { key: "PAY-7", category: "done", done_at: "2026-11-20T10:00:00.000+0000", assignee: "Ana", avatar: "https://a.example/ana.png" },
      { key: "PAY-8", category: "todo", assignee: null, avatar: null },
    ]);
    expect(SprintEpics.parse({ sprint: null, epics: [], unparented: 4 })).toMatchObject({ sprint: null, unparented: 4 });
    expect(SprintEpics.parse({ sprint: "Sprint 3", epics: [] }).sprint).toBeNull();
  });

  it("keeps an assignee's avatar with an epic's issues", () => {
    const read = EpicChildren.parse({ issues: [{ key: "PAY-2", title: "Refund API", status: "In Review", category: "in_progress", assignee: "Ana", avatar: "https://avatars.example.com/a.png" }] });
    expect(read.issues[0].avatar).toBe("https://avatars.example.com/a.png");
  });

  it("asks for the sprint under way, or the next one planned without the backlog buckets", () => {
    const current = sprintEpicsPrompt("PAY", "current", null);
    const upcoming = sprintEpicsPrompt("PAY", "upcoming", null);
    for (const p of [current, upcoming]) {
      expect(p).toContain(ATLASSIAN_RULE);
      expect(p).toContain("project = PAY AND issuetype not in subTaskIssueTypes() AND sprint = <its id>");
      expect(p).toContain("AND statusCategory = Done");
      // Each issue's epic from Epic Link, which is small; parent (over a kilobyte an issue) only in small pages.
      expect(p).toContain('fields ["customfield_10014", "assignee", "issuetype"] and maxResults 50');
      expect(p).toContain('fields ["parent", "assignee", "issuetype"] and maxResults 20');
      expect(p).toMatch(/Never send, post/);
      // Each epic's issues in every sprint, by count alone.
      expect(p).toContain('search `parent = <its key>`, `parent = <its key> AND statusCategory = Done` and `parent = <its key> AND statusCategory = "In Progress"`, each with searchResultMode "count"');
      expect(p).toContain('AND statusCategory = "In Progress"` with fields ["statuscategorychangedate"]');
      expect(p).toContain('"progress": {"done": number, "started": number, "total": number}|null');
      // When each issue went done, for the burndown; and the issues in no epic, for Unaffiliated.
      expect(p).toContain('AND statusCategory = Done` with fields ["statuscategorychangedate"]');
      expect(p).toContain('"strays": [{"key": string, "category": "done"|"in_progress"|"todo", "done_at": string|null, "assignee": string|null, "avatar": string|null, "type": string|null, "size": string|null}]');
    }
    expect(current).toContain("sprint in openSprints()");
    expect(current).not.toContain("futureSprints");
    expect(upcoming).toContain("sprint in futureSprints()");
    expect(upcoming).toContain("AND sprint not in (<every future sprint you've seen>)");
    expect(upcoming).toMatch(/backlog bucket/);
    expect(upcoming).toMatch(/earliest startDate/);
  });
});

describe("a person's issues", () => {
  const issue = (key: string, category: "done" | "todo", assignee: string | null) => ({ key, category, assignee, avatar: null });
  const sprint = {
    epics: [{ ...epic("PAY-1", []), issues: [issue("A", "done", "Ana"), issue("B", "todo", "Ben"), issue("C", "todo", "Ana")] }],
    strays: [issue("D", "todo", null), issue("E", "done", " Ana ")],
  };

  it("gathers what they have in the sprint, in epics or not, as a list of their own", () => {
    expect(personEpic(sprint, personKey("Ana"))).toMatchObject({ key: "person:Ana", title: "Ana", link: null, progress: { done: 2, started: 0, total: 3 } });
    expect(personEpic(sprint, personKey("Ana"))!.issues.map((i) => i.key)).toEqual(["A", "C", "E"]);
    expect(personEpic(sprint, personKey(null))).toMatchObject({ key: "person:", title: "Unassigned", progress: { done: 0, started: 0, total: 1 } });
  });

  it("is none for someone with nothing in the sprint, or a key that isn't a person's", () => {
    expect(personEpic(sprint, personKey("Cy"))).toBeNull();
    expect(personEpic(sprint, "PAY-1")).toBeNull();
    expect(personEpic(undefined, personKey("Ana"))).toBeNull();
  });
});

describe("reading the issues in no epic", () => {
  it("reads them by key, at most a hundred, as an epic's issues are read", () => {
    const p = issuesByKeyPrompt(Array.from({ length: 120 }, (_, i) => `PAY-${i + 1}`));
    expect(p).toContain("key in (PAY-1, PAY-2,");
    expect(p).toContain("PAY-100) ORDER BY status ASC");
    expect(p).not.toContain("PAY-101");
    expect(p).toContain(ATLASSIAN_RULE);
    expect(p).toMatch(/Never send, post/);
    expect(p).toContain('"assignee": string|null, "avatar": string|null');
  });
});

describe("an epic's burndown over its life", () => {
  const DAY = 86_400_000;
  const at = (d: number) => new Date(2026, 10, d, 12).getTime();
  const iso = (d: number) => new Date(at(d)).toISOString();
  const done = (created: number, finished: number) => ({ category: "done" as const, created: iso(created), done_at: iso(finished) });
  const open = (created: number) => ({ category: "todo" as const, created: iso(created), done_at: null });

  it("runs from its first issue to its due date, the even pace landing on that date", () => {
    // 4 issues from Nov 2; 2 done by Nov 22 (20 days): 1 a day every 10, so the last two in 20 more days.
    const b = epicBurndown([done(2, 10), done(4, 20), open(6), open(8)], "2026-12-20", at(22))!;
    expect(b).toMatchObject({ total: 4, left: 2, start: at(2), now: at(22), endEstimated: false });
    expect(b.paceTo).toBe(new Date(2026, 11, 20, 23, 59, 59, 999).getTime());
    expect(b.end).toBe(b.paceTo);
    expect(b.steps.map((x) => x.left)).toEqual([4, 3, 2, 2]);
    expect(b.estimate).toBe(at(22) + 20 * DAY);
    expect(b.projection).toEqual({ at: at(22) + 20 * DAY, left: 0 });
  });

  it("runs on past its due date to the estimate when our pace is behind it", () => {
    const b = epicBurndown([done(2, 10), done(4, 20), open(6), open(8)], "2026-11-30", at(22))!;
    expect(b.end).toBe(at(22) + 20 * DAY);
    expect(b.estimate).toBe(at(22) + 20 * DAY);
    expect(b.endEstimated).toBe(true);
  });

  it("without a due date, ends at the estimate, marked as one, with no even pace", () => {
    const b = epicBurndown([done(2, 10), done(4, 20), open(6), open(8)], null, at(22))!;
    expect(b).toMatchObject({ paceTo: null, endEstimated: true, end: at(22) + 20 * DAY });
  });

  it("with nothing done yet, has no estimate and runs a while past now", () => {
    const b = epicBurndown([open(2), open(4)], null, at(22))!;
    expect(b.estimate).toBeNull();
    expect(b.end).toBe(at(22) + 7 * DAY);
    expect(b.projection).toEqual({ at: at(22) + 7 * DAY, left: 2 });
  });

  it("done, has nothing ahead", () => {
    const b = epicBurndown([done(2, 10), done(4, 20)], null, at(22))!;
    expect(b).toMatchObject({ left: 0, projection: null, estimate: null, endEstimated: false, end: at(22) });
  });

  it("is none without issues, or with none whose creation is known", () => {
    expect(epicBurndown([], "2026-12-20", at(22))).toBeNull();
    expect(epicBurndown([{ category: "todo" }], "2026-12-20", at(22))).toBeNull();
  });
});

describe("a change made in Jira from a chat", () => {
  const now = "2026-11-25T02:00:00.000Z";
  const read = {
    sprint: { name: "Sprint 24", start: "2026-11-22T09:00:00Z", end: "2026-12-06T09:00:00Z" },
    epics: [
      { ...epic("PAY-1", ["todo", "in_progress"]), progress: { done: 3, started: 1, total: 8 } },
      { ...epic("PAY-2", ["done"]), progress: { done: 1, started: 0, total: 2 } },
    ],
    strays: [{ key: "PAY-9", category: "todo" as const, assignee: null, avatar: null }],
    unparented: 1,
  };
  const issue = (over: Partial<ChangedIssue>): ChangedIssue => ({
    key: "PAY-1-0",
    title: "Refund emails",
    status: "In Progress",
    category: "in_progress",
    type: "Story",
    assignee: "Ana",
    avatar: null,
    due: null,
    link: null,
    epic: "PAY-1",
    sprints: ["Sprint 24"],
    ...over,
  });
  const still = { epic: false, sprint: false };

  it("shows a new status and assignee where the issue is, keeping its size, and recounts its epic", () => {
    const sized = { ...read, epics: [{ ...read.epics[0], issues: read.epics[0].issues.map((i, n) => (n ? i : { ...i, size: "L" })) }, read.epics[1]] };
    const next = sprintWithChange(sized, null, issue({}), still, now)!;
    expect(next.epics[0].issues[0]).toEqual({ key: "PAY-1-0", category: "in_progress", done_at: null, assignee: "Ana", avatar: null, type: "Story", size: "L" });
    expect(next.epics[0].progress).toEqual({ done: 3, started: 2, total: 8 });
    const done = sprintWithChange(read, null, issue({ category: "done", status: "Done" }), still, now)!;
    expect(done.epics[0].issues[0].done_at).toBe(now);
    expect(done.epics[0].progress).toEqual({ done: 4, started: 1, total: 8 });
  });

  it("keeps an unmoved issue where it is, whatever the read back says of its sprints", () => {
    const next = sprintWithChange(read, null, issue({ sprints: [], epic: null }), still, now)!;
    expect(next.epics[0].issues.map((i) => i.key)).toEqual(["PAY-1-0", "PAY-1-1"]);
    expect(next.strays).toHaveLength(1);
  });

  it("takes an issue out of its epic, into the sprint's issues in no epic", () => {
    const out = sprintWithChange(read, null, issue({ epic: null, category: "todo" }), { epic: true, sprint: false }, now)!;
    expect(out.epics[0].issues.map((i) => i.key)).toEqual(["PAY-1-1"]);
    expect(out.epics[0].progress).toEqual({ done: 3, started: 1, total: 7 });
    expect(out.strays.map((i) => i.key)).toEqual(["PAY-9", "PAY-1-0"]);
    expect(out.unparented).toBe(2);
  });

  it("moves an issue between epics, and out of the sprint", () => {
    const moved = sprintWithChange(read, null, issue({ epic: "PAY-2", category: "todo" }), { epic: true, sprint: false }, now)!;
    expect(moved.epics[0].issues.map((i) => i.key)).toEqual(["PAY-1-1"]);
    expect(moved.epics[1].issues.map((i) => i.key)).toEqual(["PAY-2-0", "PAY-1-0"]);
    expect(moved.epics[0].progress).toEqual({ done: 3, started: 1, total: 7 });
    expect(moved.epics[1].progress).toEqual({ done: 1, started: 0, total: 3 });
    const out = sprintWithChange(read, null, issue({ key: "PAY-9", epic: null, category: "todo", sprints: [] }), { epic: false, sprint: true }, now)!;
    expect(out.strays).toEqual([]);
    expect(out.unparented).toBe(0);
  });

  it("adds an issue that joined the sprint when it knows where it was, and asks for a read again when it doesn't", () => {
    const joining = issue({ key: "PAY-1-7", category: "todo" });
    const added = sprintWithChange(read, { category: "todo", epic: "PAY-1" }, joining, { epic: false, sprint: true }, now)!;
    expect(added.epics[0].issues.map((i) => i.key)).toEqual(["PAY-1-0", "PAY-1-1", "PAY-1-7"]);
    expect(added.epics[0].progress).toEqual({ done: 3, started: 1, total: 8 });
    expect(sprintWithChange(read, null, joining, { epic: false, sprint: true }, now)).toBeNull();
    // Into an epic the read doesn't have: it can't list it without reading the epic.
    expect(sprintWithChange(read, { category: "todo", epic: null }, issue({ key: "PAY-1-7", epic: "PAY-5" }), { epic: true, sprint: true }, now)).toBeNull();
    // Into a sprint whose points are counted: its size isn't known without reading it.
    expect(sprintWithChange({ ...read, size_field: "customfield_1" }, { category: "todo", epic: "PAY-1" }, joining, { epic: false, sprint: true }, now)).toBeNull();
  });

  it("changes an epic's own fields, and leaves a read it doesn't touch alone", () => {
    const next = sprintWithChange(read, null, issue({ key: "PAY-2", title: "Payouts", status: "Done", category: "done", due: "2026-12-01", assignee: "Ben", epic: null }), still, now)!;
    expect(next.epics[1]).toMatchObject({ title: "Payouts", status: "Done", category: "done", due: "2026-12-01", assignee: "Ben" });
    expect(sprintWithChange(read, { category: "todo", epic: "OPS-1" }, issue({ key: "OPS-2", epic: "OPS-1", sprints: [] }), still, now)).toBe(read);
  });

  it("brings the reads of epics' issues up to date", () => {
    const at = "2026-11-25T01:00:00.000Z";
    const reads = {
      "PAY-1": { issues: [{ key: "PAY-1-0", title: "Refund emails", status: "To Do", category: "todo" as const, created: at }], at },
      "PAY-2": { issues: [], at },
      "person:Ana@PAY:current": { issues: [{ key: "PAY-1-0", title: "Refund emails", status: "To Do", category: "todo" as const }], at },
    };
    const same = childrenWithChange(reads, issue({ due: "2026-12-12" }), false, now);
    expect(same["PAY-1"].issues[0]).toMatchObject({ status: "In Progress", category: "in_progress", assignee: "Ana", due: "2026-12-12", created: at });
    expect(same["person:Ana@PAY:current"].issues[0]).toMatchObject({ status: "In Progress" });
    expect(same["PAY-2"]).toBeUndefined();
    const moved = childrenWithChange(reads, issue({ epic: "PAY-2" }), true, now);
    expect(moved["PAY-1"].issues).toEqual([]);
    expect(moved["PAY-2"].issues.map((i) => i.key)).toEqual(["PAY-1-0"]);
  });

  it("asks Jira for only the changes on the card", () => {
    const p = changeJiraIssuePrompt({ key: "PAY-3", status: "In Progress", assignee: "none", sprint: "backlog" });
    expect(p).toContain('move it to "In Progress"');
    expect(p).toContain('{"assignee": null}');
    expect(p).toContain('{"customfield_10020": null}');
    expect(p).not.toContain("Due date:");
    expect(p).not.toContain("Comment:");
    expect(p).toContain(ATLASSIAN_RULE);
    const q = changeJiraIssuePrompt({ key: "PAY-3", assignee: "Ana Lopez", due: "2026-12-12", sprint: "Sprint 25" });
    expect(q).toContain("lookupJiraAccountId");
    expect(q).toContain('{"duedate": "2026-12-12"}');
    expect(q).toContain('sprint = "Sprint 25"');
    const out = changeJiraIssuePrompt({ key: "PAY-3", epic: "none" });
    expect(out).toContain('{"parent": null}');
    expect(out).toContain('{"customfield_10014": null}');
    expect(changeJiraIssuePrompt({ key: "PAY-3", epic: "PAY-1" })).toContain('{"parent": {"key": "PAY-1"}}');
  });
});


describe("the marks before Jira links", () => {
  it("find the issue a link opens, and no other", async () => {
    const { jiraIssueKey } = await import("./jiraTypes");
    expect(jiraIssueKey("https://example.atlassian.net/browse/pay-12")).toBe("PAY-12");
    expect(jiraIssueKey("https://example.atlassian.net/jira/software/c/projects/PAY/boards/3?selectedIssue=PAY-4")).toBe("PAY-4");
    expect(jiraIssueKey("https://example.atlassian.net/wiki/spaces/PAY/pages/1/browse/PAY-1")).toBeNull();
    expect(jiraIssueKey("https://github.com/org/repo/browse/PAY-1")).toBeNull();
    expect(jiraIssueKey("not a link")).toBeNull();
    expect(jiraIssueKey(null)).toBeNull();
  });

  it("know each issue's type from what's been read, a read's word over a place's", async () => {
    const { issueTypesFrom } = await import("./jiraTypes");
    const at = "2026-11-25T01:00:00.000Z";
    const types = issueTypesFrom({
      sprints: {
        "PAY:current": {
          sprint: null,
          epics: [{ ...epic("PAY-1", []), issues: [{ key: "PAY-2", category: "todo", assignee: null, avatar: null, type: "Bug" }] }],
          unparented: 0,
          strays: [{ key: "PAY-9", category: "todo", assignee: null, avatar: null }],
          at,
        },
      },
      children: { "PAY-1": { issues: [{ key: "PAY-3", title: "T", status: "To Do", category: "todo", type: "Story" }], at }, "person:Ana@PAY:current": { issues: [], at } },
      projects: [
        {
          epics: [{ epic_key: "ops-1" }],
          snapshot: {
            path: {
              steps: [{ what: "W", status: "next", epic: { key: "OPS-2" }, items: [{ key: "PAY-2", title: "T", type: "Task", status: "next" }] }],
              initiatives: [{ id: "OPS-10", what: "I", jira: { key: "OPS-10" } }, { id: "OPS-11", what: "J", jira: { key: "OPS-11" }, realign: { to: "initiative", reason: "big" } }],
              created: [],
            } as never,
          },
        },
      ],
    });
    expect(types.get("PAY-1")).toBe("Epic");
    expect(types.get("PAY-2")).toBe("Bug");
    expect(types.get("PAY-3")).toBe("Story");
    expect(types.get("OPS-1")).toBe("Epic");
    expect(types.get("OPS-2")).toBe("Epic");
    expect(types.get("OPS-10")).toBe("Initiative");
    expect(types.get("OPS-11")).toBe("Epic");
    expect(types.has("PAY-9")).toBe(false);
    expect(types.has("PERSON:ANA@PAY:CURRENT")).toBe(false);
  });
});

describe("T-shirt sizes and points", () => {
  type Item = { key: string; category: "done" | "in_progress" | "todo"; done_at?: string | null; assignee?: string | null; avatar?: string | null; size?: string | null };
  const sprint = (issues: Item[], strays: Item[] = []) => ({
    sprint: { name: "Sprint 24", start: "2026-11-22T09:00:00Z", end: "2026-12-06T09:00:00Z" },
    epics: [{ ...epic("PAY-1", []), issues: issues.map((i) => ({ assignee: null, avatar: null, ...i })) }],
    strays: strays.map((i) => ({ assignee: null, avatar: null, ...i })),
  });
  it("count Fibonacci points for each size, and issues without one", async () => {
    const { epicPoints, pointsOf, pointsTally, sizeFieldJql, sizeOf } = await import("./sizes");
    expect(["XS", "S", "M", "L", "XL", "XXL"].map(pointsOf)).toEqual([1, 2, 3, 5, 8, 13]);
    expect(sizeOf(" xl ")).toBe("XL");
    expect(pointsOf("Huge")).toBeNull();
    expect(pointsOf(null)).toBeNull();
    expect(
      pointsTally([
        { category: "done", size: "M" },
        { category: "in_progress", size: "L" },
        { category: "todo", size: "XXL" },
        { category: "todo", size: null },
      ]),
    ).toEqual({ done: 3, started: 5, total: 21, unsized: 1 });
    expect(epicPoints(["M:done", "XS:in_progress", "L:todo", "Huge:todo"], 6)).toEqual({ done: 3, started: 1, total: 9, unsized: 3 });
    expect(epicPoints(null, 6)).toBeNull();
    expect(sizeFieldJql("customfield_10349")).toBe("cf[10349]");
  });

  it("chart a burndown in points, counting none for an issue without a size", () => {
    const s = sprint(
      [
        { key: "A", category: "done", done_at: "2026-11-23T10:00:00Z", size: "L", assignee: null, avatar: null },
        { key: "B", category: "todo", size: "M", assignee: null, avatar: null },
        { key: "C", category: "todo", size: null, assignee: null, avatar: null },
      ],
      [],
    );
    const now = Date.parse("2026-11-25T12:00:00Z");
    const tickets = burndown(s, now)!;
    const points = burndown(s, now, undefined, "points")!;
    expect(tickets).toMatchObject({ total: 3, left: 2, unit: "tickets", unsized: 0 });
    expect(points).toMatchObject({ total: 8, left: 3, unit: "points", unsized: 1 });
    expect(points.steps.map((x) => x.left)).toEqual([8, 3, 3]);
    // No sizes at all: no points chart.
    expect(burndown({ ...s, epics: [{ ...s.epics[0], issues: s.epics[0].issues.map((i) => ({ ...i, size: null })) }] }, now, undefined, "points")).toBeNull();
  });

  it("give each person their points", () => {
    const people = sprintPeople(sprint([{ key: "A", category: "done", assignee: "Ana", size: "XL" }, { key: "B", category: "todo", assignee: "Ana", size: "L" }, { key: "C", category: "todo", assignee: "Ben", size: null }], []));
    expect(people[0]).toMatchObject({ name: "Ana", points: { done: 8, started: 0, total: 13, unsized: 0 } });
    expect(people[1]).toMatchObject({ name: "Ben", points: { total: 0, unsized: 1 } });
  });

  it("ask for sizes: finding the field the first time, by its id after, and none for a project without one", () => {
    const find = sprintEpicsPrompt("PAY", "current");
    expect(find).toContain("1b. Find the field the project keeps T-shirt sizes in");
    // Chosen by the sprint's own issues, not the project's (whose old issues can have an older field).
    expect(find).toContain("count how many of this sprint's issues have each set, all at once: `project = PAY AND issuetype not in subTaskIssueTypes() AND sprint = <its id> AND cf[<its number>] is not EMPTY`");
    expect(find).toContain('"size_field": string|null');
    const known = sprintEpicsPrompt("PAY", "current", "customfield_10349");
    expect(known).not.toContain("1b.");
    expect(known).toContain('fields ["customfield_10014", "assignee", "issuetype", "customfield_10349"]');
    expect(known).toContain("AND cf[10349] is not EMPTY");
    expect(known).toContain('"sized": [string]|null');
    const none = sprintEpicsPrompt("PAY", "current", null);
    expect(none).not.toContain("is not EMPTY");
    expect(changeJiraIssuePrompt).toBeTypeOf("function");
  });
});

