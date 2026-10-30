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
  /**
   * Steps (1-based) the user marked done themselves: ones the session can't see happen, like a
   * message they sent from Slack or a step of their own.
   */
  doneSteps?: number[];
  /** Keys of handed-off messages Orb has already sent (see PendingSend). */
  sentKeys?: string[];
  /** Why the session's last background turn failed, if it did. Cleared when the next one starts. */
  lastError?: string | null;
}

/** A Slack message the session handed to Orb to send, for the user to review first. */
export interface PendingSend {
  /** Identifies this exact message, to remember it was sent. */
  key: string;
  /** The step it finishes, when the session said. */
  step?: number;
  /** Where it goes: "#channel", a channel id, or a thread's permalink. */
  to: string;
  text: string;
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
  /** Messages the session handed to Orb, oldest first. */
  sends: PendingSend[];
  /** Your latest message to the session, unless it's still the opening prompt. */
  lastUser?: string | null;
  /** What Claude has said since, without its "[orb]" report lines and hand-off blocks. */
  lastReply?: string | null;
  /** When the transcript last changed (ms). */
  updatedAt: number | null;
  found: boolean;
}

const LINE = /^\[orb\]\s*step\s+(\d+)\s+(started|done|waiting)\b\s*:?\s*(.*)$/i;

/**
 * Turns the session's "[orb] step N …" lines into each step's latest state. Sessions work through
 * the steps in order and sometimes skip a "done" report, so once a later step is reported, any
 * earlier step still marked started counts as done. (A step waiting on the user stays waiting.)
 */
export function parseProgress(lines: string[]): Record<number, StepProgress> {
  const steps: Record<number, StepProgress> = {};
  for (const line of lines) {
    const m = line.match(LINE);
    if (!m) continue;
    const n = Number(m[1]);
    const state = m[2].toLowerCase() as StepState;
    steps[n] = state === "waiting" && m[3] ? { state, note: m[3].trim() } : { state };
    for (const [earlier, progress] of Object.entries(steps))
      if (Number(earlier) < n && progress.state === "started") steps[Number(earlier)] = { state: "done" };
  }
  return steps;
}

const SEND = /^\[orb\]\s*send(?:\s+step\s+(\d+))?\s+to\s+(.+?)\s*:?\s*$/i;

/** A short, stable key for a message's destination and text. */
function messageKey(to: string, text: string): string {
  let h = 5381;
  for (const ch of `${to}\n${text}`) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

/** Turns the session's "[orb] send … / [orb] end" blocks into messages, unwrapping a code fence around the text. */
export function parseSends(blocks: { header: string; body: string }[]): PendingSend[] {
  return blocks.flatMap(({ header, body }) => {
    const m = header.match(SEND);
    if (!m) return [];
    const text = body
      .trim()
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```$/, "")
      .trim();
    if (!text) return [];
    const to = m[2].trim();
    return [{ key: messageKey(to, text), ...(m[1] ? { step: Number(m[1]) } : {}), to, text }];
  });
}

/**
 * The handed-off messages still to send: unsent ones, and only the latest for each step (a session
 * that revises a message hands it over again).
 */
export function unsentMessages(sends: PendingSend[], link: SessionLink | undefined): PendingSend[] {
  const sent = new Set(link?.sentKeys ?? []);
  const latest = new Map<string, PendingSend>();
  for (const send of sends) latest.set(send.step != null ? `step:${send.step}` : send.key, send);
  return [...latest.values()].filter((send) => !sent.has(send.key));
}

/** Claude's message as the user should read it: "[orb]" report lines and hand-off blocks taken out. */
export function readableReply(text: string): string {
  return text
    .replace(/^\s*`?\[orb\] send[^\n]*\n[\s\S]*?^\s*`?\[orb\] end`?\s*$/gim, "")
    .split("\n")
    .filter((line) => !/^\s*[-`]*\s*\[orb\]/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface FoundSession {
  path: string;
  sessionId: string;
  modifiedMs: number;
}

/** Stop looking for a session that never turned up after this long. */
export const GIVE_UP_MS = 2 * 60 * 60 * 1000;
const POLL_MS = 10_000;

/** Links `taskId` to the session it opens next. Called just before opening it. */
export async function linkSession(taskId: string) {
  // Once a session has picked the task up, the link is permanent.
  if ((await db.getSessionLinks())[taskId]?.sessionId) return;
  // A little slack for clocks and the time the deep link takes to open.
  await db.saveSessionLink(taskId, { startedAt: Date.now() - 30_000 });
}

/** A step's state: done if the user marked it so, otherwise what the session last reported. */
export function stepState(progress: SessionProgress | null, link: SessionLink | undefined, step: number): StepProgress | undefined {
  if (link?.doneSteps?.includes(step)) return { state: "done" };
  return progress?.steps[step];
}

/** Marks a step done by hand, for work the session didn't see happen. */
export async function markStepDone(taskId: string, step: number) {
  const link = (await db.getSessionLinks())[taskId];
  if (!link || link.doneSteps?.includes(step)) return;
  await db.updateSessionLink(taskId, { doneSteps: [...(link.doneSteps ?? []), step] });
}

/**
 * Follows a task's linked session while the card is on screen. `onLinked` runs once the session
 * turns up, so the card reloads and knows the task is linked.
 */
export function useSessionProgress(taskId: string, link: SessionLink | undefined, onLinked?: () => void): SessionProgress | null {
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
            if (!cancelled) setProgress({ steps: {}, sends: [], updatedAt: null, found: false });
            return;
          }
          path = found.path;
          await db.updateSessionLink(taskId, { path: found.path, sessionId: found.sessionId });
          onLinked?.();
        }
        const { lines, sends, lastUser, lastReply, modifiedMs } = await invoke<{
          lines: string[];
          sends: { header: string; body: string }[];
          lastUser: string | null;
          lastReply: string | null;
          modifiedMs: number;
        }>("read_session_progress", { path });
        if (!cancelled)
          setProgress({
            steps: parseProgress(lines),
            sends: parseSends(sends),
            // The opening prompt isn't a reply of yours.
            lastUser: lastUser && !lastUser.startsWith("Orb task:") ? lastUser : null,
            lastReply: lastReply ? readableReply(lastReply) || null : null,
            updatedAt: modifiedMs,
            found: true,
          });
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
