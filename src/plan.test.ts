import { describe, expect, it, vi } from "vitest";
import type { PersonRecord } from "./db";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./db", () => ({}));
vi.mock("./jobs", () => ({}));
vi.mock("./claude", () => ({}));

const { codeLink, codeScope, dayOf, planMap, epicDescription, epicPeople, epicProgress, epicProjectKeys, epicSpan, initiativeSpan, initiativeStatus, openAtFirst, placeLeftovers, placeRequirements, planGroups, unplacedRequirements, planTimeline, proposedMove, at, withEpicCreated, withInitiativeApplied, withItemCreated, withItemMoved, withRequirementIssue, withStoryApplied, itemDescription, keysIn, placeCode, EPIC_DAYS } = await import("./plan");
const { initials, nameHue } = await import("./faces");
const { avatarIndex, importanceOf, mergePeople, mergeProfile, recordedPeople, withCloudJiraLinks } = await import("./projects");
const { applyInitiativePrompt, applyStoryPrompt, createEpicPrompt, createItemPrompt, moveIssuePrompt, projectPrompt, unplacedNote } = await import("./prompts");
const { PathStep, PathToShip, ProjectProfile, ProjectSnapshot } = await import("./schema");

const step = (over: Record<string, unknown>) => PathStep.parse({ what: "Refund API", status: "in_progress", ...over });
const item = (title: string, status: string, over: Record<string, unknown> = {}) => ({ key: null, title, status, assignee: null, date: null, link: null, ...over });

describe("a path of epics", () => {
  it("reads an epic with its stories, and an older stage without them", () => {
    const s = step({ epic: { key: "OPS-1", link: "https://x.atlassian.net/browse/OPS-1" }, items: [item("Endpoint", "done", { key: "OPS-2" }), item("Odd", "weird")] });
    expect(s.epic?.key).toBe("OPS-1");
    expect(s.items.map((i) => i.status)).toEqual(["done", "next"]);
    const old = step({});
    expect(old.items).toEqual([]);
    expect(old.epic ?? null).toBeNull();
    expect(step({ items: "lots", epic: "OPS-1" }).items).toEqual([]);
  });

  it("counts an epic's done stories and lists its people once, owners first", () => {
    const s = step({ owners: ["Kim Lee"], items: [item("A", "done", { assignee: "Ann Bo" }), item("B", "next", { assignee: "kim lee" }), item("C", "in_progress", { assignee: "Raj Das" })] });
    expect(epicProgress(s)).toEqual({ done: 1, total: 3 });
    expect(epicPeople(s)).toEqual(["Kim Lee", "Raj Das"]);
  });

  it("runs an epic from its start to its date, four weeks when only one end is known", () => {
    expect(epicSpan(step({ start: "2026-11-02", date: "2026-11-27" }))).toEqual({ start: dayOf("2026-11-02"), end: dayOf("2026-11-27"), assumed: false });
    expect(epicSpan(step({ date: "2026-11-30" }))).toEqual({ start: dayOf("2026-11-30")! - EPIC_DAYS + 1, end: dayOf("2026-11-30"), assumed: true });
    expect(epicSpan(step({ start: "2026-11-02" }))?.assumed).toBe(true);
    expect(epicSpan(step({ items: [item("A", "next", { date: "2026-12-04" })] }))?.end).toBe(dayOf("2026-12-04"));
    expect(epicSpan(step({}))).toBeNull();
  });

  it("lays a timeline over every epic, today and the ship date, labeled by week", () => {
    const now = dayOf("2026-11-17")!;
    const t = planTimeline([step({ start: "2026-11-02", date: "2026-11-27" }), step({ date: "2026-12-11" })], "2026-12-15", now)!;
    expect(t.from).toBeLessThanOrEqual(dayOf("2026-11-02")!);
    expect(t.to).toBeGreaterThanOrEqual(dayOf("2026-12-15")!);
    expect(t.ship).toBe(dayOf("2026-12-15"));
    expect(t.ticks.length).toBeGreaterThanOrEqual(2);
    expect(t.ticks.length).toBeLessThanOrEqual(5);
    // Every label falls on a Monday.
    expect(t.ticks.every((tick) => new Date(tick.day * 86_400_000).getUTCDay() === 1)).toBe(true);
    expect(at(t, t.from)).toBe(0);
    expect(at(t, t.to + 30)).toBe(100);
    expect(planTimeline([step({})], null, now)).toBeNull();
  });

  it("reaches back six weeks at most, so old work runs off its edge", () => {
    const now = dayOf("2026-11-17")!;
    const t = planTimeline([step({ start: "2026-03-01", date: "2026-04-01", status: "done" })], null, now)!;
    expect(t.from).toBeGreaterThanOrEqual(now - 45);
  });

  it("opens the epics underway at first, else the next one", () => {
    const withItems = { items: [item("A", "next")] };
    expect([...openAtFirst([step({ status: "done", ...withItems }), step({ status: "in_progress", ...withItems }), step({ status: "blocked", ...withItems })])]).toEqual([1, 2]);
    expect([...openAtFirst([step({ status: "done", ...withItems }), step({ status: "next", ...withItems })])]).toEqual([1]);
    expect([...openAtFirst([step({ status: "in_progress" })])]).toEqual([]);
  });

  it("moves its epics' and stories' Jira links onto the cloud site", () => {
    const snapshot = ProjectSnapshot.parse({
      description: "", status: "on_track", status_reason: "", raci: { role: "responsible", reason: "" }, priority: { level: "P2", reason: "" }, blockers: [], my_tasks: [],
      path: { steps: [step({ epic: { key: "OPS-1", link: "https://jira.old.example/browse/OPS-1" }, items: [item("A", "next", { key: "OPS-2", link: "https://jira.old.example/browse/OPS-2" })] })] },
    });
    const profile = ProjectProfile.parse({ goal: "" });
    const fixed = withCloudJiraLinks(snapshot, profile, "https://x.atlassian.net");
    expect(fixed.snapshot.path?.steps[0].epic?.link).toBe("https://x.atlassian.net/browse/OPS-1");
    expect(fixed.snapshot.path?.steps[0].items[0].link).toBe("https://x.atlassian.net/browse/OPS-2");
  });
});

describe("people", () => {
  const person = (name: string, over: Record<string, unknown> = {}) => ({ name, slack_user_id: null, role: "eng", ...over });

  it("keeps what a refresh left out about someone, and takes what it says", () => {
    const prev = [person("Kim Lee", { slack_user_id: "U1", avatar: "https://a/k.png", importance: 5, working_on: "API" }), person("Ann Bo", { importance: 2 })];
    const merged = mergePeople([person("Kim Lee", { role: "eng lead", working_on: "" })], prev);
    expect(merged[0]).toMatchObject({ name: "Kim Lee", role: "eng lead", slack_user_id: "U1", avatar: "https://a/k.png", importance: 5, working_on: "" });
    expect(merged[1].name).toBe("Ann Bo");
    const profile = mergeProfile(ProjectProfile.parse({ goal: "g", people: prev }), ProjectProfile.parse({ goal: "g", people: [person("Kim Lee")] }));
    expect(profile.people[0].avatar).toBe("https://a/k.png");
  });

  it("reads an odd importance as none, and rates the unrated by where they're listed", () => {
    expect(ProjectProfile.parse({ goal: "", people: [person("A", { importance: 9 })] }).people[0].importance).toBeNull();
    expect(importanceOf({ importance: 3 }, 0)).toBe(3);
    expect([0, 3, 7, 12].map((i) => importanceOf({}, i))).toEqual([4, 3, 2, 1]);
  });

  it("records each person's part in a project, moving a record kept by name to their Slack id", () => {
    const at = "2026-11-17T10:00:00Z";
    const records: Record<string, PersonRecord> = {
      "name:kim lee": { name: "Kim Lee", slack_user_id: null, avatar: "https://a/k.png", projects: { P2: { role: "pm", importance: 4, working_on: "", at } }, at },
      U9: { name: "Gone Person", slack_user_id: "U9", avatar: null, projects: { P1: { role: "qa", importance: 2, working_on: "", at } }, at },
    };
    const { put, remove } = recordedPeople(records, "P1", [person("Kim Lee", { slack_user_id: "U1", importance: 5, working_on: "Refund API" })], "2026-11-17T12:00:00Z");
    const byKey = Object.fromEntries(put);
    expect(remove).toEqual(["name:kim lee"]);
    expect(byKey.U1).toMatchObject({ name: "Kim Lee", slack_user_id: "U1", avatar: "https://a/k.png" });
    expect(byKey.U1.projects).toMatchObject({ P1: { role: "eng", importance: 5, working_on: "Refund API" }, P2: { role: "pm" } });
    // Someone no longer listed is taken off the project, and kept.
    expect(byKey.U9.projects).toEqual({});
  });

  it("changes nothing when nothing about someone changed, and never merges two Slack ids by name", () => {
    const at = "2026-11-17T10:00:00Z";
    const records: Record<string, PersonRecord> = { U1: { name: "Kim Lee", slack_user_id: "U1", avatar: null, projects: { P1: { role: "eng", importance: 4, working_on: "", at } }, at } };
    expect(recordedPeople(records, "P1", [person("Kim Lee", { slack_user_id: "U1", importance: 4, working_on: "" })], "later").put).toEqual([]);
    const other = recordedPeople(records, "P1", [person("Kim Lee", { slack_user_id: "U2", importance: 4 })], "later");
    expect(other.remove).toEqual([]);
    expect(Object.fromEntries(other.put).U2.slack_user_id).toBe("U2");
  });

  it("indexes faces by name", () => {
    const at = "x";
    expect(avatarIndex([{ name: "Kim Lee", slack_user_id: "U1", avatar: "https://a/k.png", projects: {}, at }, { name: "No Face", slack_user_id: null, avatar: null, projects: {}, at }])).toEqual({ "kim lee": "https://a/k.png" });
  });
});

describe("faces", () => {
  it("names a face by its initials, with a color of its own", () => {
    expect(initials("Jackie Jones")).toBe("JJ");
    expect(initials("Cher")).toBe("C");
    expect(initials("  ")).toBe("?");
    expect(nameHue("Kim Lee")).toBe(nameHue(" kim lee "));
  });
});

describe("the refresh prompt", () => {
  const input = { userId: "U1", previous: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z"), channels: [{ channel_id: "C1", name: "tmp-refunds" }] };

  it("organizes the work in the user's levels, and asks for each epic's stories and dates", () => {
    const text = projectPrompt({ ...input, profile: null, epics: [{ key: "OPS-1", title: "Refunds backend" }] });
    expect(text).toContain("an epic is a project in Linear's sense: one finishable outcome a small team ships in weeks, not months (usually two to six)");
    expect(text).toContain("an issue (a Story, Task or Bug in Jira, or one of the project's own types) is one concrete piece of work with a clear result");
    expect(text).toContain("its stages (internal, beta, launch) are milestones within it, not more epics");
    expect(text).not.toMatch(/acceptance criteria and could|fitting in a sprint|span sprints/);
    expect(text).toContain("Propose an epic (epic null) only for an epic in its own right");
    expect(text).toContain("Place everything by what it effectively is, not what Jira calls it.");
    expect(text).toContain("it's an initiative (see initiatives) with jira its key and webUrl");
    expect(text).toContain("it's an item, with key its key, under the epic it belongs in");
    expect(text).toContain("Nothing here changes Jira");
    expect(text).toContain('"jira_parent": string|null, "realign": {"from": "epic", "reason": string}|null');
    expect(text).toContain('"initiatives": [{"id": string');
    expect(text).toContain("customfield_10020");
    expect(text).toContain('"items": [{"key": string|null');
    expect(text).toContain('"importance": 1|2|3|4|5, "working_on": string, "raci": "responsible"|"accountable"|"consulted"|"informed", "avatar": string|null');
  });

  it("keeps the faces it has out of the profile it shows, and says whose it has", () => {
    const profile = ProjectProfile.parse({ goal: "g", people: [{ name: "Kim Lee", role: "eng", avatar: "https://secure.example/avatar/abc" }, { name: "Ann Bo", role: "pm" }] });
    const text = projectPrompt({ ...input, profile });
    expect(text).not.toContain("https://secure.example/avatar/abc");
    expect(text).toContain("You already have the avatars of Kim Lee: return avatar null for them.");
  });
});

describe("requirements in the plan", () => {
  it("puts each requirement under the story that delivers it, else its epic, once, and leaves the rest over", () => {
    const steps = [
      step({ requirements: ["r1", "r3"], items: [item("A", "next", { requirements: ["r2", "r1"] }), item("B", "next")] }),
      step({ requirements: ["r2", "gone"], items: [] }),
    ];
    const { byStep, byItem, rest } = placeRequirements(steps, ["r1", "r2", "r3", "r4"]);
    expect([...byItem]).toEqual([["0:0", ["r2", "r1"]]]);
    expect([...byStep]).toEqual([[0, ["r3"]]]);
    expect(rest).toEqual(["r4"]);
    // An older path places nothing: every requirement is left over.
    expect(placeRequirements([step({})], ["r1"]).rest).toEqual(["r1"]);
  });

  it("finds the requirements a plan leaves out, but not descoped ones or ones on an epic or initiative", () => {
    const path = {
      steps: [step({ requirements: ["R2"], items: [item("Add refunds topic", "next", { requirements: ["R1"] })] })],
      initiatives: [{ id: "i1", requirements: ["R3"] }],
    };
    expect(unplacedRequirements(path, ["R1", "R2", "R3", "R4", "R5", "R6"], ["R5"])).toEqual(["R4", "R6"]);
    expect(unplacedRequirements(null, ["R1"])).toEqual(["R1"]);
  });

  it("puts a requirement left out in the epic with the most of its section, and leaves one no epic shares out", () => {
    const requirements = [
      { id: "R1", section: "Refund form" },
      { id: "R2", section: "Refund form" },
      { id: "R3", section: "Card refunds" },
      { id: "R4", section: "Refund form" },
      { id: "R5", section: "Card refunds" },
      { id: "R6", section: "Rollout" },
      { id: "R7", section: null },
      { id: "R8", section: "Refund form" },
    ];
    const path = PathToShip.parse({
      steps: [
        step({ what: "Card refund processing", items: [item("Call the card vendor", "next", { requirements: ["R3", "R1"] })] }),
        step({ what: "Refund requests in order history", items: [item("Show the refund form", "next", { requirements: ["R2"] })], requirements: ["R4"] }),
      ],
    });
    // R1 is in the first epic and R2 and R4 are in the second: the second has more of the refund form.
    const placed = placeLeftovers(path, requirements, ["R8"]);
    expect(placed.steps.map((s) => s.requirements)).toEqual([["R5"], ["R4"]]);
    expect(unplacedRequirements(placed, requirements.map((r) => r.id), ["R8"])).toEqual(["R6", "R7"]);
    // A tie goes to the first epic; nothing to place leaves the plan as it is.
    const tied = PathToShip.parse({ steps: [step({ items: [item("A", "next", { requirements: ["R1"] })] }), step({ items: [item("B", "next", { requirements: ["R2"] })] })] });
    expect(placeLeftovers(tied, requirements.slice(0, 4)).steps.map((s) => s.requirements)).toEqual([["R4"], []]);
    expect(placeLeftovers(tied, requirements.slice(0, 2))).toBe(tied);
  });

  it("tells the refresh which requirements it left out, and that removing a cut feature is work", () => {
    const note = unplacedNote([
      { id: "R4", text: "Remove the old refund form." },
      { id: "R6", text: "Roll out in staging, then to everyone." },
    ]);
    expect(note).toContain('R4 ("Remove the old refund form.")');
    expect(note).toContain("2 requirements");
    expect(note).toMatch(/Removing something that was cut is work/);
    expect(note).toMatch(/"descoped"/);
  });

  it("asks the refresh to place every requirement that isn't descoped", () => {
    const prompt = projectPrompt({
      userId: "U1",
      previous: null,
      lastRefreshedAt: null,
      now: new Date("2026-11-16T10:00:00Z"),
      channels: [{ channel_id: "C1", name: "tmp-refunds" }],
      profile: null,
      guide: { title: "Refunds TDD", link: "https://example.com/doc", requirements: [{ id: "R1", text: "Remove the old refund form.", section: "Refund form" }], progress: [] },
    });
    expect(prompt).toContain('Leave out only the ones whose requirements_progress status is "descoped"');
    expect(prompt).toContain("Removing something that was cut (a feature, an option, a field) is work");
  });

  it("asks the refresh for the pull requests and branches each ticket links itself", () => {
    const prompt = projectPrompt({
      userId: "U1",
      previous: null,
      lastRefreshedAt: null,
      now: new Date("2026-11-16T10:00:00Z"),
      channels: [],
      profile: null,
      epics: [{ key: "PAY-10", title: "Refund requests" }],
    });
    expect(prompt).toContain('`(key in (PAY-10) OR parent in (PAY-10)) AND text ~ "github"`, fields ["description", "comment"]');
    expect(prompt).toContain("Never one you only match by name");
    expect(prompt).toContain('"requirements": [string], "code": [string], "suggested_code": [string]}]}]');
    expect(prompt).toContain("a pull request or branch that's part of this project is work on it, so it belongs to an issue");
    expect(prompt).toContain("Never a dependency bump, tooling change or another project's work, even in the same repo");
  });
});

describe("creating a proposed epic in Jira", () => {
  it("offers its stories' Jira projects first, then the project's other epics'", () => {
    const s = step({ items: [item("A", "next", { key: "WEB-1" }), item("B", "next", { key: "PAY-2" }), item("C", "next", { key: "PAY-3" }), item("D", "next")] });
    expect(epicProjectKeys(s, ["OPS-249", "WEB-226", "nonsense"])).toEqual(["PAY", "WEB", "OPS"]);
    expect(epicProjectKeys(step({}), [])).toEqual([]);
  });

  it("describes it with what it delivers, its work and its requirements", () => {
    const s = step({ summary: "QA, UAT with CS, and the launch.", items: [item("UAT sign-off", "next", { key: "WEB-230" }), item("Legal answer", "next")] });
    expect(epicDescription(s, ["Refunds within 14 days"], "Refunds PRD")).toBe(
      "QA, UAT with CS, and the launch.\n\nStories and tasks:\n- WEB-230 UAT sign-off\n- Legal answer (task, no ticket yet)\n\nRequirements it delivers (from Refunds PRD):\n- Refunds within 14 days",
    );
    expect(epicDescription(step({}), [], null)).toBe("");
  });

  it("marks the proposed epic as created, and nothing else", () => {
    const path = { now: "", steps: [step({ what: "Launch", epic: { key: "X-1", link: null } }), step({ what: "Launch" }), step({ what: "Launch" })] };
    const next = withEpicCreated(path, "Launch", { key: "WEB-9", link: "https://x/browse/WEB-9" }, "Refunds ready to launch");
    expect(next.steps.map((s) => s.epic?.key ?? null)).toEqual(["X-1", "WEB-9", null]);
    expect(next.steps[1].what).toBe("Refunds ready to launch");
    expect(next.steps[0]).toBe(path.steps[0]);
  });

  it("creates one epic as reviewed, and moves only the tickets ticked", () => {
    const text = createEpicPrompt({ projectKey: "WEB", summary: 'Refunds "ready"', description: "Line one\n- WEB-230", move: ["WEB-230"] });
    expect(text).toContain('projectKey "WEB", issueTypeName "Epic", summary "Refunds \'ready\'"');
    expect(text).toContain("<<<DESCRIPTION\nLine one\n- WEB-230\nDESCRIPTION>>>");
    expect(text).toContain('fields {"parent": {"key": "<the new epic\'s key>"}}: WEB-230');
    expect(createEpicPrompt({ projectKey: "WEB", summary: "S", description: "", move: [] })).not.toContain("editJiraIssue");
  });

  it("asks the refresh to put each of the doc's requirements under the issue that delivers it, only when there's a doc", () => {
    const base = { userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z"), channels: [] };
    const withDoc = projectPrompt({ ...base, guide: { title: "PRD", link: "https://d", requirements: [{ id: "r1", text: "Refunds" }], progress: [] } });
    expect(withDoc).toContain("every requirement of the guiding doc (by its id, see requirements_progress) goes in exactly one place, the requirements of the story or task that delivers it");
    expect(withDoc).toContain("First look for an existing ticket that does");
    expect(withDoc).toContain("Only when no ticket does, propose the issue that would");
    expect(withDoc).toContain("- requirements: [] (epics deliver requirements through their stories and tasks).");
    expect(projectPrompt(base)).toContain("Items have requirements: [] (no requirements were given).");
  });

  it("asks the refresh to structure the work as modern product teams do, and to review it", () => {
    const text = projectPrompt({ userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z"), channels: [] });
    expect(text).toContain("An epic is a project in the modern sense: one shared, finishable outcome");
    expect(text).toContain("never by role, layer or phase");
    expect(text).toContain("never a user story");
    expect(text).toContain("release stages (internal, beta, launch) are milestones within one epic's work");
    expect(text).toContain("review the whole structure as the project's lead would");
    expect(text).not.toContain("written as their goal");
    expect(text).not.toContain("named by what users or the business can do");
    expect(text).toContain("a short noun phrase for what it delivers");
    expect(text).toContain("never a user story (\"As a buyer, I want…\") or a sentence about a user");
    expect(text).toContain("Rename every proposed epic and every issue in no ticket the previous path named otherwise");
  });
});

describe("initiatives and changes Demian proposes to Jira", () => {
  const initiative = (id: string, over: Record<string, unknown> = {}) => ({ id, what: `Initiative ${id}`, summary: null, jira: null, realign: null, requirements: [], ...over });

  it("reads a path with initiatives, and one from before without them", () => {
    const path = PathToShip.parse({ steps: [step({ initiative: "i1" })], initiatives: [initiative("i1", { realign: { from: "epic", reason: "Three teams' work" } })] });
    expect(path.initiatives[0].realign?.reason).toBe("Three teams' work");
    expect(PathToShip.parse({ steps: [] }).initiatives).toEqual([]);
    expect(PathToShip.parse({ steps: [], initiatives: "lots" }).initiatives).toEqual([]);
  });

  it("groups epics under their initiatives in order, with the ones that stand alone where they are", () => {
    const path = { steps: [step({ what: "A" }), step({ what: "B", initiative: "i1" }), step({ what: "C" }), step({ what: "D", initiative: "i1" }), step({ what: "E", initiative: "gone" })], initiatives: [initiative("i1")] };
    const groups = planGroups(path);
    expect(groups.map((g) => [g.initiative?.id ?? null, g.steps.map((s) => s.step.what)])).toEqual([
      [null, ["A"]],
      ["i1", ["B", "D"]],
      [null, ["C"]],
      [null, ["E"]],
    ]);
  });

  it("gives an initiative its epics' status and span", () => {
    expect(initiativeStatus([step({ status: "done" }), step({ status: "done" })])).toBe("done");
    expect(initiativeStatus([step({ status: "blocked" }), step({ status: "next" })])).toBe("blocked");
    expect(initiativeStatus([step({ status: "blocked" }), step({ status: "in_progress" })])).toBe("in_progress");
    expect(initiativeStatus([step({ status: "done" }), step({ status: "next" })])).toBe("in_progress");
    expect(initiativeStatus([step({ status: "next" })])).toBe("next");
    expect(initiativeSpan([step({ start: "2026-11-02", date: "2026-11-20" }), step({ date: "2026-12-18" })])).toEqual({ start: dayOf("2026-11-02"), end: dayOf("2026-12-18"), assumed: false });
    expect(initiativeSpan([step({})])).toBeNull();
  });

  it("proposes moving a ticket only when the plan puts it somewhere Jira doesn't", () => {
    const inEpic = step({ epic: { key: "WEB-1", link: null } });
    expect(proposedMove(item("A", "next", { key: "WEB-2", jira_parent: "WEB-1" }), inEpic)).toBeUndefined();
    expect(proposedMove(item("A", "next", { key: "WEB-2", jira_parent: "OPS-9" }), inEpic)).toBe("OPS-9");
    expect(proposedMove(item("A", "next", { key: "WEB-2", jira_parent: null }), inEpic)).toBeNull();
    expect(proposedMove(item("A", "next", { key: "WEB-2", jira_parent: null }), step({ epic: null }))).toBeNull();
    expect(proposedMove(item("A", "next", { key: null, jira_parent: null }), inEpic)).toBeUndefined();
    expect(proposedMove(item("A", "next", { key: "WEB-5", jira_parent: null, realign: { from: "epic", reason: "" } }), inEpic)).toBeUndefined();
    // A path from before Demian knew where tickets are proposes nothing.
    expect(proposedMove({ key: "WEB-2", realign: null }, inEpic)).toBeUndefined();
  });

  it("places requirements across an initiative's epics on the initiative", () => {
    const { byInitiative, rest } = placeRequirements([step({ requirements: ["r1"] })], ["r1", "r2", "r3"], [initiative("i1", { requirements: ["r2", "r1"] })]);
    expect([...byInitiative]).toEqual([["i1", ["r2"]]]);
    expect(rest).toEqual(["r3"]);
  });

  it("records an applied initiative: its key, the epics it created, and what moved", () => {
    const path = {
      steps: [
        step({ what: "Refunds backend", initiative: "i1", epic: { key: "OPS-1", link: null }, items: [item("A", "next", { key: "OPS-2", jira_parent: "OPS-1" })] }),
        step({ what: "Partial refunds", initiative: "i1", epic: null, items: [item("B", "next", { key: "OPS-3", jira_parent: "OPS-1" })] }),
        step({ what: "Partial refunds", epic: null }),
      ],
      initiatives: [initiative("i1", { jira: { key: "OPS-1", link: null }, realign: { from: "epic", reason: "big" } })],
    };
    const next = withInitiativeApplied(path, "i1", { key: "OPS-50", link: "https://x/browse/OPS-50" }, [{ name: "partial refunds", key: "OPS-51" }], ["OPS-3"]);
    expect(next.initiatives[0]).toMatchObject({ jira: { key: "OPS-50" }, realign: null });
    expect(next.steps[1].epic?.key).toBe("OPS-51");
    expect(next.steps[1].items[0].jira_parent).toBe("OPS-51");
    // Only the initiative's own epics change.
    expect(next.steps[2].epic).toBeNull();
    expect(next.steps[0].items[0].jira_parent).toBe("OPS-1");
  });

  it("records a requirement's created ticket in its epic, or on the path when it has no epic, so it isn't offered again", () => {
    const path = { steps: [step({ what: "Refunds", epic: { key: "WEB-1", link: null }, requirements: ["r1"], items: [] })], created: [] };
    const ticket = { key: "WEB-9", link: "https://x/browse/WEB-9", title: "Refund partial amounts", type: "Story", parent: "WEB-1" };
    const inEpic = withRequirementIssue(path, "Refunds", "r1", ticket);
    expect(inEpic.steps[0].items).toEqual([expect.objectContaining({ key: "WEB-9", requirements: ["r1"], jira_parent: "WEB-1" })]);
    expect(inEpic.steps[0].requirements).toEqual([]);
    expect(inEpic.created).toEqual([]);
    // No epic, or the epic was renamed since: kept on the path, once.
    for (const where of [null, "Renamed epic"]) {
      const loose = withRequirementIssue(withRequirementIssue(path, where, "r2", { ...ticket, parent: null }), where, "r2", { ...ticket, key: "WEB-10", parent: null });
      expect(loose.steps).toEqual(path.steps);
      expect(loose.created).toEqual([{ requirement: "r2", key: "WEB-10", link: "https://x/browse/WEB-9", title: "Refund partial amounts", type: "Story" }]);
    }
  });

  it("asks a workstream's refresh for its epics' child keys, to match pull requests to them", () => {
    const base = { userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z"), channels: [] };
    expect(projectPrompt({ ...base, kind: "workstream" })).toContain("issues (its child issues' keys, from one searchJiraIssuesUsingJql `parent = <its key>`");
    expect(projectPrompt({ ...base, kind: "project" })).toContain(", issues [].");
  });

  it("puts each pull request and branch under the work whose key it names", () => {
    expect(keysIn("feature/pay-7772-review-types #12 [PAY-7772] Review")).toEqual(["PAY-7772"]);
    expect(keysIn("main")).toEqual([]);
    expect(keysIn("xy_pay-7772_fix")).toEqual(["PAY-7772"]);
    expect(keysIn("feature/PAY-12345.retry")).toEqual(["PAY-12345"]);
    const path = {
      initiatives: [{ id: "i1", what: "Receipts", summary: null, jira: { key: "PAY-1", link: null }, realign: null, requirements: [] }],
      steps: [step({ epic: { key: "PAY-10", link: null }, initiative: "i1", items: [item("Review types", "next", { key: "PAY-7772" }), item("Proposed", "next", { key: null, id: "t1" })] })],
    };
    const code = [
      { title: "#12 Review notification types", detail: "pay-7772-types" },
      { title: "#13 Wire the epic", detail: "PAY-10/wiring" },
      { title: "receipts-pay-1-spike", detail: null },
      { title: "#14 Bump deps", detail: "deps" },
    ];
    const placed = placeCode(path, code);
    // Matched by key only: suggested.
    expect(placed.byItem.get("0:0")).toEqual([{ code: code[0], tie: "named" }]);
    expect(placed.byStep.get(0)).toEqual([{ code: code[1], tie: "named" }]);
    expect(placed.byInitiative.get("i1")).toEqual([{ code: code[2], tie: "named" }]);
    expect(placed.rest).toEqual([code[3]]);
  });

  it("reads a pull request's or branch's link as what it points at", () => {
    expect(codeLink("https://github.com/Acme/Shop-Web/pull/41/files?w=1")).toEqual({ id: "pr:acme/shop-web#41", kind: "pr", repo: "acme/shop-web", name: "#41" });
    expect(codeLink("https://github.com/acme/shop-web/tree/feature/PAY-7772-refunds/")).toEqual({
      id: "branch:acme/shop-web:feature/PAY-7772-refunds",
      kind: "branch",
      repo: "acme/shop-web",
      name: "feature/PAY-7772-refunds",
    });
    expect(codeLink("https://github.com/acme/shop-web")).toBeNull();
    expect(codeLink("https://example.atlassian.net/browse/PAY-1")).toBeNull();
  });

  it("puts the pull requests and branches a ticket links under it as linked, before any key match", () => {
    const path = {
      steps: [
        step({
          epic: { key: "PAY-10", link: null },
          code: ["https://github.com/acme/shop-web/tree/refunds-ui"],
          items: [
            item("Review types", "next", { key: "PAY-7772", code: ["https://github.com/Acme/shop-web/pull/12", "https://github.com/acme/other/pull/3"] }),
            item("Wire the form", "next", { key: "PAY-7773" }),
          ],
        }),
      ],
    };
    const code = [
      // Names PAY-7773 but PAY-7772 links it: linked under PAY-7772.
      { title: "#12 Wire the PAY-7773 form", detail: "pay-7773-form", url: "https://github.com/acme/shop-web/pull/12" },
      { title: "#13 Form copy", detail: "pay-7773-copy", url: "https://github.com/acme/shop-web/pull/13" },
      { title: "refunds-ui", detail: "2 ahead", url: "https://github.com/acme/shop-web/tree/refunds-ui" },
    ];
    const fromLink = (url: string) => ({ title: `link ${url}`, detail: "", url });
    const placed = placeCode(path, code, fromLink);
    expect(placed.byItem.get("0:0")).toEqual([
      { code: code[0], tie: "linked" },
      // Linked but not read on GitHub: from its link alone.
      { code: fromLink("https://github.com/acme/other/pull/3"), tie: "linked" },
    ]);
    expect(placed.byItem.get("0:1")).toEqual([{ code: code[1], tie: "named" }]);
    expect(placed.byStep.get(0)).toEqual([{ code: code[2], tie: "linked" }]);
    // Without fromLink, only what was read shows.
    expect(placeCode(path, code).byItem.get("0:0")).toEqual([{ code: code[0], tie: "linked" }]);
  });

  it("puts code the refresh found for work under it, after a key match, and leaves out the rest", () => {
    const path = {
      steps: [
        step({
          items: [
            item("Wire the form", "next", { key: "PAY-7773", suggested_code: ["https://github.com/acme/shop-web/pull/30"] }),
            // Work in no ticket, proposed for the code it was found for.
            item("Run the batch migration", "next", { suggested_code: ["https://github.com/acme/shop-web/pull/31", "https://github.com/acme/shop-web/pull/32"] }),
          ],
        }),
      ],
    };
    const code = [
      { title: "#30 Form copy", detail: "form-copy", url: "https://github.com/acme/shop-web/pull/30" },
      // Found for the migration, but it names PAY-7773: its key wins.
      { title: "#31 PAY-7773 fix", detail: "fix", url: "https://github.com/acme/shop-web/pull/31" },
      { title: "#33 Bump deps", detail: "deps", url: "https://github.com/acme/shop-web/pull/33" },
    ];
    const fromLink = (url: string) => ({ title: url.split("/").pop()!, detail: "", url });
    const placed = placeCode(path, code, fromLink);
    expect(placed.byItem.get("0:0")).toEqual([
      { code: code[0], tie: "found" },
      { code: code[1], tie: "named" },
    ]);
    expect(placed.byItem.get("0:1")).toEqual([{ code: fromLink("https://github.com/acme/shop-web/pull/32"), tie: "found" }]);
    expect(placed.rest).toEqual([code[2]]);
  });

  it("scopes a project's code to its plan's keys and links", () => {
    const path = {
      steps: [
        step({
          epic: { key: "PAY-10", link: null },
          code: ["https://github.com/acme/shop-web/tree/epic"],
          items: [item("A", "next", { key: "pay-11", code: ["https://github.com/acme/shop-web/pull/1"] }), item("B", "next", { suggested_code: ["https://github.com/acme/shop-web/pull/2"] })],
        }),
      ],
      initiatives: [initiative("PAY-1", { jira: { key: "PAY-1", link: null } })],
    };
    expect(codeScope(path, [{ key: "PAY-20", issues: ["PAY-21"] }])).toEqual({
      keys: ["PAY-10", "PAY-11", "PAY-1", "PAY-20", "PAY-21"],
      links: ["https://github.com/acme/shop-web/tree/epic", "https://github.com/acme/shop-web/pull/1", "https://github.com/acme/shop-web/pull/2"],
    });
    expect(codeScope(null)).toEqual({ keys: [], links: [] });
  });

  it("links the code a proposed issue was found for once its ticket's description has it", () => {
    const path = PathToShip.parse({
      steps: [step({ items: [item("Run the batch migration", "next", { id: "t1", suggested_code: ["https://github.com/acme/shop-web/pull/31", "https://github.com/acme/shop-web/pull/32"] })] })],
    });
    const description = itemDescription({ what: "Batch migration", epic: null }, [], null, ["https://github.com/acme/shop-web/pull/31"]);
    expect(description).toContain("Pull requests and branches:\n- https://github.com/acme/shop-web/pull/31");
    const made = withItemCreated(path, { id: "t1", title: "Run the batch migration" }, { key: "PAY-40", link: null }, null, description).steps[0].items[0];
    expect(made).toMatchObject({ key: "PAY-40", code: ["https://github.com/acme/shop-web/pull/31"], suggested_code: ["https://github.com/acme/shop-web/pull/32"] });
  });

  it("creates a proposed story or task as reviewed, in its epic when that's in Jira, and records its ticket", () => {
    const text = createItemPrompt({ projectKey: "WEB", issueType: "Story", summary: 'Buyers "request" refunds', description: "Part of WEB-1, Refunds.", parent: "WEB-1" });
    expect(text).toContain('issueTypeName "Story", summary "Buyers \'request\' refunds", parent "WEB-1" (its epic)');
    expect(text).toContain("createJiraIssue exactly once");
    expect(text).toContain("Part of WEB-1, Refunds.");
    expect(text).toContain("isn't in WEB-1");
    const loose = createItemPrompt({ projectKey: "WEB", issueType: "Task", summary: "S", description: "", parent: null });
    expect(loose).not.toContain("parent \"");
    expect(loose).not.toContain("editJiraIssue");

    expect(itemDescription({ what: "Refunds", epic: { key: "WEB-1", link: null } }, ["Buyers can refund"], "TDD")).toBe("Part of WEB-1, Refunds.\n\nRequirements it delivers (from TDD):\n- Buyers can refund");
    expect(itemDescription({ what: "Refunds", epic: null }, [], null)).toBe("Part of Refunds.");

    const path = { steps: [step({ epic: { key: "WEB-1", link: null }, items: [item("A", "next", { key: "WEB-2" }), item("Share specs", "next", { key: null, id: "t1" }), item("Share specs", "next", { key: null, id: "t2" })] })] };
    const created = withItemCreated(path, { id: "t2", title: "Share specs" }, { key: "WEB-9", link: "https://x/browse/WEB-9" }, "WEB-1");
    expect(created.steps[0].items[1].key).toBeNull();
    expect(created.steps[0].items[2]).toMatchObject({ key: "WEB-9", link: "https://x/browse/WEB-9", jira_parent: "WEB-1" });
    // A path from before ids: by title, the first one with no ticket.
    expect(withItemCreated(path, { title: "Share specs" }, { key: "WEB-9", link: null }, null).steps[0].items[1]).toMatchObject({ key: "WEB-9", jira_parent: null });
  });

  it("records a story-sized epic made a story, a ticket moved, and a created epic's moved tickets", () => {
    const path = { steps: [step({ epic: { key: "WEB-1", link: null }, items: [item("Small", "next", { key: "WEB-9", realign: { from: "epic", reason: "days" } }), item("A", "next", { key: "WEB-2", jira_parent: null })] }), step({ what: "New", epic: null, items: [item("B", "next", { key: "WEB-3", jira_parent: null })] })] };
    const story = withStoryApplied(path, "WEB-9", { key: "WEB-77", link: "https://x/browse/WEB-77" }, "WEB-1");
    expect(story.steps[0].items[0]).toMatchObject({ key: "WEB-77", realign: null, jira_parent: "WEB-1" });
    expect(withItemMoved(path, "WEB-2", "WEB-1").steps[0].items[1].jira_parent).toBe("WEB-1");
    const created = withEpicCreated(path, "New", { key: "WEB-8", link: null }, "New epic", ["WEB-3"]);
    expect(created.steps[1].items[0].jira_parent).toBe("WEB-8");
  });

  it("asks Jira for exactly the reviewed initiative, epics and moves", () => {
    const text = applyInitiativePrompt({ projectKey: "OPS", key: null, summary: "Self-serve refunds", description: "D", newEpics: [{ name: "Partial refunds", description: "Partial", move: ["OPS-3"] }], epics: ["OPS-1"] });
    expect(text).toContain('issueTypeName "Initiative", summary "Self-serve refunds"');
    expect(text).toContain('2. Create the epic "Partial refunds"');
    expect(text).toContain("Then move OPS-3 into it");
    expect(text).toContain("3. Put each of these epics under the initiative, once each, with editJiraIssue fields {\"parent\": {\"key\": \"<the initiative's key>\"}}: OPS-1.");
    expect(text).toContain("don't create, change, comment on, close or delete anything else");
    const existing = applyInitiativePrompt({ projectKey: "OPS", key: "OPS-40", summary: "S", description: "", newEpics: [], epics: ["OPS-1"] });
    expect(existing).toContain("The initiative is OPS-40, already in Jira: don't create it.");
    expect(existing).not.toContain('issueTypeName "Initiative"');
  });

  it("makes a story-sized epic a story, creating one in its place only when told to", () => {
    expect(applyStoryPrompt({ key: "WEB-9", into: "WEB-1", replace: false })).toContain("If Jira refuses, stop");
    const replace = applyStoryPrompt({ key: "WEB-9", into: "WEB-1", replace: true });
    expect(replace).toContain('{"issuetype": {"name": "Story"}, "parent": {"key": "WEB-1"}}');
    expect(replace).toContain("create one Story with createJiraIssue in the same project");
    expect(replace).toContain('Leave WEB-9 itself as it is.');
    expect(moveIssuePrompt("WEB-2", "WEB-1")).toContain('editJiraIssue once on WEB-2 with fields {"parent": {"key": "WEB-1"}}');
    expect(createEpicPrompt({ projectKey: "WEB", summary: "S", description: "", move: [], parent: "WEB-40" })).toContain('parent "WEB-40" (its initiative)');
  });
});

describe("the dependencies view", () => {
  it("shows the plan's own work, one lane per epic in plan order, with the order it waits in", () => {
    const path = PathToShip.parse({
      initiatives: [{ id: "i1", what: "Refunds" }],
      steps: [
        { what: "Backend", status: "in_progress", epic: { key: "OPS-1", link: null }, initiative: "i1", items: [
          { key: "OPS-2", title: "API", status: "done", waits_on: [] },
          { key: "OPS-3", title: "Endpoint", status: "in_progress", waits_on: [{ id: "OPS-2", source: "jira" }] },
        ] },
        { what: "Launch", status: "next", epic: null, items: [{ key: null, id: "t1", title: "Legal sign-off", status: "next", waits_on: [{ id: "OPS-3", source: "assumed", reason: "Needs the endpoint" }, { id: "GONE-1", source: "jira" }] }] },
        { what: "Docs", status: "next", epic: null, items: [] },
      ],
    });
    const { map, lanes } = planMap(path);
    expect(lanes).toEqual(["OPS-1 Backend", "Proposed: Launch", "Proposed: Docs"]);
    expect(planMap(path).proposed).toEqual(["Proposed: Launch", "Proposed: Docs"]);
    expect(map.items.map((i) => [i.id, i.track, i.jira?.key ?? null])).toEqual([
      ["OPS-2", "OPS-1 Backend", "OPS-2"],
      ["OPS-3", "OPS-1 Backend", "OPS-3"],
      ["t1", "Proposed: Launch", null],
      ["epic:2", "Proposed: Docs", null],
    ]);
    // Links only between work on the plan; one to a ticket-less task is Demian's assumption.
    expect(map.links.map((l) => `${l.from}>${l.to}:${l.source}`)).toEqual(["OPS-2>OPS-3:jira", "OPS-3>t1:assumed"]);
  });

  it("tells two epics of the same name apart", () => {
    const { lanes } = planMap(PathToShip.parse({ steps: [{ what: "QA", status: "next", epic: null }, { what: "QA", status: "next", epic: null }] }));
    expect(lanes).toEqual(["Proposed: QA", "Proposed: QA (2)"]);
  });

  it("asks the refresh for each story's dependencies, by id", () => {
    const base = { userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z"), channels: [], epics: [{ key: "OPS-1", title: "Backend" }] };
    const text = projectPrompt(base);
    expect(text).toContain('issueLinkType in (blocks, "is blocked by")');
    expect(text).toContain('"waits_on": [{"id": string, "source": "jira"|"assumed", "reason": string|null}]');
    expect(text).toContain("keeping the previous path's id for the same work");
  });
});

describe("tasks and older dependencies in the dependencies view", () => {
  const path = PathToShip.parse({
    steps: [
      { what: "Backend", status: "in_progress", epic: { key: "OPS-1", link: null }, items: [{ key: "OPS-2", title: "API", status: "done" }, { key: "OPS-3", title: "Endpoint", status: "next" }] },
      { what: "Launch", status: "next", epic: null, items: [{ key: null, id: "t1", title: "Sign-off", status: "next" }] },
    ],
  });

  it("puts your tasks beside the work they move, and the rest in a lane of their own", () => {
    const { map, lanes } = planMap(path, {
      tasks: [
        { id: "https://slack/p1", title: "Ask about the endpoint", status: "next", moves: ["OPS-3", "GONE-9"] },
        { id: "https://slack/p2", title: "Book the launch review", status: "in_progress", moves: [] },
      ],
    });
    expect(lanes[0]).toBe("Your tasks");
    const mine = map.items.filter((i) => i.mine);
    expect(mine.map((i) => [i.title, i.track, i.owner])).toEqual([
      ["Ask about the endpoint", "OPS-1 Backend", "You"],
      ["Book the launch review", "Your tasks", "You"],
    ]);
    expect(map.links.map((l) => `${l.from}>${l.to}`)).toEqual(["task:https://slack/p1>OPS-3"]);
  });

  it("shows older dependencies only while the plan has none of its own", () => {
    const older = [{ from: "OPS-2", to: "OPS-3", source: "assumed" as const, reason: "API first" }, { from: "OPS-2", to: "GONE-1", source: "jira" as const, reason: null }];
    expect(planMap(path, { links: older }).map.links.map((l) => `${l.from}>${l.to}`)).toEqual(["OPS-2>OPS-3"]);
    const withOwn = PathToShip.parse({ ...path, steps: [{ ...path.steps[0], items: [path.steps[0].items[0], { ...path.steps[0].items[1], waits_on: [{ id: "OPS-2", source: "jira" }] }] }] });
    expect(planMap(withOwn, { links: [{ from: "OPS-3", to: "OPS-2", source: "assumed", reason: null }] }).map.links.map((l) => `${l.from}>${l.to}:${l.source}`)).toEqual(["OPS-2>OPS-3:jira"]);
  });

  it("asks the refresh which work each task moves, and to carry over older dependencies", () => {
    const base = { userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z"), channels: [] };
    const text = projectPrompt({ ...base, dependencies: [{ from: "PAY-1", to: "PAY-2", reason: "Review first" }] });
    expect(text).toContain("moves: the ids of the work on the path");
    expect(text).toContain('"due": "YYYY-MM-DD"|null, "moves": [string]}]');
    expect(text).toContain("Dependencies Demian read earlier between these tickets (the first has to finish before the second): PAY-1 before PAY-2 (Review first).");
    expect(projectPrompt(base)).not.toContain("Dependencies Demian read earlier");
  });
});

describe("workstreams", () => {
  it("never asks a refresh to find a requirements doc, for a project or a workstream", () => {
    const base = { userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z"), channels: [] };
    expect(projectPrompt({ ...base, kind: "workstream" })).not.toContain("guide_doc");
    expect(projectPrompt({ ...base, kind: "project" })).not.toContain("guide_doc");
  });
});

describe("people's RACI", () => {
  it("keeps someone's RACI when a refresh leaves it out, and reads an odd one as none", () => {
    const merged = mergePeople([{ name: "Kim Lee", role: "eng" }], [{ name: "Kim Lee", role: "eng", raci: "accountable" }]);
    expect(merged[0].raci).toBe("accountable");
    expect(ProjectProfile.parse({ goal: "", people: [{ name: "A", role: "x", raci: "boss" }] }).people[0].raci).toBeNull();
  });
});

describe("issue types", () => {
  it("reads each item's issue type, and asks the refresh for real ones", () => {
    expect(PathStep.parse({ what: "E", status: "next", items: [{ key: "PAY-1", title: "T", status: "next", type: "Collaboration" }] }).items[0].type).toBe("Collaboration");
    const text = projectPrompt({ userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z"), channels: [], epics: [{ key: "PAY-1", title: "E" }] });
    expect(text).toContain('"issuetype"');
    expect(text).toContain("Propose an epic (epic null) only for an epic in its own right");
    expect(text).toContain("sharing requirements with another team, a review, a QA pass, a rollout step, a sign-off or a single change is an item");
    expect(text).toContain("A feature's testing, translation, analytics and rollout are part of its epic, not an epic of their own.");
    expect(text).toContain("The previous path may hold proposed epics from before these rules: check each one again every time");
    expect(text).toContain("getJiraProjectIssueTypesMetadata");
    expect(text).toContain('"type": string');
  });
});

describe("the refresh's pull requests", () => {
  const base = { userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z"), channels: [{ channel_id: "C1", name: "tmp-refunds" }] };

  it("gives only the project's own open pull requests, and none when it has none", () => {
    const pr = { title: "PAY-12: refund API", url: "https://github.com/acme/shop-web/pull/7", state: "open", review: "needed", checks: "passing" };
    const text = projectPrompt({ ...base, pullRequests: [pr] });
    expect(text).toContain("The project's open pull requests, the ones its tickets name");
    expect(text).toContain(pr.url);
    expect(text).toContain("A PR waiting on review is a blocker owned by the reviewer");
    expect(projectPrompt(base)).not.toContain("pull requests, the ones its tickets name");
    expect(projectPrompt(base)).not.toContain("A PR waiting on review");
  });
});
