import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import * as db from "./db";
import { sessionMarker } from "./openInClaude";

/** A task's link to the Claude Code session Orb opened for it. */
export interface SessionLink {
  /** When the session was opened (ms); its transcript is newer than this. */
  startedAt: number;
  /** The transcript, once found. */
  path?: string;
  sessionId?: string;
}

export type StepState = "started" | "done" | "waiting";

export interface StepProgress {
  state: StepState;
  /** For "waiting": what the session needs from the user. */
  note?: string;
}

export interface SessionProgress {
  /** Progress by step number (1-based), latest report per step. */
  steps: Record<number, StepProgress>;
  /** When the transcript last changed (ms). */
  updatedAt: number | null;
  found: boolean;
}

const LINE = /^\[orb\]\s*step\s+(\d+)\s+(started|done|waiting)\b\s*:?\s*(.*)$/i;

/** Turns the session's "[orb] step N …" lines into each step's latest state. */
export function parseProgress(lines: string[]): Record<number, StepProgress> {
  const steps: Record<number, StepProgress> = {};
  for (const line of lines) {
    const m = line.match(LINE);
    if (!m) continue;
    const state = m[2].toLowerCase() as StepState;
    steps[Number(m[1])] = state === "waiting" && m[3] ? { state, note: m[3].trim() } : { state };
  }
  return steps;
}

interface FoundSession {
  path: string;
  sessionId: string;
  modifiedMs: number;
}

/** Stop looking for a session that never turned up after this long. */
const GIVE_UP_MS = 2 * 60 * 60 * 1000;
const POLL_MS = 10_000;

/** Links `taskId` to the session it opens next. Called just before opening it. */
export async function linkSession(taskId: string) {
  // A little slack for clocks and the time the deep link takes to open.
  await db.saveSessionLink(taskId, { startedAt: Date.now() - 30_000 });
}

/** Follows a task's linked session while the card is on screen. */
export function useSessionProgress(taskId: string, link: SessionLink | undefined): SessionProgress | null {
  const [progress, setProgress] = useState<SessionProgress | null>(null);
  useEffect(() => {
    if (!link) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    let path = link.path;
    const poll = async () => {
      try {
        if (!path) {
          if (Date.now() - link.startedAt > GIVE_UP_MS) return;
          const found = await invoke<FoundSession | null>("find_session", { marker: sessionMarker(taskId), sinceMs: link.startedAt });
          if (!found) {
            if (!cancelled) setProgress({ steps: {}, updatedAt: null, found: false });
            return;
          }
          path = found.path;
          await db.saveSessionLink(taskId, { ...link, path: found.path, sessionId: found.sessionId });
        }
        const { lines, modifiedMs } = await invoke<{ lines: string[]; modifiedMs: number }>("read_session_progress", { path });
        if (!cancelled) setProgress({ steps: parseProgress(lines), updatedAt: modifiedMs, found: true });
      } catch {
        // The transcript moved or isn't readable; try again next poll.
      }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskId, link?.startedAt, link?.path]);
  return progress;
}
