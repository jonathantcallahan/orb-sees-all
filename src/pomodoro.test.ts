import { describe, expect, it, vi } from "vitest";
import { clampMinutes, focusDone, formatRemaining, pauseClock, pomodoroAt, restartBlockClock, resumeClock, startClock } from "./pomodoro";

const settings = { on: true, focusMin: 25, breakMin: 5 };
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 15, 0);

describe("the pomodoro timer", () => {
  it("takes a break after every focus session, four times, then starts over", () => {
    const clock = startClock(T0);
    const at = (min: number) => pomodoroAt(clock, settings, T0 + min * MIN);
    expect([0, 25, 30, 55, 60, 85, 90, 115, 120].map((m) => [at(m).session, at(m).phase])).toEqual([
      [0, "focus"],
      [0, "break"],
      [1, "focus"],
      [1, "break"],
      [2, "focus"],
      [2, "break"],
      [3, "focus"],
      [3, "break"],
      [0, "focus"],
    ]);
    expect(at(10)).toMatchObject({ index: 0, lengthMs: 25 * MIN, remainingMs: 15 * MIN });
    expect(at(27)).toMatchObject({ index: 1, lengthMs: 5 * MIN, remainingMs: 3 * MIN });
  });

  it("knows when the current block began and when it ends", () => {
    const now = pomodoroAt(startClock(T0), settings, T0 + 40 * MIN);
    expect(now.start).toBe(T0 + 30 * MIN);
    expect(now.end).toBe(T0 + 55 * MIN);
  });

  it("stands still while paused, and carries on from there", () => {
    const paused = pauseClock(startClock(T0), T0 + 10 * MIN);
    const during = pomodoroAt(paused, settings, T0 + 40 * MIN);
    expect(during.paused).toBe(true);
    expect(during.remainingMs).toBe(15 * MIN);
    // The block is drawn ending 15 minutes from now, however long the pause.
    expect(during.end).toBe(T0 + 55 * MIN);
    const resumed = resumeClock(paused, T0 + 40 * MIN);
    expect(pomodoroAt(resumed, settings, T0 + 45 * MIN)).toMatchObject({ index: 0, remainingMs: 10 * MIN, paused: false });
  });

  it("moves a block's start later by a pause in it, rather than stretching it, and the next block follows it", () => {
    // Paused 10 minutes into the first session for 20 minutes, then carried on.
    const clock = resumeClock(pauseClock(startClock(T0), T0 + 10 * MIN), T0 + 30 * MIN);
    expect(pomodoroAt(clock, settings, T0 + 35 * MIN)).toMatchObject({ index: 0, start: T0 + 20 * MIN, end: T0 + 45 * MIN });
    // The break starts when the first session ended, pause and all.
    expect(pomodoroAt(clock, settings, T0 + 47 * MIN)).toMatchObject({ index: 1, phase: "break", start: T0 + 45 * MIN, end: T0 + 50 * MIN });
    // Paused again in the break: its start moves on by that pause too.
    const again = resumeClock(pauseClock(clock, T0 + 47 * MIN), T0 + 49 * MIN);
    expect(pomodoroAt(again, settings, T0 + 50 * MIN)).toMatchObject({ index: 1, start: T0 + 47 * MIN, end: T0 + 52 * MIN });
  });

  it("restarts the block it's in from its full length, and carries on through the series from there", () => {
    // 10 minutes into the second focus session.
    const now = T0 + 40 * MIN;
    const restarted = restartBlockClock(startClock(T0), settings, now);
    expect(pomodoroAt(restarted, settings, now)).toMatchObject({ index: 2, session: 1, phase: "focus", remainingMs: 25 * MIN, start: now, end: now + 25 * MIN });
    // Its break follows when it ends.
    expect(pomodoroAt(restarted, settings, now + 26 * MIN)).toMatchObject({ index: 3, phase: "break", remainingMs: 4 * MIN });
  });

  it("restarts a paused block running, from its full length", () => {
    const paused = pauseClock(startClock(T0), T0 + 27 * MIN);
    const now = T0 + 60 * MIN;
    expect(pomodoroAt(restartBlockClock(paused, settings, now), settings, now)).toMatchObject({ index: 1, phase: "break", remainingMs: 5 * MIN, paused: false });
  });

  it("knows the focus sessions it has run, finished or (asked) the part done of the current one", () => {
    const clock = startClock(T0);
    // 10 minutes into the second session.
    const now = T0 + 40 * MIN;
    expect(focusDone(clock, settings, now)).toEqual([[T0, T0 + 25 * MIN]]);
    expect(focusDone(clock, settings, now, true)).toEqual([
      [T0, T0 + 25 * MIN],
      [T0 + 30 * MIN, now],
    ]);
    // In a break, the session before it is finished, and there's no current focus to add.
    expect(focusDone(clock, settings, T0 + 27 * MIN, true)).toEqual([[T0, T0 + 25 * MIN]]);
  });

  it("draws a session paused part way as long as its focus, ending where it ended", () => {
    const clock = resumeClock(pauseClock(startClock(T0), T0 + 10 * MIN), T0 + 30 * MIN);
    expect(focusDone(clock, settings, T0 + 50 * MIN)).toEqual([[T0 + 20 * MIN, T0 + 45 * MIN]]);
    // Set aside while paused in it: the 10 minutes done, ending at the pause.
    const paused = pauseClock(startClock(T0), T0 + 10 * MIN);
    expect(focusDone(paused, settings, T0 + 20 * MIN, true)).toEqual([[T0, T0 + 10 * MIN]]);
  });

  it("leaves out the times a restarted block's clock only implies", () => {
    // Restarted 10 minutes into the second session: the first session isn't this clock's to show.
    const now = T0 + 40 * MIN;
    const restarted = restartBlockClock(startClock(T0), settings, now);
    expect(focusDone(restarted, settings, now + 5 * MIN, true)).toEqual([[now, now + 5 * MIN]]);
  });

  it("reads its time left as minutes and seconds", () => {
    expect(formatRemaining(25 * MIN)).toBe("25:00");
    expect(formatRemaining(61_500)).toBe("1:02");
    expect(formatRemaining(400)).toBe("0:01");
    expect(formatRemaining(90 * MIN)).toBe("1:30:00");
  });

  it("keeps lengths typed in Settings to whole minutes in range", () => {
    expect(clampMinutes(0, 25)).toBe(1);
    expect(clampMinutes(12.4, 25)).toBe(12);
    expect(clampMinutes(999, 25)).toBe(180);
    expect(clampMinutes(Number("abc"), 25)).toBe(25);
  });
});

describe("stopping the timer", () => {
  it("keeps the focus done before a Stop, but leaves no sliver from one just after starting", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    vi.useFakeTimers();
    try {
      const noon = new Date(2026, 10, 10, 12).getTime();
      vi.setSystemTime(noon);
      vi.resetModules();
      const p = await import("./pomodoro");
      p.setPomodoroSettings({ on: true, focusMin: 25, breakMin: 5 });
      vi.setSystemTime(noon + 20_000);
      p.stopPomodoro();
      expect(JSON.parse(store.get("pomodoro-done")!)).toEqual([]);
      p.restartPomodoro();
      vi.setSystemTime(noon + 20_000 + 10 * MIN);
      p.stopPomodoro();
      expect(JSON.parse(store.get("pomodoro-done")!)).toEqual([[noon + 20_000, noon + 20_000 + 10 * MIN]]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
