import { describe, expect, it } from "vitest";
import { enqueueStep, FEED_MAX_WAITING, stepMs, type FeedItem } from "./statusFeed";

describe("status feed", () => {
  it("writes every action, in the order they happen, so concurrent jobs interleave", () => {
    let q: FeedItem[] = [];
    for (const [key, text] of [["t1", "t1 step 1"], ["t2", "t2 step 1"], ["t1", "t1 step 2"], ["t2", "t2 step 2"]]) q = enqueueStep(q, { key, text });
    expect(q.map((i) => i.text)).toEqual(["t1 step 1", "t2 step 1", "t1 step 2", "t2 step 2"]);
  });

  it("keeps only the newest actions when the backlog is long", () => {
    let q: FeedItem[] = [];
    for (let i = 0; i < FEED_MAX_WAITING + 5; i++) q = enqueueStep(q, { key: "t", text: String(i) });
    expect(q).toHaveLength(FEED_MAX_WAITING);
    expect(q[0].text).toBe("5");
  });

  it("speeds up as actions back up", () => {
    expect(stepMs(0)).toBe(800);
    expect(stepMs(10)).toBe(400);
    expect(stepMs(100)).toBe(150);
  });
});

import { isChatJob } from "./statusFeed";
describe("chat jobs", () => {
  it("leaves chats and their handoffs out of the bottom line", () => {
    expect(isChatJob("session:manual:abc")).toBe(true);
    expect(isChatJob("session:global:123")).toBe(true);
    expect(isChatJob("handoff:manual:abc")).toBe(true);
    expect(isChatJob("project:C1")).toBe(false);
    expect(isChatJob("plan:manual:abc")).toBe(false);
  });
});
