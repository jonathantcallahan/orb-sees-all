import { describe, expect, it } from "vitest";
import { briefingKey, briefingRead, briefingUnread } from "./reading";
import { DEFAULT_TASK_STATE } from "./tasks";

describe("briefingKey", () => {
  it("is the briefing's day and when it was written", () => {
    expect(briefingKey({ date: "2026-11-24", created_at: "2026-11-24T07:30:12.000Z" })).toBe("briefing:2026-11-24:2026-11-24T07:30:12.000Z");
  });

  it("differs for a briefing written again the same day, so marking one read doesn't hide the next", () => {
    expect(briefingKey({ date: "2026-11-24", created_at: "2026-11-24T07:30:12.000Z" })).not.toBe(briefingKey({ date: "2026-11-24", created_at: "2026-11-24T13:02:40.000Z" }));
  });
});

describe("briefingUnread", () => {
  const reading = { date: "2026-11-24", text: "A quiet morning.", created_at: "2026-11-24T07:30:12.000Z" };

  it("is today's briefing until it's marked read", () => {
    expect(briefingUnread(reading, new Map(), "2026-11-24")).toBe(true);
    expect(briefingUnread(reading, new Map([[briefingKey(reading), { ...DEFAULT_TASK_STATE, dismissed: true }]]), "2026-11-24")).toBe(false);
  });

  it("isn't yesterday's, or one there isn't", () => {
    expect(briefingUnread(reading, new Map(), "2026-11-25")).toBe(false);
    expect(briefingUnread(null, new Map(), "2026-11-24")).toBe(false);
  });
});

describe("briefingRead", () => {
  const reading = { date: "2026-11-24", text: "A quiet morning.", created_at: "2026-11-24T07:30:12.000Z" };
  const read = new Map([[briefingKey(reading), { ...DEFAULT_TASK_STATE, dismissed: true }]]);

  it("is today's briefing once it's marked read", () => {
    expect(briefingRead(reading, read, "2026-11-24")).toBe(true);
    expect(briefingRead(reading, new Map(), "2026-11-24")).toBe(false);
  });

  it("isn't before today's is written: none yet, or only yesterday's", () => {
    expect(briefingRead(null, new Map(), "2026-11-24")).toBe(false);
    expect(briefingRead(reading, read, "2026-11-25")).toBe(false);
  });
});
