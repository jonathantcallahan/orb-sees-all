import { describe, expect, it } from "vitest";
import { adhocPrompt } from "./prompts";
import { DEFAULT_TASK_STATE, workedOn, type TaskState } from "./tasks";

const prompt = (o: { updates?: boolean; worked?: string[] } = {}) =>
  adhocPrompt({ userId: "U1", previous: [], previousReplies: [], projectChannels: ["tmp-refunds"], lastRefreshedAt: null, now: new Date(2026, 10, 4), ...o });

describe("the inbox: messages a reply alone settles", () => {
  it("sorts a question that only needs an answer into replies, not tasks, from Slack and email alike", () => {
    const p = prompt();
    expect(p).not.toContain("a question awaiting their answer");
    expect(p).toContain("A question or ask that a response alone settles is a reply, in any channel.");
    expect(p).toContain("it's a reply when a response alone settles it, otherwise a task");
    expect(p).not.toContain("A task is a thread where a person");
  });

  it("moves a carried-over task that a reply settles back to the inbox, unless the user has worked on it", () => {
    expect(prompt()).toContain("Sort the carried-over tasks the same way: one that a response alone settles moves to replies, with the same id.");
    const p = prompt({ worked: ["https://x.slack.com/archives/C1/p1", "gmail:abc"] });
    expect(p).toContain('except these, which the user has worked on and stay tasks: ["https://x.slack.com/archives/C1/p1","gmail:abc"]');
  });

  it("puts every open message on the task list while Updates, where the inbox is, is off", () => {
    const p = prompt({ updates: false, worked: ["gmail:abc"] });
    expect(p).toContain("A task is a thread where a person");
    expect(p).not.toContain("Sort the carried-over tasks the same way");
    expect(p).toContain("Leave the replies list empty");
  });
});

describe("workedOn", () => {
  const states = new Map<string, TaskState>([
    ["started", { ...DEFAULT_TASK_STATE, status: "in_progress" }],
    ["finished", { ...DEFAULT_TASK_STATE, status: "done", done: true }],
    ["today", { ...DEFAULT_TASK_STATE, todayOn: "2026-11-19" }],
    ["untouched", DEFAULT_TASK_STATE],
  ]);
  const plans = new Set(["planned"]);
  const worked = (id: string) => workedOn(id, states, plans, { edited: "Mine" }, { reprioritized: "high" });

  it("is any sign the user took the task on", () => {
    for (const id of ["started", "finished", "today", "planned", "edited", "reprioritized"]) expect(worked(id)).toBe(true);
  });

  it("isn't a task left as the refresh found it", () => {
    expect(worked("untouched")).toBe(false);
    expect(worked("never-seen")).toBe(false);
  });
});
