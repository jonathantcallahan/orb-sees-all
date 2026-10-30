import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./db", () => ({}));

const { parseProgress } = await import("./sessions");
const { startPrompt, sessionMarker } = await import("./openInClaude");

describe("session progress", () => {
  it("keeps each step's latest report", () => {
    expect(
      parseProgress([
        "[orb] step 1 started",
        "[orb] step 1 done",
        "[orb] step 2 started",
        "[orb] step 3 waiting: need Eric's export",
        "[orb] Step 4 DONE",
        "not a report",
      ]),
    ).toEqual({
      1: { state: "done" },
      2: { state: "started" },
      3: { state: "waiting", note: "need Eric's export" },
      4: { state: "done" },
    });
  });

  it("puts the marker first and asks for progress lines in Approve & start", () => {
    const p = startPrompt({ id: "t-42", title: "Draft the ticket" }, "Claude drafts it.", [{ title: "Read CPS-1", by: "claude" }]);
    expect(p.startsWith(`${sessionMarker("t-42")}\n`)).toBe(true);
    expect(p).toContain("[orb] step N done");
  });

  it("leaves the marker out without a task id", () => {
    const p = startPrompt({ title: "Draft the ticket" }, "Claude drafts it.", [{ title: "Read CPS-1", by: "claude" }]);
    expect(p).not.toContain("Orb task:");
    expect(p).not.toContain("[orb]");
  });
});
