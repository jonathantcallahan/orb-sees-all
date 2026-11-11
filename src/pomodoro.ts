/**
 * The pomodoro timer, turned on in Settings: it sits above the calendar, and its current block is
 * drawn on the calendar too.
 *
 * A series is four focus sessions, each followed by a break, and repeats until you turn it off. The timer
 * is a clock rather than a countdown: it keeps when the series started and how long it's been
 * paused, and works out where in the series it is from the time now. So it carries on across reloads
 * and relaunches without anything ticking in the background, and goes from block to block on its own.
 *
 * Kept in localStorage, like the theme and the orb's look, so it shows from the first frame.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

export type PomodoroPhase = "focus" | "break";

/** How many focus sessions a series has (the timer's square has a quarter for each). */
export const SESSIONS = 4;

/** The blocks of one series, in order: a focus session, then a break, four times. Then it starts over. */
export const SERIES: PomodoroPhase[] = Array.from({ length: SESSIONS }, () => ["focus", "break"] as PomodoroPhase[]).flat();

export interface PomodoroSettings {
  on: boolean;
  /** How long each focus session lasts, in minutes. */
  focusMin: number;
  /** How long each break lasts, in minutes. */
  breakMin: number;
}

export const POMODORO_DEFAULTS: PomodoroSettings = { on: false, focusMin: 25, breakMin: 5 };

/** The longest a session or break can be set to, in minutes. */
export const POMODORO_MAX_MIN = 180;

/** Where the series is in time: when it started, and its pauses (in ms since the epoch). */
export interface PomodoroClock {
  startedAt: number;
  /** When it was paused, while it is. */
  pausedAt: number | null;
  /** Everything it's been paused before the current pause, in ms. */
  pausedMs: number;
  /**
   * The recent pauses before the current one, [from, to], oldest first: so a block's start stays
   * where it was on the calendar after a pause in it. (Older ones are folded into startedAt.)
   */
  pauses?: [number, number][];
}

/** The most pauses kept apart; older ones are long before the current block. */
const PAUSES_KEPT = 40;

/** The timer at a moment. */
export interface PomodoroNow {
  /** Which block of the series (see SERIES) is running. */
  index: number;
  /** Which focus session of the series it is, from 0: during a break, the one just done. */
  session: number;
  phase: PomodoroPhase;
  /** How long the block is, and how much of it is left, in ms. */
  lengthMs: number;
  remainingMs: number;
  paused: boolean;
  /** When the block began, and when it will end if it isn't paused again (ms since the epoch). */
  start: number;
  end: number;
}

const phaseMs = (phase: PomodoroPhase, s: PomodoroSettings) => (phase === "focus" ? s.focusMin : s.breakMin) * 60_000;

/** Where the series is at `now`. */
export function pomodoroAt(clock: PomodoroClock, settings: PomodoroSettings, now: number): PomodoroNow {
  const at = clock.pausedAt ?? now;
  const cycle = SERIES.reduce((sum, p) => sum + phaseMs(p, settings), 0);
  let into = Math.max(0, at - clock.startedAt - clock.pausedMs) % cycle;
  let index = 0;
  while (into >= phaseMs(SERIES[index], settings)) {
    into -= phaseMs(SERIES[index], settings);
    index++;
  }
  const phase = SERIES[index];
  const lengthMs = phaseMs(phase, settings);
  const remainingMs = lengthMs - into;
  const running = Math.max(0, at - clock.startedAt - clock.pausedMs);
  const session = SERIES.slice(0, index + 1).filter((p) => p === "focus").length - 1;
  return { index, session, phase, lengthMs, remainingMs, paused: clock.pausedAt !== null, start: wallTime(clock, running - into), end: now + remainingMs };
}

/**
 * The moment the series had run for \`runningMs\` (paused time not counted): its start, plus every
 * pause that began before then. Pauses older than those kept are already in startedAt.
 */
function wallTime(clock: PomodoroClock, runningMs: number): number {
  const kept = clock.pauses ?? [];
  // Those folded into startedAt, which were all before any of the kept ones.
  const folded = clock.pausedMs - kept.reduce((sum, [from, to]) => sum + (to - from), 0);
  let t = clock.startedAt + folded + runningMs;
  for (const [from, to] of kept) {
    if (from > t) break;
    t += to - from;
  }
  return t;
}

export const startClock = (now: number): PomodoroClock => ({ startedAt: now, pausedAt: null, pausedMs: 0 });

export const pauseClock = (c: PomodoroClock, now: number): PomodoroClock => (c.pausedAt === null ? { ...c, pausedAt: now } : c);

export const resumeClock = (c: PomodoroClock, now: number): PomodoroClock =>
  c.pausedAt === null
    ? c
    : { ...c, pausedAt: null, pausedMs: c.pausedMs + (now - c.pausedAt), pauses: [...(c.pauses ?? []), [c.pausedAt, now] as [number, number]].slice(-PAUSES_KEPT) };

/** Time left as "24:59", or "1:04:59" past an hour. A block's last second reads 0:01, never 0:00. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A length typed in Settings, as whole minutes within range. */
export function clampMinutes(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(POMODORO_MAX_MIN, Math.max(1, Math.round(value))) : fallback;
}

// ---- stored, and shared by Settings and the timer

const SETTINGS_KEY = "pomodoro";
// A new key since breaks come after every session: a clock kept for the old order (three sessions,
// then a break) would land part way into some other block, so it starts a fresh series instead.
const CLOCK_KEY = "pomodoro-clock-2";
const OLD_CLOCK_KEY = "pomodoro-clock";

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function load(): { settings: PomodoroSettings; clock: PomodoroClock | null } {
  localStorage.removeItem(OLD_CLOCK_KEY);
  const stored = read<Partial<PomodoroSettings>>(SETTINGS_KEY) ?? {};
  const settings: PomodoroSettings = {
    on: stored.on === true,
    focusMin: clampMinutes(Number(stored.focusMin), POMODORO_DEFAULTS.focusMin),
    breakMin: clampMinutes(Number(stored.breakMin), POMODORO_DEFAULTS.breakMin),
  };
  let clock = settings.on ? read<PomodoroClock>(CLOCK_KEY) : null;
  if (settings.on && !clock) {
    clock = startClock(Date.now());
    localStorage.setItem(CLOCK_KEY, JSON.stringify(clock));
  }
  return { settings, clock };
}

let state: { settings: PomodoroSettings; clock: PomodoroClock | null } | null = null;
const listeners = new Set<() => void>();

function current() {
  return (state ??= load());
}

function save(next: { settings: PomodoroSettings; clock: PomodoroClock | null }) {
  state = next;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next.settings));
  if (next.clock) localStorage.setItem(CLOCK_KEY, JSON.stringify(next.clock));
  else localStorage.removeItem(CLOCK_KEY);
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Changes the settings. Turning the timer on starts a series; turning it off stops it; a new
 * length starts a fresh series, since the old position wouldn't mean anything at the new lengths.
 */
export function setPomodoroSettings(change: Partial<PomodoroSettings>) {
  const { settings, clock } = current();
  const next = { ...settings, ...change };
  const lengthsChanged = next.focusMin !== settings.focusMin || next.breakMin !== settings.breakMin;
  save({ settings: next, clock: !next.on ? null : !clock || lengthsChanged ? startClock(Date.now()) : clock });
}

/** Pauses the timer, or carries on from where it was paused. */
export function togglePomodoroPause() {
  const { settings, clock } = current();
  if (!clock) return;
  const now = Date.now();
  save({ settings, clock: clock.pausedAt === null ? pauseClock(clock, now) : resumeClock(clock, now) });
}

/** Starts the series over from its first focus session. */
export function restartPomodoro() {
  const { settings } = current();
  if (settings.on) save({ settings, clock: startClock(Date.now()) });
}

export function usePomodoroSettings(): PomodoroSettings {
  return useSyncExternalStore(subscribe, () => current().settings);
}

/** The timer now, updated every second while it's on; null while it's off. */
export function usePomodoro(): PomodoroNow | null {
  const { settings, clock } = useSyncExternalStore(subscribe, current);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!clock) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [clock]);
  return clock ? pomodoroAt(clock, settings, Math.max(now, clock.startedAt)) : null;
}
