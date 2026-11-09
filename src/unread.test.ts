import { describe, expect, it } from "vitest";
import { seenAfter, toRecord, unreadIds, updateFacts, type UnreadInput } from "./unread";

const project = (over: object) => ({
  channel_id: "C1", name: "tmp-refunds", hidden: false, state: "tracked" as const, found_reason: null, merged_into: null, channels: [], local_repos: [], gh_repos: [],
  last_refreshed_at: "2026-11-09T07:00:00Z", profile: null, repo_state: null, last_error: null, focus: null, status_override: null,
  snapshot: {
    name: "x", description: "", status: "on_track" as const, status_reason: "", raci: { role: "accountable" as const, reason: "" }, priority: { level: "P1" as const, reason: "" },
    blockers: [], active: [], summary: "",
    my_tasks: [{ id: "p1", title: "Confirm QA", assessment: { automation: "human" as const, suggestion: "", needs_details: false } }],
    recent_updates: [{ summary: "Kickoff held", date: "2026-11-02", link: "https://slack.com/a" }],
  },
  ...over,
});

const input = (over: Partial<UnreadInput> = {}): UnreadInput => ({
  projects: [project({})],
  adhoc: [{ id: "s1" }],
  manual: [{ id: "m1" }],
  watched: [{ id: "w1", topic: "Pricing", details: null, projectId: null, outcomes: [], status: null, history: [], checkedAt: null, createdAt: "2026-11-01" }],
  taskAliases: new Map(),
  refinedDescriptions: {},
  taskChecks: {},
  taskStates: new Map(),
  ...over,
});

/** What's unread after recording everything in `before` as seen, then looking at `after`. */
function unreadAfter(before: UnreadInput, after: UnreadInput) {
  const b = updateFacts(before);
  const seen = Object.fromEntries(toRecord(b.facts, b.mine, {}, false).map((id) => [id, b.facts.get(id)!]));
  const a = updateFacts(after);
  return [...unreadIds(a.facts, a.mine, seen, true)].sort();
}

describe("unread dots", () => {
  it("starts with everything read, and nothing is unread before dots begin", () => {
    const { facts, mine } = updateFacts(input());
    expect(unreadIds(facts, mine, {}, false).size).toBe(0);
    expect(toRecord(facts, mine, {}, false).sort()).toEqual(["C1", "m1", "p1", "s1", "w1"]);
    expect(unreadAfter(input(), input())).toEqual([]);
  });

  it("dots a task Demian found, but not one you added or a project you track", () => {
    expect(unreadAfter(input({ adhoc: [], manual: [] }), input({ adhoc: [{ id: "s2" }], manual: [{ id: "m2" }] }))).toEqual(["s2"]);
    const { facts, mine } = updateFacts(input({ manual: [{ id: "m2" }] }));
    expect(toRecord(facts, mine, { C1: [], p1: [], s1: [], w1: [] }, true)).toEqual(["m2"]);
  });

  it("dots a task when a refresh refines it, folds in another source, or double checks it", () => {
    expect(unreadAfter(input(), input({ refinedDescriptions: { s1: "Kim now needs it by Friday." } }))).toEqual(["s1"]);
    expect(unreadAfter(input(), input({ taskAliases: new Map([["s9", "p1"]]) }))).toEqual(["p1"]);
    expect(unreadAfter(input(), input({ taskChecks: { m1: { at: "2026-11-09T10:00:00Z" } } }))).toEqual(["m1"]);
  });

  it("dots a project with a new update or status, but not when an update drops off or is reworded", () => {
    const updated = project({ snapshot: { ...project({}).snapshot, recent_updates: [{ summary: "Launch moved to Nov 17", date: "2026-11-09", link: "https://slack.com/b" }] } });
    expect(unreadAfter(input(), input({ projects: [updated] }))).toEqual(["C1"]);
    const quiet = project({ snapshot: { ...project({}).snapshot, recent_updates: [] } });
    expect(unreadAfter(input(), input({ projects: [quiet] }))).toEqual([]);
    const reworded = project({ snapshot: { ...project({}).snapshot, recent_updates: [{ summary: "The kickoff happened", date: "2026-11-02", link: "https://slack.com/a" }] } });
    expect(unreadAfter(input(), input({ projects: [reworded] }))).toEqual([]);
    expect(unreadAfter(input(), input({ projects: [project({ status_override: { status: "at_risk", at: "2026-11-09T08:00:00Z" } })] }))).toEqual(["C1"]);
  });

  it("dots a watched topic with a new update", () => {
    const topic = input().watched[0];
    const after = input({ watched: [{ ...topic, history: [{ at: "2026-11-09T09:00:00Z", summary: "Pricing approved", happened: true } as never] }] });
    expect(unreadAfter(input(), after)).toEqual(["w1"]);
  });

  it("never dots finished or dismissed tasks", () => {
    const states = new Map([["s1", { status: "done" as const, dismissed: false, todayOn: null, done: true }]]);
    expect(unreadAfter(input({ adhoc: [] }), input({ taskStates: states }))).toEqual([]);
  });

  it("keeps what you've seen when you open an item, newest last", () => {
    expect(seenAfter(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(seenAfter(undefined, ["x"])).toEqual(["x"]);
  });
});
