import { describe, expect, it } from "vitest";
import { clampMinutes, formatRemaining, pauseClock, pomodoroAt, resumeClock, startClock } from "./pomodoro";

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

  it("keeps a block's start where it was across a pause in it, and the next block's after it", () => {
    // Paused 10 minutes into the first session for 20 minutes, then carried on.
    const clock = resumeClock(pauseClock(startClock(T0), T0 + 10 * MIN), T0 + 30 * MIN);
    expect(pomodoroAt(clock, settings, T0 + 35 * MIN)).toMatchObject({ index: 0, start: T0, end: T0 + 45 * MIN });
    // The break starts when the first session ended, pause and all.
    expect(pomodoroAt(clock, settings, T0 + 47 * MIN)).toMatchObject({ index: 1, phase: "break", start: T0 + 45 * MIN, end: T0 + 50 * MIN });
    // Paused again in the break: its start doesn't move either.
    const again = resumeClock(pauseClock(clock, T0 + 47 * MIN), T0 + 49 * MIN);
    expect(pomodoroAt(again, settings, T0 + 50 * MIN)).toMatchObject({ index: 1, start: T0 + 45 * MIN, end: T0 + 52 * MIN });
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
