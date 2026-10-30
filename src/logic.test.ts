import { describe, expect, it } from "vitest";
import { dayRange, layoutDay, nowOffset } from "./calendar";
import { JobQueue } from "./jobs/queue";
import { claudeSessionUrl, sessionPrompt, startPrompt } from "./openInClaude";
import { nameFromChannel, projectName } from "./projects";
import { readingContext } from "./reading";
import { reminderText, sendReminderPrompt, toSlackMentions, windowStart } from "./prompts";
import { shouldRunMorning } from "./scheduler";
import { applyTaskState, compareProjects, DEFAULT_TASK_STATE, formatMinutes, matchesFilter, matchesProjectFilter, NO_FILTER, NO_PROJECT_FILTER, orbMood, pressure, splitToday, taskPriority, type EffectivePriority, type TaskFilter, type TaskState, LOAD_SCALE } from "./tasks";

const st = ({ done = false, dismissed = false }: { done?: boolean; dismissed?: boolean }): TaskState => ({
  ...DEFAULT_TASK_STATE,
  status: done ? "done" : "todo",
  done,
  dismissed,
});

describe("shouldRunMorning", () => {
  const schedule = { time: "07:30", weekdaysOnly: true };
  // Thursday 29 Oct 2026, local time.
  const at = (h: number, m: number, day = 29) => new Date(2026, 9, day, h, m);

  it("waits until the scheduled time", () => {
    expect(shouldRunMorning(at(7, 29), schedule, null)).toBe(false);
    expect(shouldRunMorning(at(7, 30), schedule, null)).toBe(true);
  });

  it("catches up later in the day after sleeping through it", () => {
    expect(shouldRunMorning(at(11, 5), schedule, "2026-10-28")).toBe(true);
  });

  it("runs once per day", () => {
    expect(shouldRunMorning(at(9, 0), schedule, "2026-10-29")).toBe(false);
  });

  it("skips weekends unless told otherwise", () => {
    expect(shouldRunMorning(at(9, 0, 31), schedule, null)).toBe(false);
    expect(shouldRunMorning(at(9, 0, 31), { ...schedule, weekdaysOnly: false }, null)).toBe(true);
  });
});

describe("applyTaskState", () => {
  const tasks = [
    { id: "a", title: "A" },
    { id: "b", title: "B" },
    { id: "c", title: "C" },
  ];

  it("keeps a checked task checked after a refresh returns it again", () => {
    const states = new Map([["a", st({ done: true, dismissed: false })]]);
    const refreshed = [...tasks];
    expect(applyTaskState(refreshed, states).find((t) => t.id === "a")?.done).toBe(true);
  });

  it("hides dismissed tasks and sorts done ones last", () => {
    const states = new Map([
      ["a", st({ done: true, dismissed: false })],
      ["b", st({ done: false, dismissed: true })],
    ]);
    expect(applyTaskState(tasks, states).map((t) => t.id)).toEqual(["c", "a"]);
  });
});

describe("compareProjects", () => {
  it("puts blocked, then at risk, then the rest within a priority", () => {
    const list = [
      { name: "z", status: "on_track" as const },
      { name: "y", status: null },
      { name: "x", status: "at_risk" as const },
      { name: "w", status: "blocked" as const },
    ];
    expect(list.sort(compareProjects).map((p) => p.name)).toEqual(["w", "x", "z", "y"]);
  });

  it("puts P0 projects first, whatever their status", () => {
    const list = [
      { name: "a", status: "blocked" as const, priority: "P2" },
      { name: "b", status: "on_track" as const, priority: "P0" },
      { name: "c", status: "at_risk" as const, priority: null },
      { name: "d", status: "blocked" as const, priority: "P0" },
    ];
    expect(list.sort(compareProjects).map((p) => p.name)).toEqual(["d", "b", "a", "c"]);
  });
});

describe("windowStart", () => {
  const now = new Date("2026-10-29T15:00:00Z");

  it("reads 14 days on the first run", () => {
    expect(windowStart(null, now, 14).date).toBe("2026-10-15");
  });

  it("overlaps the last refresh by an hour", () => {
    const w = windowStart("2026-10-29T07:30:00Z", now, 14);
    expect(w.unix).toBe(Date.parse("2026-10-29T06:30:00Z") / 1000);
  });
});

describe("JobQueue", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("dedupes jobs with the same key", async () => {
    const q = new JobQueue(3);
    let calls = 0;
    const gate = deferred();
    const fn = async () => {
      calls++;
      await gate.promise;
    };
    const a = q.run("project:1", fn);
    const b = q.run("project:1", fn);
    expect(a).toBe(b);
    gate.resolve();
    await a;
    expect(calls).toBe(1);
    expect(q.keys()).toEqual([]);
  });

  it("limits concurrency", async () => {
    const q = new JobQueue(2);
    let active = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred()];
    const jobs = gates.map((g, i) =>
      q.run(`j${i}`, async () => {
        peak = Math.max(peak, ++active);
        await g.promise;
        active--;
      }),
    );
    await Promise.resolve();
    gates.forEach((g) => g.resolve());
    await Promise.all(jobs);
    expect(peak).toBe(2);
  });

  it("lets a coordinating job wait on others without taking a slot", async () => {
    const q = new JobQueue(1);
    await q.run("all", () => q.run("child", async () => "done"), false);
  });
});

describe("pressure", () => {
  const now = new Date(2026, 9, 29, 9, 0);
  const none = new Map<string, TaskState>();
  const task = (id: string, priority: EffectivePriority | null, extra: { due?: string; projectId?: string } = {}) => ({ id, priority, ...extra });

  it("is calm with nothing on the user", () => {
    expect(pressure([], none, now)).toMatchObject({ load: 0, level: 0 });
  });

  it("weighs blocking and high-priority work most, and due dates a little", () => {
    const p = pressure(
      [
        task("a", "blocking", { projectId: "C1" }), // 6
        task("b", "critical", { projectId: "C1" }), // 2.5
        task("c", "high", { projectId: "C2", due: "2026-10-30" }), // 0.75 + 0.5 due soon
        task("d", "medium", { due: "2026-10-28" }), // 0.1 + 1 overdue
        task("e", null), // 0.05
      ],
      none,
      now,
    );
    // Only C1 has a blocker of yours; C2 just has a task.
    expect(p).toMatchObject({ projectsOnMe: 1, criticalTasks: 2 });
    expect(p.load).toBeCloseTo(10.9);
    expect(p.level).toBeCloseTo(1 - Math.exp(-10.9 / LOAD_SCALE));
  });

  it("barely notices a long medium and low backlog", () => {
    const backlog = Array.from({ length: 40 }, (_, i) => task(`m${i}`, i % 2 ? "medium" : "low"));
    expect(orbMood(pressure(backlog, none, now))).toBe("serene");
  });

  it("ignores done and dismissed tasks", () => {
    const states = new Map([
      ["a", st({ done: true, dismissed: false })],
      ["b", st({ done: false, dismissed: true })],
    ]);
    expect(pressure([task("a", "critical"), task("b", "critical")], states, now)).toMatchObject({ load: 0, level: 0 });
  });

  it("eases with every task finished, and never pins at 1", () => {
    const tasks = Array.from({ length: 30 }, (_, i) => task(`t${i}`, "critical"));
    const levels = [0, 10, 20, 29].map((done) => {
      const states = new Map(tasks.slice(0, done).map((t) => [t.id, st({ done: true })] as const));
      return pressure(tasks, states, now).level;
    });
    expect(levels[0]).toBeLessThan(1);
    expect(levels).toEqual([...levels].sort((a, b) => b - a));
    expect(new Set(levels).size).toBe(levels.length);
  });
});

describe("splitToday", () => {
  const today = "2026-10-29";
  const t = (id: string, todayOn: string | null, done = false) => ({ id, todayOn, done });

  it("plans tasks picked for today and carries unfinished ones forward", () => {
    const { planned, rest } = splitToday(
      [t("a", today), t("b", "2026-10-27"), t("c", "2026-10-27", true), t("d", null), t("e", today, true)],
      today,
    );
    expect(planned.map((p) => [p.id, p.carriedFrom])).toEqual([
      ["a", null],
      ["b", "2026-10-27"],
      ["e", null],
    ]);
    expect(rest.map((r) => r.id)).toEqual(["c", "d"]);
  });
});

describe("formatMinutes", () => {
  it("formats minutes and hours", () => {
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(150)).toBe("2h 30m");
  });
});

describe("orbMood", () => {
  const m = (load: number) => orbMood({ load, level: 1 - Math.exp(-load / LOAD_SCALE) });

  it("is pleased only when nothing is waiting", () => {
    expect(m(0)).toBe("pleased");
    expect(m(0.25)).toBe("serene");
  });

  it("moves through each mood as the load grows", () => {
    const moods = [0, 2, 7, 14, 22, 33, 50, 80].map(m);
    expect(moods).toEqual(["pleased", "serene", "content", "attentive", "restless", "agitated", "irritated", "furious"]);
  });

  it("takes real trouble to be furious", () => {
    // Ten critical tasks and twenty high ones: busy, not furious.
    expect(m(10 * 2.5 + 20 * 0.75)).toBe("agitated");
    // Four blockers on top of that is.
    expect(m(10 * 2.5 + 20 * 0.75 + 4 * 6)).toBe("irritated");
  });
});

describe("project names", () => {
  it("derives a readable name from the channel", () => {
    expect(nameFromChannel("tmp-asset-refunds")).toBe("Asset refunds");
    expect(nameFromChannel("tmp-ucs-googleadmob")).toBe("Ucs googleadmob");
  });

  it("prefers the name Claude gave the project", () => {
    expect(projectName({ name: "tmp-ucs-googleadmob", snapshot: null })).toBe("Ucs googleadmob");
    expect(projectName({ name: "tmp-ucs-googleadmob", snapshot: { name: "UCS Google AdMob" } as never })).toBe("UCS Google AdMob");
  });
});

describe("calendar layout", () => {
  // Local times on 29 Oct 2026.
  const at = (h: number, m = 0) => new Date(2026, 9, 29, h, m).toISOString();
  const ev = (id: string, s: [number, number], e: [number, number]) => ({ id, start: at(...s), end: at(...e) });

  it("shows 8am to 6pm, stretched for early or late meetings", () => {
    expect(dayRange([ev("a", [10, 0], [11, 0])])).toEqual({ startHour: 8, endHour: 18 });
    expect(dayRange([ev("a", [7, 30], [8, 0]), ev("b", [18, 0], [19, 15])])).toEqual({ startHour: 7, endHour: 20 });
  });

  it("positions events by time and splits overlapping ones into columns", () => {
    const range = { startHour: 8, endHour: 18 };
    const placed = layoutDay(
      [ev("a", [9, 0], [10, 0]), ev("b", [9, 30], [10, 30]), ev("c", [11, 0], [11, 30]), ev("d", [9, 0], [9, 30])],
      range,
    );
    const byId = Object.fromEntries(placed.map((p) => [p.event.id, p]));
    expect(byId.a).toMatchObject({ top: 60, height: 60, columns: 2 });
    expect(byId.b.column).not.toBe(byId.a.column);
    // d ends before b starts, so it can reuse a column.
    expect(byId.d.columns).toBe(2);
    expect(byId.c).toMatchObject({ top: 180, height: 30, column: 0, columns: 1 });
  });

  it("drops hours that are long past", () => {
    const events = [ev("a", [9, 0], [10, 0]), ev("b", [12, 30], [14, 0])];
    const range = dayRange(events, new Date(2026, 9, 29, 13, 15));
    expect(range).toEqual({ startHour: 12, endHour: 18 });
    const placed = layoutDay(events, range);
    // The 9am meeting is gone; the 12:30 one starts 30 minutes down.
    expect(placed.map((p) => [p.event.id, p.top, p.height])).toEqual([["b", 30, 90]]);
  });

  it("clips a meeting that started before the grid", () => {
    const placed = layoutDay([ev("a", [11, 30], [13, 0])], { startHour: 12, endHour: 18 });
    expect(placed[0]).toMatchObject({ top: 0, height: 60 });
  });

  it("places the now line only inside the range", () => {
    const range = { startHour: 8, endHour: 18 };
    expect(nowOffset(new Date(2026, 9, 29, 13, 15), range)).toBe(315);
    expect(nowOffset(new Date(2026, 9, 29, 7, 0), range)).toBeNull();
  });
});

describe("readingContext", () => {
  it("keeps open work, marks today's plan and splits blockers by owner", () => {
    const snapshot = {
      name: "Asset refunds", description: "", status: "at_risk" as const, status_reason: "late codes",
      raci: { role: "accountable" as const, reason: "" }, priority: { level: "P1" as const, reason: "" },
      blockers: [
        { id: "b1", what: "Reason codes", owners: [{ name: "Alex", is_me: false }] },
        { id: "t1", what: "QA decisions", owners: [{ name: "You", is_me: true }] },
      ],
      my_tasks: [{ id: "t1", title: "Confirm QA decisions", assessment: { automation: "human" as const, suggestion: "", needs_details: false, priority: "critical" as const, estimate_minutes: 20 } }],
      active: [{ id: "a1", what: "Partial-refund tickets", owners: [{ name: "ILT team", is_me: false }] }],
      recent_updates: [{ summary: "Dev-complete moved to Nov 17" }],
      summary: "",
    };
    const ctx = readingContext({
      projects: [{ channel_id: "C1", name: "tmp-asset-refunds", hidden: false, local_repos: [], gh_repos: [], last_refreshed_at: null, snapshot, repo_state: null, last_error: null }],
      adhoc: { tasks: [], replies: [{ id: "r1", source: "slack", from: "Kim", summary: "OK to ship?" }], news: [{ id: "n1", headline: "Reorg announced" }], refreshed_at: null },
      manual: [{ id: "m1", title: "Done thing", description: null, project_id: null, created_at: "" }],
      assessments: new Map(),
      states: new Map([["t1", { status: "todo", dismissed: false, todayOn: "2026-10-29", done: false }], ["m1", { status: "done", dismissed: false, todayOn: null, done: true }]]),
      calendar: null,
      today: "2026-10-29",
    });
    expect(ctx.projects[0]).toMatchObject({
      name: "Asset refunds",
      blocked_on_me: ["QA decisions"],
      blocked_on_others: ["Reason codes (Alex)"],
      active_work: ["Partial-refund tickets (ILT team)"],
    });
    expect(ctx.tasks).toEqual([{ id: "t1", title: "Confirm QA decisions", project: "Asset refunds", priority: "blocking", estimate_minutes: 20, due: null, planned_today: true }]);
    expect(ctx.replies_waiting).toEqual(["Kim: OK to ship?"]);

    // A blocker marked resolved after a double check drops out.
    const after = readingContext({
      projects: [{ channel_id: "C1", name: "tmp-asset-refunds", hidden: false, local_repos: [], gh_repos: [], last_refreshed_at: null, snapshot, repo_state: null, last_error: null }],
      adhoc: { tasks: [], replies: [], news: [], refreshed_at: null },
      manual: [],
      assessments: new Map(),
      states: new Map([["blocker:b1", { status: "todo", dismissed: true, todayOn: null, done: false }]]),
      calendar: null,
      today: "2026-10-29",
    });
    expect(after.projects[0].blocked_on_others).toEqual([]);
    expect(ctx.news).toEqual(["Reorg announced"]);
  });
});

describe("reminders", () => {
  it("tags each owner and links the message that raised the blocker", () => {
    const owners = [{ name: "Alex Example", slack_user_id: "U1" }, { name: "Sam", slack_user_id: "U2" }];
    const text = reminderText(owners, "Refund reason codes", "https://slack.com/p1");
    expect(text).toMatch(/^@Alex Example @Sam /);
    expect(text).toContain("*Refund reason codes*");
    expect(text.endsWith("https://slack.com/p1")).toBe(true);
    expect(toSlackMentions(text, owners)).toMatch(/^<@U1> <@U2> quick nudge/);
  });

  it("asks Claude to post the user's text verbatim to the project channel only", () => {
    const prompt = sendReminderPrompt("C0BGJ", "<@U1> any update?\nhttps://slack.com/p1");
    expect(prompt).toContain('channel_id "C0BGJ"');
    expect(prompt).toContain("<<<MESSAGE\n<@U1> any update?\nhttps://slack.com/p1\nMESSAGE>>>");
    expect(prompt).toMatch(/exactly once/);
  });
});

describe("task priority", () => {
  it("makes any task in a P0 project critical", () => {
    expect(taskPriority("low", "P0")).toBe("critical");
    expect(taskPriority(null, "P0")).toBe("critical");
  });

  it("makes a task that's blocking its project 'blocking', above everything", () => {
    expect(taskPriority("low", "P3", true)).toBe("blocking");
    expect(taskPriority("critical", "P0", true)).toBe("blocking");
  });

  it("counts blocking tasks as critical pressure", () => {
    const p = pressure(
      [
        { id: "a", priority: taskPriority("low", "P3", true) },
        { id: "b", priority: taskPriority("low", "P3", false) },
      ],
      new Map(),
      new Date(2026, 9, 29),
    );
    expect(p.criticalTasks).toBe(1);
  });

  it("otherwise keeps Claude's assessment", () => {
    expect(taskPriority("medium", "P1")).toBe("medium");
    expect(taskPriority("high", null)).toBe("high");
    expect(taskPriority(undefined, "P2")).toBeNull();
  });

  it("counts open P0 tasks as critical pressure", () => {
    const p = pressure(
      [
        { id: "a", priority: taskPriority("medium", "P0") },
        { id: "b", priority: taskPriority(null, "P0") },
      ],
      new Map(),
      new Date(2026, 9, 29),
    );
    expect(p.criticalTasks).toBe(2);
  });
});

describe("task filters", () => {
  const t = (status: "todo" | "in_progress" | "waiting" | "done", priority: "critical" | "high" | "medium" | "low" | null, recommended = false) => ({ status, priority, recommended });

  it("lets everything through with no filter", () => {
    expect(matchesFilter(t("done", null), NO_FILTER)).toBe(true);
  });

  it("requires every filter that's set", () => {
    const f: TaskFilter = { ...NO_FILTER, statuses: ["in_progress"], priorities: ["critical"], recommendedOnly: false };
    expect(matchesFilter(t("in_progress", "critical"), f)).toBe(true);
    expect(matchesFilter(t("in_progress", "high"), f)).toBe(false);
    expect(matchesFilter(t("waiting", "critical"), f)).toBe(false);
  });

  it("matches any of several picks within a filter", () => {
    const f: TaskFilter = { ...NO_FILTER, statuses: ["todo", "waiting"], priorities: ["critical", "high"], recommendedOnly: false };
    expect(matchesFilter(t("waiting", "high"), f)).toBe(true);
    expect(matchesFilter(t("todo", "critical"), f)).toBe(true);
    expect(matchesFilter(t("in_progress", "high"), f)).toBe(false);
    expect(matchesFilter(t("todo", "low"), f)).toBe(false);
  });

  it("filters on blocking like any other priority", () => {
    expect(matchesFilter({ status: "todo", priority: "blocking" }, { ...NO_FILTER, priorities: ["blocking"] })).toBe(true);
    expect(matchesFilter({ status: "todo", priority: "critical" }, { ...NO_FILTER, priorities: ["blocking"] })).toBe(false);
  });

  it("filters by where a task came from", () => {
    const f: TaskFilter = { ...NO_FILTER, sources: ["project", "own"] };
    expect(matchesFilter({ ...t("todo", "low"), source: "project" }, f)).toBe(true);
    expect(matchesFilter({ ...t("todo", "low"), source: "request" }, f)).toBe(false);
  });

  it("treats unassessed tasks as unrated, and can require recommended", () => {
    expect(matchesFilter(t("todo", null), { ...NO_FILTER, priorities: ["unrated"] })).toBe(true);
    expect(matchesFilter(t("todo", "low"), { ...NO_FILTER, recommendedOnly: true })).toBe(false);
    expect(matchesFilter(t("todo", "low", true), { ...NO_FILTER, recommendedOnly: true })).toBe(true);
  });
});

describe("project filters", () => {
  const p = { status: "at_risk" as const, priority: "P0" as const, role: "accountable" as const };

  it("requires every filter that's set", () => {
    expect(matchesProjectFilter(p, NO_PROJECT_FILTER)).toBe(true);
    expect(matchesProjectFilter(p, { statuses: ["at_risk"], priorities: ["P0"], roles: ["accountable", "responsible"] })).toBe(true);
    expect(matchesProjectFilter(p, { ...NO_PROJECT_FILTER, roles: ["informed"] })).toBe(false);
    expect(matchesProjectFilter(p, { ...NO_PROJECT_FILTER, priorities: ["P1"] })).toBe(false);
  });
});

describe("open in Claude", () => {
  const task = { title: "Coveo bestseller tweak", description: "Rebalance daily vs weekly.", link: "https://slack.com/p1", projectName: "Search" };
  const plan = {
    approach: "Draft a ticket for Romen.",
    steps: [{ title: "Read CPS-6931", detail: "for the current weights", link: "https://jira/CPS-6931" }, { title: "Draft the ticket", detail: null, link: null }],
    open_questions: ["Cap at top 20 or top 50?"],
    sources: [{ title: "Sep 29 thread", link: "https://slack.com/p2" }],
  };

  it("includes the task and the plan, and asks to start with step 1", () => {
    const p = sessionPrompt(task, plan);
    expect(p).toContain("Task: Coveo bestseller tweak");
    expect(p).toContain("Project: Search");
    expect(p).toContain("1. Read CPS-6931 (for the current weights https://jira/CPS-6931)");
    expect(p).toContain("2. Draft the ticket");
    expect(p).toContain("- Cap at top 20 or top 50?");
    expect(p).toMatch(/starting with step 1/);
  });

  it("keeps the prompt under Claude Desktop's limit", () => {
    expect(sessionPrompt({ title: "x", description: "y".repeat(20000) }, plan).length).toBeLessThanOrEqual(13500);
  });

  it("asks Claude to do only the steps it said it can do alone, then stop", () => {
    const p = startPrompt(task, "Claude can draft the ticket.", [
      { title: "Get the export from Eric", by: "you" },
      { title: "Draft the ticket text", by: "claude" },
      { title: "Check the numbers", by: null },
      { title: "File the ticket", by: "you" },
    ]);
    expect(p).toMatch(/^I've approved your suggested approach/);
    expect(p).toContain("Your suggestion: Claude can draft the ticket.");
    expect(p).toContain("1. [Me] Get the export from Eric\n2. Draft the ticket text\n3. Check the numbers\n4. [Me] File the ticket");
    expect(p).toMatch(/Don't do the steps marked \[Me\]/);
    expect(p).toMatch(/stop and ask me for that step's result/);
    expect(p).toMatch(/wait for my OK before posting/);
    expect(p).toMatch(/Don't send email, file tickets/);
  });


  it("builds a claude://code/new link that decodes back to the prompt and folder", () => {
    const url = claudeSessionUrl("Fix the test & ship it", "/Users/me/repo");
    expect(url.startsWith("claude://code/new?")).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("q")).toBe("Fix the test & ship it");
    expect(params.get("folder")).toBe("/Users/me/repo");
    expect(url).not.toContain("+");
  });
});

describe("manual priority", () => {
  it("beats Claude's rating and P0, but never Blocking", () => {
    expect(taskPriority("low", null, false, "critical")).toBe("critical");
    expect(taskPriority("high", "P0", false, "low")).toBe("low");
    expect(taskPriority("high", "P0", true, "low")).toBe("blocking");
    expect(taskPriority("high", "P0", false, undefined)).toBe("critical");
  });
});

describe("slack channel links", () => {
  it("uses the workspace domain from a permalink, so Enterprise Grid resolves it", async () => {
    const { slackChannelUrl } = await import("./projects");
    expect(slackChannelUrl("C123", [null, "https://unity.slack.com/archives/C123/p1700000000000100"])).toBe("https://unity.slack.com/archives/C123");
    expect(slackChannelUrl("C123")).toBe("https://slack.com/app_redirect?channel=C123");
  });
});

describe("slack threads", () => {
  it("finds the channel and thread a permalink points at", async () => {
    const { slackThread } = await import("./projects");
    expect(slackThread("https://unity.slack.com/archives/D0ABC/p1700000000000100")).toEqual({ channelId: "D0ABC", threadTs: "1700000000.000100" });
    expect(slackThread("https://unity.slack.com/archives/C1/p1700000000000100?thread_ts=1699999999.000200&cid=C1")).toEqual({
      channelId: "C1",
      threadTs: "1699999999.000200",
    });
    expect(slackThread("https://mail.google.com/mail/u/0/#all/abc")).toBeNull();
  });

  it("asks for exactly one threaded post, verbatim", async () => {
    const { sendReplyPrompt } = await import("./prompts");
    const p = sendReplyPrompt("C1", "1700000000.000100", "Sounds good, shipping Friday.");
    expect(p).toContain('thread_ts "1700000000.000100"');
    expect(p).toContain("exactly once");
    expect(p).toContain("Sounds good, shipping Friday.");
  });
});

describe("blocker status check", () => {
  it("starts from the reminder when one was sent", async () => {
    const { checkBlockerPrompt } = await import("./prompts");
    const blocker = { id: "b1", what: "Refund codes", owners: [], since: null, link: null };
    const withReminder = checkBlockerPrompt({ projectName: "Refunds", channelId: "C1", blocker, userId: null, reminder: { at: "2026-10-29T10:00:00Z", link: "https://unity.slack.com/archives/C1/p1" } });
    expect(withReminder).toContain("posted a reminder about it on 2026-10-29T10:00:00Z (https://unity.slack.com/archives/C1/p1)");
    expect(checkBlockerPrompt({ projectName: "Refunds", channelId: "C1", blocker, userId: null })).not.toContain("reminder");
  });
});
