import { describe, expect, it, vi } from "vitest";
import type { Project } from "./db";
import type { ProjectChannel, ProjectEpicLink } from "./projects";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const db = {
  linkEpic: vi.fn(),
  unlinkEpic: vi.fn(async () => true),
  createProject: vi.fn(async () => "jira:ABC-1"),
  splitProject: vi.fn(async () => "jira:ABC-12"),
  unlinkChannel: vi.fn(async () => false),
  unshareChannel: vi.fn(async () => true),
  logFeedback: vi.fn(() => Promise.resolve()),
};
const jobs = { refreshProject: vi.fn(() => Promise.resolve()) };
vi.mock("./db", () => db);
vi.mock("./jobs", () => jobs);
vi.mock("./claude", () => ({}));

const { activeEpics, channelSharers, readChannels, cloudJiraLink, epicKeyFrom, epicUrl, jiraSite, newProjectId, nowText, pathToShip, pathTracks, planDiscovery, primaryChannel, projectName, shipTarget, stepsUnderway, withCloudJiraLinks } = await import("./projects");
const { discoveryPrompt, projectPrompt } = await import("./prompts");
const { Discovery, PathStep, ProjectSnapshot } = await import("./schema");
const { applyAction, describeAction } = await import("./globalActions");

const channel = (channel_id: string, project_id: string, name: string, role: ProjectChannel["role"] = "primary"): ProjectChannel => ({ channel_id, project_id, name, role, origin: "discovered", reason: null });
const epic = (epic_key: string, project_id: string, over: Partial<ProjectEpicLink> = {}): ProjectEpicLink => ({ epic_key, project_id, title: `${epic_key} title`, origin: "discovered", excluded: false, at: "2026-11-01T00:00:00Z", ...over });

describe("project ids and channels", () => {
  it("gives a new project an id of Demian's own, whatever its sources", () => {
    expect(newProjectId(() => "3f9a1c2e-4b5d-0000-0000-000000000000")).toBe("p:3f9a1c2e4b5d");
    expect(newProjectId()).toMatch(/^p:[0-9a-f]{12}$/);
  });

  it("finds the main channel, none for a project without one", () => {
    expect(primaryChannel({ channels: [channel("C2", "P", "refunds-eng", "related"), channel("C1", "P", "tmp-refunds")] })?.channel_id).toBe("C1");
    expect(primaryChannel({ channels: [channel("C1", "P", "tmp-refunds", "excluded")] })).toBeNull();
    expect(primaryChannel({ channels: [] })).toBeNull();
  });

  it("names a project found from an epic by its own name, not as a channel", () => {
    expect(projectName({ channel_id: "jira:ABC-1", name: "Self-serve refunds", snapshot: null })).toBe("Self-serve refunds");
    expect(projectName({ channel_id: "C1", name: "tmp-asset-refunds", snapshot: null })).toBe("Asset refunds");
  });
});

describe("epics", () => {
  it("reads an epic key from a key or a Jira link", () => {
    expect(epicKeyFrom(" pay-8479 ")).toBe("PAY-8479");
    expect(epicKeyFrom("https://example.atlassian.net/browse/PAY-8479")).toBe("PAY-8479");
    expect(epicKeyFrom("https://example.atlassian.net/jira/software/projects/PAY/boards/1?selectedIssue=PAY-12")).toBe("PAY-12");
    expect(epicKeyFrom("the refunds epic")).toBeNull();
  });

  it("leaves unlinked epics out, and links each to Jira by its own link or the site its others are on", () => {
    const p = { epics: [epic("ABC-1", "P", { link: "https://example.atlassian.net/browse/ABC-1" }), epic("ABC-2", "P"), epic("ABC-3", "P", { excluded: true })], profile: null };
    expect(activeEpics(p).map((e) => e.epic_key)).toEqual(["ABC-1", "ABC-2"]);
    expect(epicUrl(p, "ABC-2")).toBe("https://example.atlassian.net/browse/ABC-2");
    expect(epicUrl({ epics: [epic("ABC-2", "P")], profile: null }, "ABC-2")).toBeNull();
  });
});

describe("discovery with epics", () => {
  const known = [channel("C1", "C1", "tmp-refunds")];
  const ids = new Set(["C1"]);

  it("joins epics to the project their channels or epics belong to", () => {
    const plan = planDiscovery(
      [{ project_id: null, name: "Refunds", reason: "r", channels: [{ channel_id: "C1", name: "tmp-refunds", role: "primary" }], epics: [{ key: "abc-1", title: "Refund API" }] }],
      known,
      ids,
    );
    expect(plan.newProjects).toEqual([]);
    expect(plan.epicLinks).toEqual([{ epic_key: "ABC-1", project_id: "C1", title: "Refund API" }]);
    const byEpic = planDiscovery([{ project_id: null, name: "Refunds", reason: "r", channels: [], epics: [{ key: "ABC-1", title: "x" }, { key: "ABC-2", title: "Refund UI" }] }], known, ids, [epic("ABC-1", "C1")]);
    expect(byEpic.epicLinks).toEqual([{ epic_key: "ABC-2", project_id: "C1", title: "Refund UI" }]);
  });

  it("suggests a project found in Jira alone, keyed by its epic", () => {
    const plan = planDiscovery([{ project_id: null, name: "Order history migration", reason: "Epics you own", channels: [], epics: [{ key: "PAY-8479", title: "Order History Data Migration" }] }], known, ids);
    expect(plan.newProjects).toEqual([{ id: expect.stringMatching(/^p:/), name: "Order history migration", tracked: false, reason: "Epics you own" }]);
    expect(plan.epicLinks).toEqual([{ epic_key: "PAY-8479", project_id: plan.newProjects[0].id, title: "Order History Data Migration" }]);
  });

  it("skips epics the user unlinked and ones already linked elsewhere", () => {
    const plan = planDiscovery(
      [{ project_id: null, name: "x", reason: "r", channels: [], epics: [{ key: "ABC-9", title: "" }] }],
      known,
      new Set(["C1", "C2"]),
      [epic("ABC-9", "C2", { excluded: true })],
    );
    expect(plan).toMatchObject({ newProjects: [], epicLinks: [] });
  });

  it("still plans channel-only groups as before", () => {
    const plan = planDiscovery([{ project_id: null, name: "Payouts", reason: "r", channels: [{ channel_id: "C7", name: "tmp-payouts", role: "primary" }] }], [], new Set(), [], () => "abcdef123456");
    expect(plan.newProjects).toEqual([{ id: "p:abcdef123456", name: "Payouts", tracked: true, reason: "r" }]);
    expect(plan.links).toEqual([{ channel_id: "C7", project_id: "p:abcdef123456", name: "tmp-payouts", role: "primary", reason: "r" }]);
    expect(plan.epicLinks).toEqual([]);
  });

  it("reads groups with no channels", () => {
    const d = Discovery.parse({ user_id: "U1", projects: [{ project_id: null, name: "n", reason: "r", epics: [{ key: "A-1" }] }] });
    expect(d.projects[0]).toMatchObject({ channels: [], epics: [{ key: "A-1", title: "" }] });
  });
});

describe("path to ship", () => {
  const base = { description: "d", status: "on_track", status_reason: "r", raci: { role: "accountable", reason: "x" }, priority: { level: "P1", reason: "x" }, blockers: [], my_tasks: [] };
  const path = {
    now: "Building the refund API.",
    ship: { what: "Self-serve refunds launch", date: "2026-12-12", source: { title: "PAY-8479 due date", link: "https://example.atlassian.net/browse/PAY-8479" } },
    steps: [
      { what: "Design", status: "done" },
      { what: "Build the API", status: "in_progress", owners: ["Ana"] },
      { what: "Launch", status: "someday" },
    ],
  };
  const project = (over: Record<string, unknown> = {}) =>
    ({ snapshot: ProjectSnapshot.parse({ ...base, path }), last_refreshed_at: "2026-11-15T00:00:00Z", ship_choice: null, kind_choice: null, ...over }) as unknown as Pick<Project, "snapshot" | "last_refreshed_at" | "ship_choice" | "kind_choice">;

  it("reads a path, an odd step status as next, and an old snapshot without one", () => {
    const s = ProjectSnapshot.parse({ ...base, path });
    expect(s.path?.steps.map((x) => x.status)).toEqual(["done", "in_progress", "next"]);
    expect(ProjectSnapshot.parse(base).path).toBeUndefined();
    expect(ProjectSnapshot.parse({ ...base, path: "soon" }).path).toBeNull();
  });

  it("takes the step underway as the current one", () => {
    expect(stepsUnderway(project().snapshot!.path!.steps).map((s) => s.what)).toEqual(["Build the API"]);
    expect(stepsUnderway([{ what: "Launch", status: "next", owners: [], items: [], requirements: [], code: [] }]).map((s) => s.what)).toEqual(["Launch"]);
  });

  // Gift cards, as a refresh would track it: the TDD, the UI and the backend all moving at once.
  const step = (what: string, status: string, track?: string | null) => PathStep.parse({ what, status, track });
  const cards = [
    step("Review the merged TDD", "done", "Design & TDD"),
    step("Finalize the TDD", "in_progress", "Design & TDD"),
    step("Build the seller UI", "in_progress", "Seller UI"),
    step("Catalog gift card model", "blocked", "Catalog backend"),
    step("Wire the UI to the catalog APIs", "next", "seller ui"),
    step("Launch", "next", null),
  ];

  it("reads a step's track, and an odd one as none", () => {
    expect(cards[1].track).toBe("Design & TDD");
    expect(PathStep.parse({ what: "x", status: "next" }).track).toBeUndefined();
    expect(PathStep.parse({ what: "x", status: "next", track: 3 }).track).toBeNull();
  });

  it("finds every step underway, not just the first", () => {
    expect(stepsUnderway(cards).map((s) => s.what)).toEqual(["Finalize the TDD", "Build the seller UI", "Catalog gift card model"]);
  });

  it("groups a path into tracks in the order they appear, with untracked steps last", () => {
    const tracks = pathTracks(cards)!;
    expect(tracks.map((t) => t.name)).toEqual(["Design & TDD", "Seller UI", "Catalog backend", "Other"]);
    // Names match regardless of case, and keep their first spelling.
    expect(tracks[1].steps.map((s) => s.what)).toEqual(["Build the seller UI", "Wire the UI to the catalog APIs"]);
    expect(tracks[3].steps.map((s) => s.what)).toEqual(["Launch"]);
  });

  it("lists a path with one track or none as steps in order", () => {
    expect(pathTracks(project().snapshot!.path!.steps)).toBeNull();
    expect(pathTracks([step("A", "done", "Backend"), step("B", "next", "backend"), step("C", "next")])).toBeNull();
  });

  it("says on the card how many steps are underway, and on which tracks", () => {
    expect(nowText(cards)).toEqual({
      text: "3 underway (1 blocked): Design & TDD, Seller UI, Catalog backend",
      title: "Finalize the TDD\nBuild the seller UI\nBlocked: Catalog gift card model",
    });
    const untracked = cards.map((s) => ({ ...s, track: null }));
    expect(nowText(untracked)?.text).toBe("now: Finalize the TDD and 2 more");
    expect(nowText(project().snapshot!.path!.steps)?.text).toBe("now: Build the API");
    expect(nowText([])).toBeNull();
  });

  it("ships on your date until a refresh has looked again, then on what it read", () => {
    expect(shipTarget(project())).toMatchObject({ date: "2026-12-12", byYou: false, source: { title: "PAY-8479 due date" } });
    const yours = { date: "2027-01-15", at: "2026-11-16T00:00:00Z" };
    expect(shipTarget(project({ ship_choice: yours }))).toMatchObject({ date: "2027-01-15", byYou: true, what: "Self-serve refunds launch" });
    expect(shipTarget(project({ ship_choice: yours, last_refreshed_at: "2026-11-17T00:00:00Z" }))).toMatchObject({ date: "2026-12-12", byYou: false });
  });

  it("shows no source for a ship date nothing named", () => {
    const noDate = { snapshot: ProjectSnapshot.parse({ ...base, path: { ...path, ship: { what: "Migration", date: null, source: { title: "PAY-8479", link: "x" } } } }), last_refreshed_at: "x", ship_choice: null, kind_choice: null } as unknown as Pick<Project, "snapshot" | "last_refreshed_at" | "ship_choice" | "kind_choice">;
    expect(shipTarget(noDate)).toEqual({ what: "Migration", date: null, source: null, byYou: false });
  });

  it("has no path or ship date for a workstream", () => {
    const ws = project({ kind_choice: { kind: "workstream", at: "x" } });
    expect(shipTarget(ws)).toBeNull();
    expect(pathToShip(ws)).toBeNull();
  });
});

describe("Jira links from before the move to the cloud site", () => {
  const site = "https://example.atlassian.net";

  it("finds the site the project's epics are on", () => {
    expect(jiraSite([null, "https://jira.example.com/browse/ABC-1", "https://example.atlassian.net/browse/ABC-2"])).toBe(site);
    expect(jiraSite(["https://jira.example.com/browse/ABC-1"])).toBeNull();
  });

  it("moves an issue link from an older Jira onto that site, and leaves everything else", () => {
    expect(cloudJiraLink("https://jira.example.com/browse/ABC-1", site)).toBe(`${site}/browse/ABC-1`);
    expect(cloudJiraLink("https://old.atlassian.net/browse/ABC-1?focusedCommentId=9", site)).toBe(`${site}/browse/ABC-1`);
    expect(cloudJiraLink(`${site}/browse/ABC-1`, site)).toBe(`${site}/browse/ABC-1`);
    expect(cloudJiraLink("https://github.com/o/r/browse/ABC-1", site)).toBe("https://github.com/o/r/browse/ABC-1");
    expect(cloudJiraLink("https://x.slack.com/archives/C1/p1", site)).toBe("https://x.slack.com/archives/C1/p1");
    expect(cloudJiraLink("https://jira.example.com/browse/ABC-1", null)).toBe("https://jira.example.com/browse/ABC-1");
  });

  it("fixes the record's links but never an item's id", () => {
    const old = "https://jira.example.com/browse/ABC-7";
    const snapshot = ProjectSnapshot.parse({
      description: "d", status: "on_track", status_reason: "r", raci: { role: "accountable", reason: "x" }, priority: { level: "P1", reason: "x" }, my_tasks: [],
      blockers: [{ id: old, what: "w", owners: [], link: old }],
      path: { now: "n", ship: { what: "w", date: "2026-12-01", source: { title: "ABC-7", link: old } }, steps: [{ what: "s", status: "next", link: old }] },
    });
    const profile = { goal: "g", context: [], aliases: [], people: [], resources: [{ title: "t", link: old, kind: "ticket" }], milestones: [], decisions: [{ what: "d", link: old }] };
    const fixed = withCloudJiraLinks(snapshot, profile, site);
    const now = `${site}/browse/ABC-7`;
    expect(fixed.snapshot.blockers[0]).toMatchObject({ id: old, link: now });
    expect(fixed.snapshot.path?.steps[0].link).toBe(now);
    expect(fixed.snapshot.path?.ship?.source?.link).toBe(now);
    expect(fixed.profile.resources[0].link).toBe(now);
    expect(fixed.profile.decisions[0].link).toBe(now);
  });
});

describe("prompts", () => {
  const input = { userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z") };

  it("reads a project with no channel from its epics and a search, never an empty channel list", () => {
    const text = projectPrompt({ ...input, channels: [], epics: [{ key: "PAY-8479", title: "Order history migration" }], profile: { goal: "g", context: [], aliases: ["Order history"], people: [], resources: [], milestones: [], decisions: [] } });
    expect(text).toContain("The project has no Slack channel.");
    expect(text).not.toContain("Read only these channels");
    expect(text).not.toContain("in:<#");
    expect(text).toContain('"Order history" OR "PAY-8479"');
    expect(text).toContain("parent in (PAY-8479)");
    expect(text).toContain("- path: how the project gets from where it is now to shipping");
    expect(text).toContain("its status follows its issues (done only when they're all in a Done status");
    expect(text).toContain("- track: the strand of work an epic is on");
    expect(text).toContain('"track": string|null');
  });

  it("keeps a project's channels, and asks a workstream for no path", () => {
    const text = projectPrompt({ ...input, channels: [{ channel_id: "C1", name: "tmp-refunds" }], kind: "workstream" });
    expect(text).toContain("#tmp-refunds (C1). Read only these channels");
    expect(text).toContain("- path: null (this is a workstream");
  });

  it("after the first read, reads only changed issues and counts the rest, unless told to read them all", () => {
    const previous = ProjectSnapshot.parse({ description: "d", status: "on_track", status_reason: "r", raci: { role: "accountable", reason: "x" }, priority: { level: "P1", reason: "x" }, blockers: [], my_tasks: [] });
    const later = { ...input, previous, lastRefreshedAt: "2026-11-15T10:00:00Z", channels: [], epics: [{ key: "A-1", title: "t" }] };
    expect(projectPrompt(later)).toContain('updated >= "');
    expect(projectPrompt({ ...later, readAllChildren: true })).not.toContain('updated >= "');
  });

  it("keeps the ship date the user set, and leaves out epics they unlinked", () => {
    const text = projectPrompt({ ...input, channels: [], shipSetByUser: { date: "2027-01-15", at: "2026-11-16T00:00:00Z" }, excludedEpics: ["ABC-9"] });
    expect(text).toContain("The user set the ship date to 2027-01-15");
    expect(text).toContain("never ABC-9 (the user unlinked them)");
  });

  it("finds projects in Jira epics as well as channels", () => {
    const text = discoveryPrompt({ known: [{ project_id: "C1", name: "Refunds", aliases: [], channels: ["tmp-refunds"], epics: ["ABC-1"] }], skip: [], skipEpics: ["ABC-9"] });
    expect(text).toContain("issuetype = Epic AND statusCategory != Done AND (assignee = currentUser() OR reporter = currentUser())");
    expect(text).toContain("parent is not EMPTY");
    expect(text).toContain("ABC-9");
    expect(text).toContain('"epics":["ABC-1"]');
  });
});

describe("chat actions", () => {
  const name = (id: string) => (id === "C1" ? "Refunds" : id);

  it("says what each does", () => {
    expect(describeAction({ type: "create_project", name: "Order history", channels: [], epics: ["pay-8479"] }, name, name, () => null)).toBe('Add the project "Order history", from PAY-8479');
    expect(describeAction({ type: "create_project", name: "Order history", channels: [], epics: [] }, name, name, () => null)).toBe('Add the project "Order history"');
    expect(describeAction({ type: "link_project_epic", project_id: "C1", epic_key: "abc-1" }, name, name, () => null)).toBe('Link the epic ABC-1 to "Refunds"');
    expect(describeAction({ type: "unlink_project_epic", project_id: "C1", epic_key: "ABC-1" }, name, name, () => null)).toBe('Unlink the epic ABC-1 from "Refunds"');
  });

  it("creates a project from epics alone, and links and unlinks epics by key or link", async () => {
    await applyAction({ type: "create_project", name: "Order history", channels: [], epics: ["https://example.atlassian.net/browse/PAY-8479"] });
    expect(db.createProject).toHaveBeenCalledWith("Order history", [], undefined, ["PAY-8479"]);
    await applyAction({ type: "link_project_epic", project_id: "C1", epic_key: "https://example.atlassian.net/browse/ABC-1" });
    expect(db.linkEpic).toHaveBeenCalledWith("C1", { key: "ABC-1" }, "user");
    await applyAction({ type: "unlink_project_epic", project_id: "C1", epic_key: "abc-1" });
    expect(db.unlinkEpic).toHaveBeenCalledWith("C1", "ABC-1");
    await expect(applyAction({ type: "link_project_epic", project_id: "C1", epic_key: "the refunds epic" })).rejects.toThrow(/isn't an epic key/);
  });
});

describe("two projects in one channel", () => {
  const cards = { channel_id: "C1", name: "tmp-gift-cards-and-credit", snapshot: null, state: "tracked" as const, focus: { pinned_name: "Gift cards" }, channels: [channel("C1", "C1", "tmp-gift-cards-and-credit"), channel("C2", "C1", "catalog-foundations", "related")], shared_channels: [] };
  const credit = { channel_id: "jira:ABC-12", name: "Store credit", snapshot: null, state: "tracked" as const, focus: { pinned_name: "Store credit" }, channels: [], shared_channels: [{ channel_id: "C1", name: "tmp-gift-cards-and-credit" }] };

  it("reads a shared channel as its own, after the ones it owns, and reminds there when it has no other", () => {
    expect(readChannels(credit)).toEqual([{ channel_id: "C1", name: "tmp-gift-cards-and-credit", shared: true }]);
    expect(readChannels(cards).map((c) => c.shared)).toEqual([false, false]);
    expect(primaryChannel(credit)?.channel_id).toBe("C1");
  });

  it("knows who else reads each channel, both ways", () => {
    expect([...channelSharers(cards, [cards, credit])]).toEqual([["C1", ["Store credit"]]]);
    expect([...channelSharers(credit, [cards, credit])]).toEqual([["C1", ["Gift cards"]]]);
  });

  it("tells a refresh to keep to its own part of a shared channel", () => {
    const text = projectPrompt({
      userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z"),
      channels: [{ channel_id: "C1", name: "tmp-gift-cards-and-credit" }],
      sharing: [{ channel_id: "C1", name: "tmp-gift-cards-and-credit", with: ["Gift cards"] }],
    });
    expect(text).toContain('Some are shared with other projects: #tmp-gift-cards-and-credit with "Gift cards"');
    expect(text).toContain("use only what's about this project");
  });

  it("splits by epics and a shared channel when the channel can't move", async () => {
    const name = (id: string) => (id === "C1" ? "Gift cards and credit" : id === "C2" ? "catalog-foundations" : id);
    const split = { type: "split_project" as const, project_id: "C1", new_name: "Store credit", channel_ids: [], epic_keys: ["abc-12"], shared_channel_ids: ["C1"] };
    expect(describeAction(split, name, (id) => (id === "C1" ? "tmp-gift-cards-and-credit" : id), () => null)).toBe(
      'Split "Gift cards and credit": move ABC-12 into a new project, "Store credit", both reading #tmp-gift-cards-and-credit',
    );
    expect(describeAction({ ...split, epic_keys: [] }, name, (id) => id, () => null)).toBe('Split "Gift cards and credit": start a new project, "Store credit", both reading #C1');
    await applyAction(split);
    expect(db.splitProject).toHaveBeenCalledWith("C1", "Store credit", [], undefined, ["ABC-12"], ["C1"]);
  });

  it("reads older split cards that only moved channels", async () => {
    const { GlobalAction } = await import("./schema");
    expect(GlobalAction.parse({ type: "split_project", project_id: "C1", new_name: "x", channel_ids: ["C2"] })).toMatchObject({ epic_keys: [], shared_channel_ids: [] });
  });

  it("unlinks a shared channel like a related one", async () => {
    await applyAction({ type: "unlink_channel", project_id: "jira:ABC-12", channel_id: "C1" });
    expect(db.unshareChannel).toHaveBeenCalledWith("jira:ABC-12", "C1");
  });
});

describe("the Demian chat's list of changes", () => {
  it("is versioned, so a chat begun on an older list is given the new one", async () => {
    const { actionDocsVersion, updatedActionDocs, globalActionDocs } = await import("./openInClaude");
    expect(actionDocsVersion()).toBe(actionDocsVersion());
    expect(actionDocsVersion()).toMatch(/^[0-9a-z]+$/);
    const update = updatedActionDocs();
    expect(update).toMatch(/This list replaces the one in the chat.s first message/);
    expect(update).toContain(globalActionDocs());
  });

  it("treats a project as Demian's record whose channels and epics can all move", async () => {
    const { globalActionDocs } = await import("./openInClaude");
    expect(globalActionDocs()).toMatch(/A project is the planner's own record/);
    expect(globalActionDocs()).toMatch(/its first or main channel included/);
    expect(globalActionDocs()).not.toMatch(/main channel can't move/);
    expect(globalActionDocs()).toMatch(/"shared_channel_ids"/);
  });
});
