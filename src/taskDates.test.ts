import { describe, expect, it } from "vitest";
import { createdAt, slackTime, sortTasks } from "./taskDates";

describe("task dates", () => {
  it("reads the time a Slack permalink points at", () => {
    expect(slackTime("https://example.slack.com/archives/C1/p1700000000000100")).toBe(new Date(1700000000000).toISOString());
    expect(slackTime("https://example.slack.com/archives/C1/p1700000000123456?thread_ts=1")).toBe(new Date(1700000000123).toISOString());
    expect(slackTime("gmail:abc")).toBeNull();
  });

  it("dates a task by when it was added, its Slack message, or when it was first seen", () => {
    expect(createdAt({ id: "manual:1", created_at: "2026-11-01T10:00:00Z" }, {})).toBe("2026-11-01T10:00:00Z");
    expect(createdAt({ id: "x", link: "https://example.slack.com/archives/C1/p1700000000000100" }, {})).toBe(new Date(1700000000000).toISOString());
    expect(createdAt({ id: "gmail:1" }, { "gmail:1": "2026-11-02T09:00:00Z" })).toBe("2026-11-02T09:00:00Z");
    expect(createdAt({ id: "gmail:2" }, {})).toBeNull();
  });

  it("sorts by due date or date created, undated last, keeping priority order for ties", () => {
    const tasks = [
      { id: "a", due: null, created_at: "2026-11-01T00:00:00Z" },
      { id: "b", due: "2026-11-05", created_at: "2026-11-03T00:00:00Z" },
      { id: "c", due: "2026-11-04", created_at: null },
      { id: "d", due: null, created_at: null },
    ];
    expect(sortTasks(tasks, "priority", {}).map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
    expect(sortTasks(tasks, "due", {}).map((t) => t.id)).toEqual(["c", "b", "a", "d"]);
    expect(sortTasks(tasks, "newest", {}).map((t) => t.id)).toEqual(["b", "a", "c", "d"]);
    expect(sortTasks(tasks, "oldest", {}).map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
  });
});
