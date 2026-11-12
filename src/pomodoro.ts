/**
 * The pomodoro timer, turned on in Settings: it sits above the calendar, and its current block is
 * drawn on the calendar too.
 *
 * A series is four focus sessions, each followed by a break, and repeats until you turn it off. The timer
 * is a clock rather than a countdown: it keeps when the series started and how long it's been
 * paused, and works out where in the series it is from the time now. So it carries on across reloads
 * and relaunches without anything ticking in the background, and goes from block to block on its own.
 *
 * It can be stopped from its menu (it reads 00:00 and its current block leaves the calendar, until
 * started again), and holds the task you're focusing on: one dragged into Today's "Active pomodoro
 * task". The focus time done today stays on the calendar whatever happens to the series: Stop,
 * either restart or new lengths keep what was done before starting over.
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
   * The recent pauses before the current one, [from, to], oldest first: so a finished block's end
   * is placed where it really was on the calendar. (Older ones are folded into startedAt.)
   */
  pauses?: [number, number][];
  /**
   * When this clock began, for real: Restart timer backdates startedAt so the series carries on from
   * the block it restarted, and the blocks before that didn't happen at the times it implies.
   */
  since?: number;
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
  /**
   * When it will end if it isn't paused again, and when it began as the calendar shows it: its
   * full length before its end, so a pause moves its start later rather than stretching it.
   */
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
  const session = SERIES.slice(0, index + 1).filter((p) => p === "focus").length - 1;
  const end = now + remainingMs;
  return { index, session, phase, lengthMs, remainingMs, paused: clock.pausedAt !== null, start: end - lengthMs, end };
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
    // A pause from the very moment a session ends belongs after it, not inside it.
    if (from >= t) break;
    t += to - from;
  }
  return t;
}

export const startClock = (now: number): PomodoroClock => ({ startedAt: now, pausedAt: null, pausedMs: 0, since: now });

/**
 * The focus sessions the clock has run up to \`now\`, as [from, to] (ms since the epoch), oldest
 * first: those finished, and with \`current\` the part done of the one it's in. Each as long as the
 * focus it held, ending where it ended (or was set aside): a pause in it moves its start later, as
 * on the calendar, rather than stretching it. Only what's happened since the clock began (see
 * since), in the last day.
 */
export function focusDone(clock: PomodoroClock, settings: PomodoroSettings, now: number, current = false): [number, number][] {
  const at = clock.pausedAt ?? now;
  const running = Math.max(0, at - clock.startedAt - clock.pausedMs);
  const since = Math.max(clock.since ?? clock.startedAt, now - 86_400_000);
  const cycle = SERIES.reduce((sum, p) => sum + phaseMs(p, settings), 0);
  const out: [number, number][] = [];
  // From the first whole series in the last day: anything before is older than the calendar shows.
  let t = Math.max(0, Math.floor((running - 86_400_000) / cycle)) * cycle;
  for (let i = 0; t < running; i = (i + 1) % SERIES.length) {
    const length = phaseMs(SERIES[i], settings);
    const finished = t + length <= running;
    if (SERIES[i] === "focus" && (finished || current)) {
      const to = finished ? wallTime(clock, t + length) : at;
      const from = Math.max(to - (finished ? length : running - t), since);
      if (to > from) out.push([from, to]);
    }
    t += length;
  }
  return out;
}

/**
 * The clock with the block it's in started over from its full length, now, running: earlier blocks
 * of the series count as done, so the next ones follow on from it as before.
 */
export function restartBlockClock(clock: PomodoroClock, settings: PomodoroSettings, now: number): PomodoroClock {
  const { index } = pomodoroAt(clock, settings, now);
  const before = SERIES.slice(0, index).reduce((sum, p) => sum + phaseMs(p, settings), 0);
  return { ...startClock(now - before), since: now };
}

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
/** Set while it's on but stopped from its menu. */
const STOPPED_KEY = "pomodoro-stopped";
/** The id of the task you're focusing on. */
const TASK_KEY = "pomodoro-task";
/** Today's focus time from series since set aside (stopped, restarted), so it stays on the calendar. */
const DONE_KEY = "pomodoro-done";

interface Stored {
  settings: PomodoroSettings;
  /** The series running, or null: off in Settings, or on but stopped. */
  clock: PomodoroClock | null;
  task: string | null;
  /** Focus time done today in series set aside, [from, to]. */
  done: [number, number][];
}

/** Midnight this morning, local time. */
const startOfToday = () => new Date().setHours(0, 0, 0, 0);

/** Only what's today. */
const today = (blocks: [number, number][]) => blocks.filter(([, to]) => to > startOfToday());

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function load(): Stored {
  localStorage.removeItem(OLD_CLOCK_KEY);
  const stored = read<Partial<PomodoroSettings>>(SETTINGS_KEY) ?? {};
  const settings: PomodoroSettings = {
    on: stored.on === true,
    focusMin: clampMinutes(Number(stored.focusMin), POMODORO_DEFAULTS.focusMin),
    breakMin: clampMinutes(Number(stored.breakMin), POMODORO_DEFAULTS.breakMin),
  };
  const stopped = localStorage.getItem(STOPPED_KEY) === "1";
  let clock = settings.on && !stopped ? read<PomodoroClock>(CLOCK_KEY) : null;
  if (settings.on && !stopped && !clock) {
    clock = startClock(Date.now());
    localStorage.setItem(CLOCK_KEY, JSON.stringify(clock));
  }
  return { settings, clock, task: settings.on ? localStorage.getItem(TASK_KEY) : null, done: today(read<[number, number][]>(DONE_KEY) ?? []) };
}

let state: Stored | null = null;
const listeners = new Set<() => void>();

function current() {
  return (state ??= load());
}

function save(next: Stored) {
  state = next;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next.settings));
  if (next.clock) localStorage.setItem(CLOCK_KEY, JSON.stringify(next.clock));
  else localStorage.removeItem(CLOCK_KEY);
  if (next.settings.on && !next.clock) localStorage.setItem(STOPPED_KEY, "1");
  else localStorage.removeItem(STOPPED_KEY);
  if (next.task) localStorage.setItem(TASK_KEY, next.task);
  else localStorage.removeItem(TASK_KEY);
  localStorage.setItem(DONE_KEY, JSON.stringify(next.done));
  for (const l of listeners) l();
}

/** Pieces of focus shorter than this aren't kept when a series is set aside: a Stop or Restart just after starting leaves no sliver on the calendar. */
const MIN_KEPT_MS = 60_000;

/**
 * Today's focus time, with the series now running set aside: before it's stopped or replaced. The
 * part of the session it's in that's already done is kept, unless it's under a minute.
 */
function setAside(s: Stored, now: number): [number, number][] {
  const running = s.clock ? focusDone(s.clock, s.settings, now, true).filter(([from, to]) => to - from >= MIN_KEPT_MS) : [];
  return today([...s.done, ...running]);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Changes the settings. Turning the timer on starts a series; turning it off stops it; a new
 * length starts a fresh series, since the old position wouldn't mean anything at the new lengths
 * (stopped, it stays stopped).
 */
export function setPomodoroSettings(change: Partial<PomodoroSettings>) {
  const s = current();
  const { settings, clock } = s;
  const next = { ...settings, ...change };
  const lengthsChanged = next.focusMin !== settings.focusMin || next.breakMin !== settings.breakMin;
  const now = Date.now();
  const nextClock = !next.on ? null : !settings.on || (clock && lengthsChanged) ? startClock(now) : clock;
  save({ settings: next, clock: nextClock, task: next.on ? s.task : null, done: nextClock === clock ? s.done : setAside(s, now) });
}

/** Pauses the timer, or carries on from where it was paused. */
export function togglePomodoroPause() {
  const s = current();
  if (!s.clock) return;
  const now = Date.now();
  save({ ...s, clock: s.clock.pausedAt === null ? pauseClock(s.clock, now) : resumeClock(s.clock, now) });
}

/** Starts the series over from its first focus session (or starts one, when stopped). */
export function restartPomodoro() {
  const s = current();
  const now = Date.now();
  if (s.settings.on) save({ ...s, clock: startClock(now), done: setAside(s, now) });
}

/** Starts the block it's in over from its full length, running; stopped, starts a series. */
export function restartPomodoroBlock() {
  const s = current();
  if (!s.settings.on) return;
  const now = Date.now();
  save({ ...s, clock: s.clock ? restartBlockClock(s.clock, s.settings, now) : startClock(now), done: setAside(s, now) });
}

/**
 * Stops the timer: it reads 00:00 and its block leaves the calendar, until started again. The
 * focus session is over, so its task goes back to Today's tasks.
 */
export function stopPomodoro() {
  const s = current();
  if (s.settings.on) save({ ...s, clock: null, task: null, done: setAside(s, Date.now()) });
}

/** Sets the task you're focusing on (null for none). */
export function setPomodoroTask(id: string | null) {
  const s = current();
  if (s.task !== id) save({ ...s, task: id });
}

/** On but stopped from its menu. */
export function usePomodoroStopped(): boolean {
  return useSyncExternalStore(subscribe, () => current().settings.on && !current().clock);
}

/** The id of the task you're focusing on while a series runs (running or paused), else null. */
export function usePomodoroTask(): string | null {
  return useSyncExternalStore(subscribe, () => (current().clock ? current().task : null));
}

/**
 * Focus sessions finished today, for the calendar: those of series set aside and those the running
 * one has finished (the one it's in is drawn as the current block). Kept up to date each second
 * while a series runs.
 */
export function usePomodoroFocusDone(): [number, number][] {
  const s = useSyncExternalStore(subscribe, current);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // From now, not from when the last series' ticking stopped.
    setNow(Date.now());
    if (!s.clock) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [s.clock]);
  return today([...s.done, ...(s.clock ? focusDone(s.clock, s.settings, Math.max(now, s.clock.startedAt)) : [])]);
}

/** A series is running or paused (on, and not stopped). Changes only when that does, not every second. */
export function usePomodoroActive(): boolean {
  return useSyncExternalStore(subscribe, () => current().clock !== null);
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
