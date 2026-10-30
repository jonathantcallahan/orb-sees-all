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
  /**
   * Steps the user marked done by title: these still match once the session revises the plan and
   * the numbers shift. (doneSteps is kept for marks made before that.)
   */
  doneTitles?: string[];
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

export type StepState = "started" | "done" | "waiting" | "skipped" | "blocked";

export interface StepProgress {
  state: StepState;
  /**
   * For "waiting": what the session needs from the user. For "blocked": who or what it's waiting
   * on outside the conversation. For "skipped": why it's no longer needed.
   */
  note?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

/** The conversation as you'd read it: the opening prompt left out, Claude's report lines and hand-offs removed. */
export function readableMessages(raw: ChatMessage[]): ChatMessage[] {
  return raw
    .filter((m, i) => !(i === 0 && m.role === "user" && m.text.startsWith("Orb task:")))
    .map((m) => (m.role === "assistant" ? { ...m, text: readableReply(m.text) } : { ...m, text: m.text.trim() }))
    .filter((m) => m.text);
}

/** A step of the plan as the session last revised it. */
export interface PlanStep {
  title: string;
  by: "claude" | "you";
}

export interface SessionProgress {
  /** The plan as the session last revised it ("[orb] plan" … "[orb] end"), or null if it hasn't. Step numbers refer to it. */
  plan?: PlanStep[] | null;
  /** Progress by step number (1-based), latest report per step. */
  steps: Record<number, StepProgress>;
  /** Messages the session handed to Orb, oldest first. */
  sends: PendingSend[];
  /** The conversation since the opening prompt: your messages and Claude's, without its report lines. */
  messages?: ChatMessage[];
  /** Your latest message to the session, unless it's still the opening prompt. */
  lastUser?: string | null;
  /** What Claude has said since, without its "[orb]" report lines and hand-off blocks. */
  lastReply?: string | null;
  /** When the transcript last changed (ms). */
  updatedAt: number | null;
  found: boolean;
}

const LINE = /^\[orb\]\s*step\s+(\d+)\s+(started|done|waiting|skipped|blocked)\b\s*:?\s*(.*)$/i;
const PLAN = /^\[orb\]\s*plan\b/i;

/** The steps of an "[orb] plan" block: one per numbered (or bulleted) line, "[Me]" marking the user's. */
export function parsePlan(body: string): PlanStep[] {
  return body
    .split("\n")
    .map((line) => line.trim().replace(/^`+|`+$/g, ""))
    .map((line) => line.match(/^(?:\d+[.)]|[-*•])\s+(.*)$/)?.[1]?.trim())
    .filter((line): line is string => !!line)
    .map((line) => {
      const mine = /^\[me\]\s*/i.test(line);
      return { title: line.replace(/^\[me\]\s*/i, ""), by: mine ? ("you" as const) : ("claude" as const) };
    });
}

/**
 * The session's latest revised plan and the report lines that count against it: once the session
 * restates the plan, earlier reports used the old numbering, so only the ones after it apply.
 */
export function currentPlan(lines: string[], blocks: { header: string; body: string }[]): { plan: PlanStep[] | null; lines: string[] } {
  const block = [...blocks].reverse().find((b) => PLAN.test(b.header));
  const plan = block ? parsePlan(block.body) : [];
  if (!plan.length) return { plan: null, lines };
  return { plan, lines: lines.slice(lines.findLastIndex((l) => PLAN.test(l)) + 1) };
}

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
    steps[n] = state !== "started" && state !== "done" && m[3] ? { state, note: m[3].trim() } : { state };
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
    .replace(/^\s*`?\[orb\] (?:send|plan)[^\n]*\n[\s\S]*?^\s*`?\[orb\] end`?\s*$/gim, "")
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
export function stepState(progress: SessionProgress | null, link: SessionLink | undefined, step: number, title?: string): StepProgress | undefined {
  if (title && link?.doneTitles?.includes(title)) return { state: "done" };
  // Marks by number only hold for the plan they were made against: the original one.
  if (!progress?.plan && link?.doneSteps?.includes(step)) return { state: "done" };
  return progress?.steps[step];
}

/** Marks a step done by hand, for work the session didn't see happen. */
export async function markStepDone(taskId: string, title: string) {
  const link = (await db.getSessionLinks())[taskId];
  if (!link || link.doneTitles?.includes(title)) return;
  await db.updateSessionLink(taskId, { doneTitles: [...(link.doneTitles ?? []), title] });
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
        const { lines, sends, messages: raw, modifiedMs } = await invoke<{
          lines: string[];
          sends: { header: string; body: string }[];
          messages: ChatMessage[];
          modifiedMs: number;
        }>("read_session_progress", { path });
        const messages = readableMessages(raw);
        const lastUserAt = messages.map((m) => m.role).lastIndexOf("user");
        const after = messages.slice(lastUserAt + 1).filter((m) => m.role === "assistant");
        const revised = currentPlan(lines, sends);
        if (!cancelled)
          setProgress({
            plan: revised.plan,
            steps: parseProgress(revised.lines),
            sends: parseSends(sends),
            messages,
            lastUser: lastUserAt >= 0 ? messages[lastUserAt].text : null,
            lastReply: after.length ? after.map((m) => m.text).join("\n\n") : null,
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
