import { describe, expect, it } from "vitest";
import { actionLine, actionsFromPlan, mergeEditedOutcomes, openOutcomes, orderTopics, OUTCOME_STEP, stillWatched, withUpdate, outcomeState, outcomeTaskDescription, type WatchedOutcome, type WatchedTopic, type WatchedUpdate } from "./watched";
import { watchedEntryPrompt, watchedTopicPrompt } from "./prompts";
import { WatchedEntry } from "./schema";
import { parsePlan } from "./sessions";

const outcome = (o: Partial<WatchedOutcome>): WatchedOutcome => ({ id: "o1", when: "not_by", event: "Legal signs off", by: "2026-11-12", then: "Chase Legal", ...o });
const topic = (outcomes: WatchedOutcome[]): WatchedTopic => ({
  id: "watch:1",
  topic: "Vendor contract renewal",
  details: "Acme, via the procurement channel",
  projectId: null,
  history: [],
  outcomes,
  status: null,
  checkedAt: null,
  createdAt: "2026-11-04T10:00:00Z",
});

describe("watched topics", () => {
  it("makes a 'not by' outcome ready only once its date has passed without the event", () => {
    expect(outcomeState(outcome({}), "2026-11-12")).toBe("waiting");
    expect(outcomeState(outcome({}), "2026-11-13")).toBe("ready");
    expect(outcomeState(outcome({ occurred: true }), "2026-11-13")).toBe("not_needed");
  });

  it("makes a 'happens' outcome ready when the event is seen", () => {
    expect(outcomeState(outcome({ when: "happens", by: null }), "2026-11-04")).toBe("waiting");
    expect(outcomeState(outcome({ when: "happens", by: null, occurred: true }), "2026-11-04")).toBe("ready");
  });

  it("counts an outcome acted on once a task was made from it, and stops checking it", () => {
    const acted = outcome({ taskId: "manual:1" });
    expect(outcomeState(acted, "2026-11-13")).toBe("acted");
    const t = topic([acted, outcome({ id: "o2", occurred: true }), outcome({ id: "o3" })]);
    expect(openOutcomes(t).map((o) => o.id)).toEqual(["o3"]);
  });

  it("says why the task is needed", () => {
    const d = outcomeTaskDescription(topic([]), outcome({ evidence: null }));
    expect(d).toContain('watched topic "Vendor contract renewal"');
    expect(d).toContain("hadn't happened by");
    expect(d).toContain("About the topic: Acme");
  });

  it("asks about each open outcome by id, and only for clear evidence", () => {
    const p = watchedTopicPrompt({ userId: "U1", today: "2026-11-04", topic: "Vendor contract renewal", details: null, checkedAt: null, lastSummary: null, outcomes: [{ id: "o1", event: "Legal signs off", by: "2026-11-12" }] });
    expect(p).toContain('id "o1": Legal signs off (watching for it until 2026-11-12)');
    expect(p).toContain("only if you found clear evidence");
  });

  it("asks only where it stands when a topic has nothing to act on", () => {
    const p = watchedTopicPrompt({ userId: "U1", today: "2026-11-04", topic: "Q4 budget approval", details: null, checkedAt: null, lastSummary: null, outcomes: [] });
    expect(p).toContain("only wants to know where it stands");
    expect(p).not.toContain("clear evidence");
  });
});

describe("reading a watched topic as written", () => {
  it("gives the date to work out relative days from, and the entry as written", () => {
    const p = watchedEntryPrompt("If Legal hasn't signed off on the Acme contract by Friday, chase them", new Date(2026, 10, 4));
    expect(p).toContain("Today is Wednesday, 2026-11-04");
    expect(p).toContain("If Legal hasn't signed off on the Acme contract by Friday, chase them");
  });

  it("takes a filled-in entry with a date, and refuses a malformed one", () => {
    expect(WatchedEntry.parse({ topic: "Acme contract", details: null, outcomes: [{ when: "not_by", event: "Legal signs off", by: "2026-11-06", then: "Chase Legal" }] }).outcomes).toHaveLength(1);
    expect(WatchedEntry.safeParse({ topic: "x", outcomes: [{ when: "not_by", event: "e", by: "Friday", then: "t" }] }).success).toBe(false);
  });
});

describe("editing a watched topic", () => {
  it("keeps what checks found for a conditional action whose condition didn't change", () => {
    const before = [
      outcome({ id: "a", occurred: true, evidence: "Signed", taskId: "manual:1" }),
      outcome({ id: "b", occurred: true, evidence: "Seen" }),
    ];
    const merged = mergeEditedOutcomes(before, [
      { id: "a", when: "not_by", event: "Legal signs off", by: "2026-11-12", then: "Chase Legal today" },
      { id: "b", when: "not_by", event: "Legal signs off", by: "2026-11-20", then: "Chase Legal" },
      { id: "c", when: "happens", event: "Invoice arrives", by: null, then: "Pay it" },
    ]);
    expect(merged[0]).toMatchObject({ occurred: true, taskId: "manual:1", then: "Chase Legal today" });
    expect(merged[1].occurred).toBeUndefined();
    expect(merged[2]).toEqual({ id: "c", when: "happens", event: "Invoice arrives", by: null, then: "Pay it" });
  });
});

describe("conditional actions restated in a Discuss chat", () => {
  it("reads each plan line back into a conditional action, keeping what checks found for unchanged ones", () => {
    const before = [outcome({ id: "a", occurred: false, evidence: "Not yet" })];
    const line = actionLine(before[0]);
    expect(line).toBe("If Legal signs off | hasn't happened by 2026-11-12 | then Chase Legal");
    const next = actionsFromPlan(before, [line, "If The invoice arrives | has happened | then Pay it"]);
    expect(next?.[0]).toMatchObject({ id: "a", evidence: "Not yet" });
    expect(next?.[1]).toMatchObject({ when: "happens", event: "The invoice arrives", by: null, then: "Pay it" });
  });

  it("ignores a list it can't read", () => {
    expect(actionsFromPlan([], ["Chase Legal"])).toBeNull();
  });

  it("reads a list as a chat writes it, through the plan block Orb already parses", () => {
    // How a session restates them: numbered, sometimes in backticks, with a curly apostrophe.
    const block = ["1. `If A software license is assigned to me | hasn\u2019t happened by 2026-11-05 | then Send Sam a request`", "2. If The invoice arrives | has happened | then Pay it"].join("\n");
    const lines = parsePlan(block).map((s) => s.title);
    const next = actionsFromPlan([], lines);
    expect(next).toHaveLength(2);
    expect(next?.[0]).toMatchObject({ when: "not_by", by: "2026-11-05", event: "A software license is assigned to me", then: "Send Sam a request" });
    expect(next?.[1]).toMatchObject({ when: "happens", by: null });
  });
});

describe("watched topics on task cards", () => {
  const states = new Map([
    ["done", { done: true, dismissed: false }],
    ["gone", { done: false, dismissed: true }],
  ]);
  const state = (id: string) => states.get(id) ?? { done: false, dismissed: false };
  const t = (id: string, outcomes: WatchedOutcome[] = []) => ({ ...topic(outcomes), id });

  it("shows a ready action as a step waiting on you, so the card's status shows Human", () => {
    expect(OUTCOME_STEP[outcomeState(outcome({}), "2026-11-13")]).toBe("waiting");
    expect(OUTCOME_STEP[outcomeState(outcome({}), "2026-11-01")]).toBeUndefined();
  });

  it("turns acted-on and unneeded actions into done and skipped steps, so a fully handled topic is Done", () => {
    const steps = [outcome({ taskId: "manual:1" }), outcome({ occurred: true })].map((o) => OUTCOME_STEP[outcomeState(o, "2026-11-13")]);
    expect(steps).toEqual(["done", "skipped"]);
  });

  it("lists ready topics first, done ones last, and leaves unwatched ones out", () => {
    const list = orderTopics([t("done"), t("plain"), t("gone"), t("ready", [outcome({})])], state, "2026-11-13");
    expect(list.map((x) => x.id)).toEqual(["ready", "plain", "done"]);
  });

  it("stops checking topics that are done or unwatched", () => {
    expect(["done", "gone", "plain"].filter((id) => stillWatched(state(id)))).toEqual(["plain"]);
  });
});

describe("a topic's updates", () => {
  const u = (at: string, summary: string): WatchedUpdate => ({ at, summary, links: [] });

  it("adds an update that says something new, and not one that repeats the last", () => {
    const one = withUpdate([], u("2026-11-04T10:00:00Z", "No reply yet."));
    expect(withUpdate(one, u("2026-11-04T11:00:00Z", "No reply yet. "))).toHaveLength(1);
    expect(withUpdate(one, u("2026-11-04T12:00:00Z", "Sam replied."))).toHaveLength(2);
  });

  it("keeps the latest 50", () => {
    let h: WatchedUpdate[] = [];
    for (let i = 0; i < 55; i++) h = withUpdate(h, u(`2026-11-04T10:${String(i).padStart(2, "0")}:00Z`, `update ${i}`));
    expect(h).toHaveLength(50);
    expect(h[0].summary).toBe("update 5");
  });
});
