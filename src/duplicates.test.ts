import { describe, expect, it } from "vitest";
import { findDuplicates, similarity } from "./duplicates";

describe("duplicate detection", () => {
  const send = { id: "a", title: "Send Q3 asset numbers to Ben", description: "Ben needs Q3 submission numbers for the review deck." };
  const sendAgain = { id: "b", title: "Send Ben the Q3 asset number", description: null };
  const review = { id: "c", title: "Review Maya's pricing doc", description: "Comment on the pricing proposal by Friday." };

  it("matches the same task worded differently, and not unrelated ones", () => {
    expect(similarity(send, sendAgain)).toBeGreaterThanOrEqual(0.5);
    expect(similarity(send, review)).toBeLessThan(0.5);
  });

  it("uses descriptions to confirm a looser title match", () => {
    const a = { id: "x", title: "Refund reason codes", description: "Get the refund reason codes and scenarios from commerce for QA." };
    const b = { id: "y", title: "Chase commerce on reason codes", description: "QA needs refund reason codes and scenarios from commerce." };
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.5);
  });

  it("points each task at its likeliest duplicate, skipping pairs marked not duplicates", () => {
    const found = findDuplicates([send, sendAgain, review], new Set());
    expect(found.get("a")).toEqual({ id: "b", title: sendAgain.title });
    expect(found.get("b")).toEqual({ id: "a", title: send.title });
    expect(found.has("c")).toBe(false);
    expect(findDuplicates([send, sendAgain], new Set(["a|b"])).size).toBe(0);
  });
});
