import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./db", () => ({}));
vi.mock("./jobs", () => ({}));
vi.mock("./claude", () => ({}));

const { describeAction, findTask, taskChatMoves } = await import("./globalActions");

const project = (id: string) => (id === "C1" ? "Store" : id);
const channel = (id: string) => id;
const items = (projectId: string, itemId: string) => (projectId === "C1" && itemId === "b1" ? "Legal sign-off" : null);

describe("action cards", () => {
  it("names a project item from its id, not the chat's words for it", () => {
    const a = { type: "resolve_project_item", project_id: "C1", item_id: "b1", what: "Something else" } as const;
    expect(describeAction(a, project, channel, items)).toBe('Mark "Legal sign-off" done in "Store"');
    const check = { type: "check_project_item", project_id: "C1", item_id: "b1", what: "Something else" } as const;
    expect(describeAction(check, project, channel, items)).toBe('Double check "Legal sign-off" in "Store"');
  });

  it("says so when the item isn't on the project", () => {
    const a = { type: "resolve_project_item", project_id: "C1", item_id: "gone", what: "Legal sign-off" } as const;
    expect(describeAction(a, project, channel, items)).toMatch(/isn't on "Store" any more/);
  });
});

describe("context and watching", () => {
  it("describes adding to a task and watching a topic", () => {
    expect(describeAction({ type: "add_task_context", task_id: "m1", title: "Book venue", text: "Ana prefers Thursday" }, project, channel, items)).toBe('Add to "Book venue": Ana prefers Thursday');
    expect(describeAction({ type: "watch_topic", text: "Legal sign-off by Friday, else chase them" }, project, channel, items)).toBe("Watch: Legal sign-off by Friday, else chase them");
  });
});

describe("adding a task from the chat", () => {
  it("describes Today, status and priority on the card", () => {
    const a = { type: "add_task", title: "Get codes", today: true, status: "in_progress", priority: "high" } as const;
    expect(describeAction(a, project, channel, items)).toBe('Add the task "Get codes", in Today\'s tasks, in progress, high priority');
  });
});

describe("changing an existing task from the chat", () => {
  const tasks = [
    { id: "manual:1", title: "Find the store link for the draft listing", open: true },
    { id: "manual:2", title: "Book the venue", open: false },
    { id: "slack:3", title: "Reply to Ana", open: true },
  ];
  const aliases = new Map([["slack:9", "slack:3"]]);

  it("finds the task by its id, or the task that id was merged into", () => {
    expect(findTask(tasks, aliases, "manual:1", null)).toBe("manual:1");
    expect(findTask(tasks, aliases, "slack:9", null)).toBe("slack:3");
    // A done task can still be changed by id (to reopen it).
    expect(findTask(tasks, aliases, "manual:2", "Book the venue")).toBe("manual:2");
  });

  it("falls back to an open task with that exact title when the id is missing or wrong", () => {
    expect(findTask(tasks, aliases, null, "Find the store link for the draft listing")).toBe("manual:1");
    expect(findTask(tasks, aliases, "manual:404", '"find the store  link for the draft listing"')).toBe("manual:1");
    // Not by a title that only resembles one, and not a closed task by title.
    expect(findTask(tasks, aliases, null, "Find the store link")).toBeNull();
    expect(findTask(tasks, aliases, null, "Book the venue")).toBeNull();
    // Nothing to go on: the change fails rather than landing on a task that isn't there.
    expect(findTask(tasks, aliases, "manual:404", null)).toBeNull();
  });

  it("describes moving a task to another project", () => {
    expect(describeAction({ type: "set_task_project", task_id: "slack:3", title: "Review the spec", project_id: "C1" }, project, channel, items)).toBe('Move "Review the spec" to "Store"');
    expect(describeAction({ type: "set_task_project", task_id: "manual:1", title: "Review the spec", project_id: null }, project, channel, items)).toBe('Take "Review the spec" out of its project');
  });

  it("describes blocking, renaming and replanning a task on the card", () => {
    expect(describeAction({ type: "set_task_status", task_id: "manual:1", title: "Get the URL", status: "blocked" }, project, channel, items)).toBe('Mark "Get the URL" blocked');
    expect(describeAction({ type: "update_task", task_id: "manual:1", title: "Get the URL", new_title: "Check Sam's account settings" }, project, channel, items)).toBe(
      'Rename "Get the URL" to "Check Sam\'s account settings"',
    );
    expect(
      describeAction(
        { type: "set_task_plan", task_id: "manual:1", title: "Get the URL", steps: [{ title: "Sam confirms the org", by: "claude" }, { title: "Send the URL", by: "you" }] },
        project,
        channel,
        items,
      ),
    ).toBe('New plan for "Get the URL": 1. Sam confirms the org · 2. [Me] Send the URL');
  });
});

describe("a task's chat moving its task", () => {
  it("keeps only moves, made about the chat's own task", () => {
    const moves = taskChatMoves(
      [
        { key: "a", action: { type: "set_task_project", task_id: "slack:other", title: "Something else", project_id: "C1" } as const },
        { key: "b", action: { type: "set_task_status", task_id: "slack:3", status: "done" } as const },
        { key: "c", action: null },
      ],
      "slack:3",
      "Review the spec",
    );
    expect(moves).toEqual([{ key: "a", action: { type: "set_task_project", task_id: "slack:3", title: "Review the spec", project_id: "C1" } }]);
  });
});
