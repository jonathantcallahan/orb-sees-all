import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./db", () => ({}));
vi.mock("./jobs", () => ({}));
vi.mock("./claude", () => ({}));

const { projectChatKey, projectOfChat, projectRecordText } = await import("./projectChat");
const { projectChatPrompt } = await import("./openInClaude");
const { PathToShip } = await import("./schema");

const path = PathToShip.parse({
  now: "The refund button is live; card refunds wait on a vendor call.",
  ship: { what: "Refunds live", date: "2026-12-12", source: null },
  initiatives: [{ id: "i1", what: "Self-serve refunds", jira: { key: "PAY-1", link: null } }],
  steps: [
    {
      what: "Refund requests",
      status: "in_progress",
      initiative: "i1",
      epic: { key: "PAY-10", link: null },
      owners: ["Raj Das"],
      items: [
        { key: "PAY-7772", title: "Review refund reasons", type: "Story", status: "next", assignee: "Kim Lee", requirements: ["r1"] },
        { key: null, id: "t1", title: "Share specs with payments", type: "Task", status: "next" },
      ],
    },
  ],
});

const project = {
  channel_id: "C1",
  name: "tmp-refunds",
  snapshot: { status: "at_risk", status_reason: "Vendor decision pending", path },
  kind_choice: { kind: "project" },
  last_refreshed_at: "2026-11-17T00:00:00Z",
  status_override: null,
  profile: {
    goal: "Let buyers refund their own orders.",
    people: [{ name: "Kim Lee", role: "Payments lead", raci: "responsible", working_on: "card refunds" }],
    milestones: [{ what: "Refund button live", date: "2026-10-28", status: "done" }],
    decisions: [],
    resources: [{ title: "Refunds TDD", link: "https://docs/x" }],
  },
  docs: { doc: { link: "https://docs/x", title: "Refunds TDD" } },
  requirements: { link: "https://docs/x", requirements: [{ id: "r1", text: "Buyers refund an order themselves", priority: "must" }], progress: { r1: { status: "in_progress" } } },
} as never;

describe("a project's chat", () => {
  it("has one chat per project, known by its key", () => {
    expect(projectChatKey("C1")).toBe("global:project:C1");
    expect(projectOfChat("global:project:C1")).toBe("C1");
    expect(projectOfChat("global:123")).toBeNull();
  });

  it("is told the project's record: purpose, status, people, plan with requirements and pull requests", () => {
    const text = projectRecordText(project, [
      { kind: "pr", title: "#41 Review types", url: "https://github.com/a/b/pull/41", state: "open", detail: "pay-7772-types" },
      { kind: "pr", title: "#40 Bump deps", url: "https://github.com/a/b/pull/40", state: "merged", detail: "deps" },
    ]);
    expect(text).toContain("This chat is about");
    expect(text).toContain("[id C1]");
    expect(text).toContain("Purpose: Let buyers refund their own orders.");
    expect(text).toContain("Status: at_risk: Vendor decision pending");
    expect(text).toContain("Ships: Refunds live on 2026-12-12");
    expect(text).toContain("- Kim Lee (responsible): Payments lead; working on card refunds");
    expect(text).toContain("- Initiative PAY-1: Self-serve refunds");
    expect(text).toContain("  - Epic PAY-10: Refund requests [in_progress, Raj Das]");
    expect(text).toContain("- PAY-7772 Story: Review refund reasons [next, Kim Lee]");
    expect(text).toMatch(/requirement r1 \[in_progress\] \(must\): Buyers refund an order themselves/);
    expect(text).toMatch(/pull request #41 Review types \[open\] \(its name has the key; the ticket doesn't link it\) https:\/\/github.com\/a\/b\/pull\/41/);
    expect(text).toContain("- (no ticket yet) Task: Share specs with payments [next]");
    // A pull request naming nothing on the plan isn't the project's work: left out.
    expect(text).not.toContain("#40 Bump deps");
    expect(text).toContain("Milestones:\n- 2026-10-28: Refund button live [done]");
    expect(text).toContain("Links:\n- Refunds TDD: https://docs/x");
  });

  it("opens on the project, with the changes it can propose and the user's message", () => {
    const text = projectChatPrompt("global:project:C1", { name: "Refunds", id: "C1" }, "What's left?");
    expect(text).toContain("one of my projects, Refunds [id C1]");
    expect(text).toContain("[orb] action");
    expect(text).toContain("Work, full screen");
    expect(text.endsWith("\nMy message: What's left?")).toBe(true);
  });
});
