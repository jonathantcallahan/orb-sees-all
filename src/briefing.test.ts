import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: vi.fn() } }));

const { readingPrompt } = await import("./prompts");
const { messagesSince } = await import("./jobs");
const { updateLabel } = await import("./reading");

describe("the daily briefing", () => {
  it("looks for new messages from the right window: yesterday, or Friday on a Monday", () => {
    expect(messagesSince(new Date(2026, 10, 5, 8)).date).toBe("2026-11-04"); // Thursday
    expect(messagesSince(new Date(2026, 10, 9, 8)).date).toBe("2026-11-06"); // Monday → Friday
  });

  it("reads new DMs, mentions and email since then, only reads, and stays grounded", () => {
    const p = readingPrompt({ projects: [] }, "U1", { date: "2026-11-04", unix: 0 });
    expect(p).toContain('"is:dm after:2026-11-04"');
    expect(p).toContain('"<@U1> after:2026-11-04"');
    expect(p).toContain("in:inbox after:2026/11/04");
    expect(p).toContain("Never send, post, react, draft, or modify anything");
    expect(p).toContain("Every fact must come from the snapshot above or a message you read");
    // It briefs; it doesn't plan the day.
    expect(p).toContain("No advice on how to spend the day");
    expect(p).not.toContain("open time between meetings");
  });
});

describe("an update's eyebrow", () => {
  it("keeps a channel as it is", () => {
    expect(updateLabel("#launch-room")).toBe("#launch-room");
  });

  it("drops what mail clients add around a subject", () => {
    expect(updateLabel("Email: Invitation: Pricing review @ Mon Nov 17, 2026 10am - 11am (CST) (someone@example.com)")).toBe("Email: Pricing review");
    expect(updateLabel("Email: RE: Fwd: Q4 plan")).toBe("Email: Q4 plan");
    expect(updateLabel("Email: Where should admin tooling live?")).toBe("Email: Where should admin tooling live?");
    // An "@" of the subject's own stays; an invite's date goes even without its prefix.
    expect(updateLabel("Email: Lunch @ the new office")).toBe("Email: Lunch @ the new office");
    expect(updateLabel("Email: Fwd: Pricing review @ Tue Nov 18, 2026 2pm - 3pm (CST)")).toBe("Email: Pricing review");
  });

  it("says News when there's nowhere", () => {
    expect(updateLabel(null)).toBe("News");
  });
});
