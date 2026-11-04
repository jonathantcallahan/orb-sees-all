import { describe, expect, it } from "vitest";
import { acceptedMerges, findDuplicates, pairKey, similarity } from "./duplicates";

describe("duplicate detection", () => {
  const send = { id: "a", title: "Send Q3 asset numbers to Ben", description: "Ben needs Q3 submission numbers for the review deck." };
  const sendAgain = { id: "b", title: "Send Ben the Q3 asset number", description: null };
  const review = { id: "c", title: "Review Maya's pricing doc", description: "Comment on the pricing proposal by Friday." };

  it("matches the same task worded differently, and not unrelated ones", () => {
    expect(similarity(send, sendAgain)).toBeGreaterThanOrEqual(0.5);
    expect(similarity(send, review)).toBeLessThan(0.5);
  });

  it("uses descriptions to confirm a looser title match", () => {
    const a = { id: "x", title: "Refund reason codes", description: "Get the refund reason codes and scenarios from payments for QA." };
    const b = { id: "y", title: "Chase payments on reason codes", description: "QA needs refund reason codes and scenarios from payments." };
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

describe("merging the same work", () => {
  const known = (over: Partial<Parameters<typeof acceptedMerges>[1]> = {}) => ({
    open: new Set(["manual:a", "slack:b", "proj:c", "proj:d"]),
    mine: new Set(["manual:a"]),
    notDuplicates: new Set<string>(),
    sessions: new Set<string>(),
    aliases: new Map<string, string>(),
    ...over,
  });

  it("merges each of a set into the one kept, with why", () => {
    expect(acceptedMerges([{ keep: "slack:b", drop: ["proj:c"], why: "Same test plan" }], known())).toEqual([{ keep: "slack:b", drop: "proj:c", why: "Same test plan" }]);
  });

  it("keeps the user's own task over one a refresh found", () => {
    const merges = acceptedMerges([{ keep: "slack:b", drop: ["manual:a", "proj:c"] }], known());
    expect(merges.map((m) => [m.keep, m.drop])).toEqual([["manual:a", "slack:b"], ["manual:a", "proj:c"]]);
  });

  it("drops unknown or closed ids, and a task both kept and dropped", () => {
    expect(acceptedMerges([{ keep: "slack:b", drop: ["gone", "slack:b"] }], known())).toEqual([]);
    expect(acceptedMerges([{ keep: "gone", drop: ["slack:b", "proj:c"] }], known())).toEqual([{ keep: "slack:b", drop: "proj:c", why: null }]);
  });

  it("works on canonical ids, so an alias of a task is that task", () => {
    expect(acceptedMerges([{ keep: "slack:b", drop: ["old:c"] }], known({ aliases: new Map([["old:c", "proj:c"]]) }))).toEqual([{ keep: "slack:b", drop: "proj:c", why: null }]);
    expect(acceptedMerges([{ keep: "slack:b", drop: ["old:b"] }], known({ aliases: new Map([["old:b", "slack:b"]]) }))).toEqual([]);
  });

  it("never merges a pair the user separated", () => {
    expect(acceptedMerges([{ keep: "slack:b", drop: ["proj:c"] }], known({ notDuplicates: new Set([pairKey("proj:c", "slack:b")]) }))).toEqual([]);
  });

  it("leaves apart two tasks that each have a Claude session", () => {
    expect(acceptedMerges([{ keep: "slack:b", drop: ["proj:c"] }], known({ sessions: new Set(["slack:b", "proj:c"]) }))).toEqual([]);
    expect(acceptedMerges([{ keep: "slack:b", drop: ["proj:c"] }], known({ sessions: new Set(["proj:c"]) }))).toHaveLength(1);
  });

  it("merges a task once per pass, and with focus only sets that include a new task", () => {
    expect(acceptedMerges([{ keep: "slack:b", drop: ["proj:c"] }, { keep: "proj:d", drop: ["proj:c"] }], known())).toEqual([{ keep: "slack:b", drop: "proj:c", why: null }]);
    const focus = new Set(["manual:a"]);
    expect(acceptedMerges([{ keep: "slack:b", drop: ["proj:c"] }], known({ focus }))).toEqual([]);
    expect(acceptedMerges([{ keep: "manual:a", drop: ["proj:d"] }], known({ focus }))).toHaveLength(1);
  });
});
