import { describe, expect, it } from "vitest";
import { canonicalId, foldTasks } from "./registry";

describe("task registry", () => {
  const aliases = new Map([
    ["slack:later-message", "own:1"],
    ["slack:dm", "own:1"],
  ]);

  it("resolves any alias to its canonical id", () => {
    expect(canonicalId("slack:dm", aliases)).toBe("own:1");
    expect(canonicalId("own:1", aliases)).toBe("own:1");
    expect(canonicalId("unrelated", aliases)).toBe("unrelated");
  });

  it("folds the same work across lists into the canonical task", () => {
    const own = [{ id: "own:1", title: "Send numbers", link: null, due: "2026-11-05" }];
    const project = [
      { id: "slack:later-message", title: "Send Q3 numbers", link: "https://x.slack.com/a", due: "2026-11-03", blocking: true },
      { id: "other", title: "Something else", link: null },
    ];
    const requests = [{ id: "slack:dm", title: "Numbers?", link: "https://x.slack.com/b", recommended: true }];
    const [o, p, r] = foldTasks<{ id: string; title: string; link?: string | null; due?: string | null; blocking?: boolean; recommended?: boolean }>(
      [own, project, requests],
      aliases,
    );
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ id: "own:1", title: "Send numbers", due: "2026-11-03", blocking: true, recommended: true });
    expect(o[0].aliasIds).toEqual(["own:1", "slack:later-message", "slack:dm"]);
    expect(o[0].aliasLinks).toEqual(["https://x.slack.com/a", "https://x.slack.com/b"]);
    expect(p.map((t) => t.id)).toEqual(["other"]);
    expect(r).toEqual([]);
  });

  it("keeps the first alias, under the canonical id, when the original is gone", () => {
    const [p] = foldTasks([[{ id: "slack:later-message", link: null }]], aliases);
    expect(p.map((t) => t.id)).toEqual(["own:1"]);
  });
});
