import { describe, expect, it, vi } from "vitest";
import { SAME_WORK_RULE } from "./baseLessons";
import { GLOBAL_ACTION_DOCS } from "./openInClaude";
import { adhocPrompt, checkTaskPrompt, sameWorkPrompt, selfDmActionsPrompt } from "./prompts";
import { formatWhen } from "./scheduler";

const index = [
  { id: "manual:a", title: "Grow the beta group" },
  { id: "slack:b", title: "Set criteria for adding people to #beta", not_same_as: ["proj:c"] },
];

describe("one rule for the same work", () => {
  it("is given wherever tasks are judged the same", () => {
    const prompts = [
      adhocPrompt({ userId: "U1", previous: [], previousReplies: [], projectChannels: [], lastRefreshedAt: null, now: new Date(2026, 10, 4), index }),
      checkTaskPrompt({ task: { title: "x", description: null, source: "Slack", link: null, requester: null, due: null, priority: null }, otherTasks: [], userId: null }),
      GLOBAL_ACTION_DOCS,
      selfDmActionsPrompt([{ ts: "1793000000.000100", text: "Book the venue #demian" }], ""),
      sameWorkPrompt(index),
    ];
    for (const p of prompts) expect(p).toContain(SAME_WORK_RULE);
  });

  it("asks the merge pass about every open task, keeping the user's own and the pairs they separated", () => {
    const p = sameWorkPrompt(index);
    expect(p).toContain('"id":"manual:a"');
    expect(p).toContain('"not_same_as":["proj:c"]');
    expect(p).toContain('Keep the user\'s own task (an id starting "manual:")');
    expect(p).not.toContain("were just added");
    expect(sameWorkPrompt(index, ["manual:a"])).toContain("These tasks were just added: manual:a");
  });
});

describe("timestamps", () => {
  it("show a time only for today; other days are just the day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 4, 15, 0));
    try {
      expect(formatWhen(new Date(2026, 10, 4, 10, 17).toISOString())).toMatch(/^10:17\s?AM$/);
      expect(formatWhen(new Date(2026, 10, 3, 10, 17).toISOString())).toBe("Yesterday");
      expect(formatWhen(new Date(2026, 10, 2, 10, 17).toISOString())).toBe("Nov 2");
      expect(formatWhen("2026-11-04")).toBe("Nov 4");
    } finally {
      vi.useRealTimers();
    }
  });
});
