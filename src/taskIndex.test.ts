import { describe, expect, it } from "vitest";
import { acceptedRefinements, buildIndex } from "./taskIndex";
import { DEFAULT_TASK_STATE, type TaskState } from "./tasks";

const state = (patch: Partial<TaskState>): TaskState => ({ ...DEFAULT_TASK_STATE, ...patch });

describe("task index", () => {
  const aliases = new Map([["slack:dm", "own:1"]]);

  it("lists each open task once, under its canonical id, with a short gist", () => {
    const index = buildIndex(
      [
        { id: "own:1", title: "Send Q3 numbers", description: "x".repeat(300), project: "Refunds" },
        { id: "slack:dm", title: "Numbers?" },
        { id: "done", title: "Old thing" },
        { id: "gone", title: "Dismissed" },
      ],
      new Map([
        ["done", state({ status: "done", done: true })],
        ["gone", state({ dismissed: true })],
      ]),
      aliases,
    );
    expect(index.map((e) => e.id)).toEqual(["own:1"]);
    expect(index[0]).toMatchObject({ title: "Send Q3 numbers", project: "Refunds" });
    expect(index[0].gist!.length).toBe(100);
  });

  it("accepts only refinements of other open tasks", () => {
    const index = [{ id: "own:1", title: "Send Q3 numbers" }, { id: "p:2", title: "Review deck" }];
    expect(
      acceptedRefinements(
        [
          { id: "slack:new", refines: "own:1" },
          { id: "slack:dm", refines: "own:1" }, // already the same task
          { id: "slack:x", refines: "not-in-index" },
          { id: "slack:y", refines: null },
          { id: "slack:z", refines: "slack:dm" }, // an alias of an open task counts
        ],
        index,
        aliases,
      ),
    ).toEqual([
      { id: "slack:new", target: "own:1" },
      { id: "slack:z", target: "own:1" },
    ]);
  });
});

describe("refresh prompts", () => {
  it("include the index and the refine rule only when there's an index", async () => {
    const { projectPrompt, adhocPrompt } = await import("./prompts");
    const index = [{ id: "own:1", title: "Send Q3 numbers" }];
    const now = new Date(2026, 9, 30);
    const project = (i?: typeof index) =>
      projectPrompt({ index: i, channelId: "C1", channelName: "tmp-x", userId: "U1", previous: null, lastRefreshedAt: null, repoState: null, now });
    const adhoc = (i?: typeof index) => adhocPrompt({ index: i, userId: "U1", previous: [], previousReplies: [], lastRefreshedAt: null, now });
    for (const make of [project, adhoc]) {
      expect(make(index)).toContain('{"id":"own:1","title":"Send Q3 numbers"}');
      expect(make(index)).toContain("set refines to the listed task's id");
      expect(make()).not.toContain("set refines to the listed task's id");
      expect(make(index)).toContain('"refines": string|null');
    }
  });
});
