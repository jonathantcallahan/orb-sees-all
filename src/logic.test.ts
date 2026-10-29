import { describe, expect, it } from "vitest";
import { JobQueue } from "./jobs/queue";
import { windowStart } from "./prompts";
import { shouldRunMorning } from "./scheduler";
import { applyTaskState, compareProjects, DEFAULT_TASK_STATE, formatMinutes, pressure, splitToday, type TaskState } from "./tasks";

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
  it("puts blocked, then at risk, then the rest", () => {
    const list = [
      { name: "z", status: "on_track" as const },
      { name: "y", status: null },
      { name: "x", status: "at_risk" as const },
      { name: "w", status: "blocked" as const },
    ];
    expect(list.sort(compareProjects).map((p) => p.name)).toEqual(["w", "x", "z", "y"]);
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

  it("is calm with nothing on the user", () => {
    expect(pressure([{ status: "on_track", tasks: [] }], [], none, now).level).toBe(0);
  });

  it("counts tasks in blocked or at-risk projects and tasks due soon as critical", () => {
    const p = pressure(
      [
        { status: "blocked", tasks: [{ id: "a" }, { id: "b" }] },
        { status: "on_track", tasks: [{ id: "c", due: "2026-10-30" }, { id: "d", due: "2026-12-01" }] },
      ],
      [{ id: "e", due: "2026-10-28" }, { id: "f" }],
      none,
      now,
    );
    expect(p).toMatchObject({ projectsOnMe: 2, criticalTasks: 4 });
    expect(p.level).toBeCloseTo(0.5 * (2 / 6) + 0.5 * (4 / 8));
  });

  it("ignores done and dismissed tasks", () => {
    const states = new Map([
      ["a", st({ done: true, dismissed: false })],
      ["b", st({ done: false, dismissed: true })],
    ]);
    const p = pressure([{ status: "blocked", tasks: [{ id: "a" }, { id: "b" }] }], [], states, now);
    expect(p).toMatchObject({ projectsOnMe: 0, criticalTasks: 0, level: 0 });
  });

  it("saturates at 1", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ status: "blocked" as const, tasks: [{ id: `t${i}` }] }));
    expect(pressure(many, [], none, now).level).toBe(1);
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
