import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./db", () => ({}));
vi.mock("./jobs", () => ({}));
vi.mock("./claude", () => ({}));

const { describeAction } = await import("./globalActions");

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

describe("adding a task from the chat", () => {
  it("describes Today, status and priority on the card", () => {
    const a = { type: "add_task", title: "Get codes", today: true, status: "in_progress", priority: "high" } as const;
    expect(describeAction(a, project, channel, items)).toBe('Add the task "Get codes", in Today\'s tasks, in progress, high priority');
  });
});
