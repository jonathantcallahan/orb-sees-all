import { describe, expect, it } from "vitest";
import { TITLE_MAX, TITLE_RULE } from "./baseLessons";
import { longTitled } from "./tasks";
import { adhocPrompt, assessPrompt, calendarPrompt, selfDmActionsPrompt, shortenTitlesPrompt, watchedEntryPrompt } from "./prompts";

describe("short task titles", () => {
  it("is given to every prompt that writes a task title", () => {
    const prompts = [
      adhocPrompt({ userId: "U1", previous: [], previousReplies: [], projectChannels: [], lastRefreshedAt: null, now: new Date(2026, 10, 4) }),
      assessPrompt({ userId: "U1", tasks: [{ id: "m1", title: "x", description: null }] }),
      calendarPrompt({ date: "2026-11-04", timeZone: "UTC", projectNames: [] }),
      // The DM's tasks are titled when its messages are turned into changes (add_task), not when they're read.
      selfDmActionsPrompt([{ ts: "1793000000.000100", text: "Book the venue #demian" }], ""),
      watchedEntryPrompt("If X by Friday, do Y", new Date(2026, 10, 4)),
      shortenTitlesPrompt([{ id: "m1", title: "a very long title" }]),
    ];
    for (const p of prompts) expect(p).toContain(TITLE_RULE);
  });

  it("picks only titles longer than the limit", () => {
    const ok = { title: "Draft reply to the pricing feedback thread" };
    const long = { title: "Follow up on the old pricing page redirects, which Sam set up but marketing can't see yet" };
    expect(ok.title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(longTitled([ok, long])).toEqual([long]);
  });
});
