import type { SelfDmPoll } from "./schema";
import { localDate } from "./scheduler";

/**
 * Instructions from the user's own Slack DM. They use it as a scratchpad, so only a message they
 * tagged #demian is for Demian; it checks the DM every few minutes and reads only what's new since
 * the last check. A tagged message can ask for anything the global chat can do (see GlobalAction).
 */
export const SELF_DM_TAG = /#demian\b/i;

/** How often to check, in seconds, or off. */
export type SelfDmEvery = "300" | "off";
export const SELF_DM_DEFAULT: SelfDmEvery = "off";

/** The saved setting: unset is the default, and any other "on" value (there was an every-30-seconds option) is every 5 minutes. */
export function selfDmEvery(saved: string | null): SelfDmEvery {
  return saved == null ? SELF_DM_DEFAULT : saved === "off" ? "off" : "300";
}
/** On the first check, how far back to look for tagged messages. */
const FIRST_LOOK_BACK_S = 24 * 60 * 60;
/** Message timestamps already taken, kept so a message is never added twice. */
const SEEN_KEPT = 200;

export interface SelfDmState {
  /** The newest message ts seen; the next check reads only messages after it. */
  cursor: string | null;
  seen: string[];
  /** The last check's error, so a connector that's down is logged once, not every check. */
  lastError: string | null;
  /** Today's checks (by local date) and what they cost, shown in Settings. */
  day: string | null;
  runs: number;
  usd: number;
  /** Checks in a row that read #demian messages but couldn't work out what they ask (see SELF_DM_TRIES). */
  tries: number;
}

/** After this many failed tries at the same messages, they're skipped, so one Demian can't read isn't retried forever. */
export const SELF_DM_TRIES = 3;

export const emptySelfDmState = (): SelfDmState => ({ cursor: null, seen: [], lastError: null, day: null, runs: 0, usd: 0, tries: 0 });

export function parseSelfDmState(raw: string | null): SelfDmState {
  try {
    return { ...emptySelfDmState(), ...JSON.parse(raw ?? "{}") };
  } catch {
    return emptySelfDmState();
  }
}

/** Where the next read starts: after the cursor, or a day back on the very first check. */
export function selfDmOldest(state: SelfDmState, now: Date): string {
  return state.cursor ?? (Math.floor(now.getTime() / 1000) - FIRST_LOOK_BACK_S).toFixed(6);
}

/** A Slack ts ("1730000000.123456") as a number, or null when it isn't one or is in the future. */
const tsValue = (ts: string | null | undefined, now: Date) => {
  if (!ts || !/^\d{9,11}(\.\d+)?$/.test(ts)) return null;
  const v = Number(ts);
  return v <= now.getTime() / 1000 + 60 ? v : null;
};

/**
 * What one check found: the messages to act on, kept only when the message really carries the tag,
 * is newer than where the check started and hasn't been taken before; and the state to save once
 * they've been acted on.
 */
export function takeFromPoll(state: SelfDmState, poll: SelfDmPoll, oldest: string, now: Date, costUsd = 0) {
  const from = Number(oldest);
  const seen = new Set(state.seen);
  const messages = poll.messages.filter((m) => {
    const v = tsValue(m.ts, now);
    return v != null && v > from && !seen.has(m.ts) && SELF_DM_TAG.test(m.text) && m.text.replace(SELF_DM_TAG, "").trim() !== "";
  });
  let cursor = tsValue(state.cursor, now) ?? null;
  for (const ts of [poll.latest_ts, ...messages.map((m) => m.ts)]) {
    const v = tsValue(ts, now);
    if (v != null && (cursor == null || v > cursor)) cursor = v;
  }
  const day = localDate(now);
  const sameDay = state.day === day;
  const next: SelfDmState = {
    // Kept as Slack wrote it, so the next read's `oldest` is exact. With nothing read, the next check
    // starts where this one did, so it doesn't keep looking back a day.
    cursor: cursor == null ? (state.cursor ?? oldest) : [poll.latest_ts, ...messages.map((m) => m.ts), state.cursor].find((ts) => tsValue(ts, now) === cursor) ?? state.cursor,
    seen: [...state.seen, ...messages.map((m) => m.ts)].slice(-SEEN_KEPT),
    lastError: null,
    day,
    runs: (sameDay ? state.runs : 0) + 1,
    usd: (sameDay ? state.usd : 0) + costUsd,
    tries: 0,
  };
  return { messages, state: next };
}

/** What happened to one #demian message: each change, applied or not, in a line; or the question it raised. */
export interface SelfDmOutcome {
  ts: string;
  changes: { ok: boolean; line: string }[];
  question: string | null;
}

/**
 * The reaction and thread reply for each message: ✅ and a line per change when anything was
 * applied (with any that failed); ❓ and the question, or what failed, when nothing was.
 */
export function selfDmReplies(outcomes: SelfDmOutcome[]): { ts: string; emoji: string; text: string }[] {
  return outcomes.map((o) => {
    const applied = o.changes.some((c) => c.ok);
    // An added task's id is for the chat's later changes; in Slack it's noise.
    const text = applied || !o.question ? o.changes.map((c) => c.line.replace(/ \(id [^)]+\)/, "")).join("\n") : o.question;
    return {
      ts: o.ts,
      emoji: applied ? "white_check_mark" : "question",
      text: text || "I couldn't tell what to do with this one. Could you say it another way?",
    };
  });
}
