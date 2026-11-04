import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import * as db from "./db";
import { sessionMarker } from "./openInClaude";
import { channelLabel } from "./projects";
import { GlobalAction } from "./schema";

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
  /**
   * What Orb sent or created for the session (a message, a doc, an event), with its link and the
   * step it finished when there was one, shown as chips beside that step.
   */
  artifacts?: { step?: number; title: string; url: string }[];
  /** Proposed changes the user applied, by key (see PendingAction): what each was and what came of it. */
  applied?: Record<string, { summary: string; result: string }>;
  /** Keys of proposed changes the user turned down. */
  dismissedKeys?: string[];
  /** Preferences the session handed over ("[orb] remember …") that are already saved as lessons. */
  remembered?: string[];
  /** The plan as last recorded as a correction, so each revision in the chat is logged once. */
  loggedPlan?: string[];
  /**
   * Orb's latest re-check of the steps against the conversation (see recheckSessionSteps): the plan
   * and states it settled on, and how many report lines the transcript had then. Reports written
   * after it apply on top of it.
   */
  recheck?: StepRecheckResult;
  /** The transcript state ("reports:messages") last re-checked, so the same drift isn't re-checked twice. */
  recheckedKey?: string;
  /** The session is talking the plan through with the user (Discuss plan) and hasn't started the work. */
  discussing?: boolean;
  /** Why the session's last background turn failed, if it did. Cleared when the next one starts. */
  lastError?: string | null;
}

/** A Slack message (or a Google Doc) the session handed to Orb to send or create, for the user to review first. */
export interface PendingSend {
  /**
   * A Slack message (the default), a Google Doc to create, or a calendar event to create; for a doc
   * or event, `to` is its title and `text` its content (for an event, its when/who/where lines and
   * description).
   */
  kind?: "message" | "doc" | "event";
  /** Identifies this exact message, to remember it was sent. */
  key: string;
  /** The step it finishes, when the session said. */
  step?: number;
  /** Where it goes: "#channel", a channel id, or a thread's permalink. */
  to: string;
  /** Where it goes, in words, as the session put it ("group DM with Ana, Ben"), when it said. */
  label?: string;
  text: string;
}

/** A change the session proposed to the planner ("[orb] action" … "[orb] end"), for the user to apply. */
export interface PendingAction {
  key: string;
  /** The change, or null when the block wasn't a change Orb understands (see error). */
  action: GlobalAction | null;
  error?: string;
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

/**
 * Notes Orb adds to a message of yours for Claude (how to hand over a doc or an invite): a closing
 * paragraph in parentheses starting "(From Orb:". They're for Claude, so the chat leaves them out.
 */
export const ORB_NOTE = "(From Orb:";
export function withoutOrbNotes(text: string): string {
  const at = text.indexOf(`\n\n${ORB_NOTE}`);
  return (at >= 0 ? text.slice(0, at) : text).trim();
}

/** The conversation as you'd read it: the opening prompt left out, Claude's report lines and hand-offs removed. */
export function readableMessages(raw: ChatMessage[]): ChatMessage[] {
  return raw
    // An opening prompt that carries the user's own first words (the global chat's) shows as just those.
    .map((m, i) => (i === 0 && m.role === "user" && m.text.startsWith("Orb task:") && m.text.includes(OPENING_MESSAGE) ? { ...m, text: m.text.slice(m.text.lastIndexOf(OPENING_MESSAGE) + OPENING_MESSAGE.length) } : m))
    .filter((m, i) => !(i === 0 && m.role === "user" && m.text.startsWith("Orb task:")))
    .map((m) => (m.role === "assistant" ? { ...m, text: readableReply(m.text) } : { ...m, text: withoutOrbNotes(m.text) }))
    .filter((m) => m.text);
}

/** Where an opening prompt quotes the user's first message (see globalChatPrompt). */
export const OPENING_MESSAGE = "\nMy message: ";

export interface StepRecheckResult {
  plan: PlanStep[];
  states: Record<number, StepProgress>;
  /** Report lines in the transcript when it was made. */
  reports: number;
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
  /** Changes the session proposed, oldest first. */
  actions?: PendingAction[];
  /** The conversation since the opening prompt: your messages and Claude's, without its report lines. */
  messages?: ChatMessage[];
  /** Your latest message to the session, unless it's still the opening prompt. */
  lastUser?: string | null;
  /** What Claude has said since, without its "[orb]" report lines and hand-off blocks. */
  lastReply?: string | null;
  /** How many "[orb]" report lines the transcript has; with the message count, it says whether anything changed. */
  reports?: number;
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
/**
 * The plan and each step's state now: from Orb's latest re-check when there is one, with the
 * session's reports since then on top, unless the session has restated the plan since.
 */
export function stepsNow(
  lines: string[],
  blocks: { header: string; body: string }[],
  recheck?: StepRecheckResult,
): { plan: PlanStep[] | null; steps: Record<number, StepProgress> } {
  if (recheck && lines.length >= recheck.reports) {
    const newer = lines.slice(recheck.reports);
    if (!newer.some((l) => PLAN.test(l))) return { plan: recheck.plan, steps: { ...recheck.states, ...parseProgress(newer) } };
  }
  const revised = currentPlan(lines, blocks);
  return { plan: revised.plan, steps: parseProgress(revised.lines) };
}

/**
 * Whether the steps look out of step with the session: one not yet done (or skipped) while a later
 * one has started or finished. Steps are done in order, so that means a report went missing or a
 * decision in the conversation changed the plan.
 */
export function looksOutOfSync(states: (StepProgress | undefined)[]): boolean {
  const settled = (s?: StepProgress) => s?.state === "done" || s?.state === "skipped";
  return states.some((s, j) => (s?.state === "started" || s?.state === "done") && states.slice(0, j).some((earlier) => !settled(earlier)));
}

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
const DOC = /^\[orb\]\s*doc(?:\s+step\s+(\d+))?\s*:?\s*(.+?)\s*$/i;
const EVENT = /^\[orb\]\s*event(?:\s+step\s+(\d+))?\s*:?\s*(.+?)\s*$/i;

export function parseSends(blocks: { header: string; body: string }[]): PendingSend[] {
  return blocks.flatMap(({ header, body }): PendingSend[] => {
    const doc = header.match(DOC);
    const event = doc ? null : header.match(EVENT);
    if (doc || event) {
      const kind = doc ? ("doc" as const) : ("event" as const);
      const m = (doc ?? event)!;
      const text = body.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
      const title = m[2].trim();
      return text ? [{ kind, key: messageKey(`${kind}:${title}`, text), ...(m[1] ? { step: Number(m[1]) } : {}), to: title, text }] : [];
    }
    const m = header.match(SEND);
    if (!m) return [];
    const text = body
      .trim()
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```$/, "")
      .trim();
    if (!text) return [];
    // "<target> (<where, in words>)": the words are for showing; the target is where it posts.
    const named = m[2].trim().match(/^(\S+)\s+\((.+)\)$/);
    const to = named ? named[1] : m[2].trim();
    return [{ key: messageKey(to, text), ...(m[1] ? { step: Number(m[1]) } : {}), to, ...(named ? { label: named[2].trim() } : {}), text }];
  });
}

const ACTION = /^\[orb\]\s*action\b/i;

/** Turns the session's "[orb] action / [orb] end" blocks into proposed changes, the same change once. */
export function parseActions(blocks: { header: string; body: string }[]): PendingAction[] {
  const seen = new Set<string>();
  return blocks.flatMap(({ header, body }) => {
    if (!ACTION.test(header)) return [];
    const text = body
      .trim()
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```$/, "")
      .trim();
    const key = messageKey("action", text);
    if (!text || seen.has(key)) return [];
    seen.add(key);
    try {
      const parsed = GlobalAction.safeParse(JSON.parse(text));
      return [parsed.success ? { key, action: parsed.data } : { key, action: null, error: "Couldn't read this change" }];
    } catch {
      return [{ key, action: null, error: "Couldn't read this change" }];
    }
  });
}

/**
 * The messages handed over since the plan last changed: a revised plan ("[orb] plan") can make an
 * earlier draft moot, and its step numbers no longer match, so drafts from before it are dropped.
 * The session hands over again whatever still stands.
 */
export function currentSends(blocks: { header: string; body: string }[]): PendingSend[] {
  const lastPlan = blocks.map((b) => PLAN.test(b.header)).lastIndexOf(true);
  return parseSends(blocks.slice(lastPlan + 1));
}

/**
 * The handed-off messages still to send: not sent or set aside, and only the latest for each step
 * or, without a step, for each destination (a session that revises a message hands it over again).
 */
export function unsentMessages(sends: PendingSend[], link: SessionLink | undefined): PendingSend[] {
  const done = new Set([...(link?.sentKeys ?? []), ...(link?.dismissedKeys ?? [])]);
  const latest = new Map<string, PendingSend>();
  for (const send of sends) latest.set(send.step != null ? `step:${send.step}` : `to:${send.to}`, send);
  return [...latest.values()].filter((send) => !done.has(send.key));
}

/** Claude's message as the user should read it: "[orb]" report lines and hand-off blocks taken out. */
const REMEMBER = /^\[orb\]\s*remember(?:\s+(plans|writing|tasks|priority|projects|global))?\s*:\s*(.+)$/i;

/** Preferences a session handed over ("[orb] remember <scope>: …"), as lessons to save. */
export function rememberedLessons(lines: string[]): { scope: string; text: string }[] {
  return lines.flatMap((line) => {
    const m = line.match(REMEMBER);
    return m ? [{ scope: (m[1] ?? "plans").toLowerCase(), text: m[2].trim() }] : [];
  });
}

export function readableReply(text: string): string {
  return text
    .replace(/^\s*`?\[orb\] (?:send|plan|action|doc|event)[^\n]*\n[\s\S]*?^\s*`?\[orb\] end`?\s*$/gim, "")
    // A block still being written (a reply streaming in) is hidden until it's complete.
    .replace(/^\s*`?\[orb\] (?:send|plan|action|doc|event)[^\n]*(?:\n[\s\S]*)?$/im, "")
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
  // Read on each poll, so a new re-check applies without restarting the polling.
  const recheck = useRef(link?.recheck);
  recheck.current = link?.recheck;
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
        // Preferences the session handed over become lessons, once each.
        const remember = rememberedLessons(lines);
        if (remember.length) {
          const done = new Set((await db.getSessionLinks())[taskId]?.remembered ?? []);
          const fresh = remember.filter((l) => !done.has(`${l.scope}:${l.text}`));
          for (const l of fresh) await db.addLesson(l.scope, l.text);
          if (fresh.length) await db.updateSessionLink(taskId, { remembered: [...done, ...fresh.map((l) => `${l.scope}:${l.text}`)] });
        }
        const lastUserAt = messages.map((m) => m.role).lastIndexOf("user");
        const after = messages.slice(lastUserAt + 1).filter((m) => m.role === "assistant");
        const now = stepsNow(lines, sends, recheck.current);
        // A plan the chat revised is a correction: what it was, what it became, and what was said.
        if (now.plan?.length) {
          const steps = now.plan.map((st) => `${st.by === "you" ? "[Me] " : ""}${st.title}`);
          const link = (await db.getSessionLinks())[taskId];
          if (link && link.loggedPlan?.join("\n") !== steps.join("\n")) {
            const said = messages.filter((m) => m.role === "user").map((m) => m.text).slice(-2);
            await db.updateSessionLink(taskId, { loggedPlan: steps });
            await db.logFeedback({
              kind: "plan_change",
              subject: "plan",
              subject_id: taskId,
              before: { steps: link.loggedPlan ?? null },
              after: { steps },
              ...(said.length ? { reason: said.join(" / ").slice(0, 1200), reason_source: "chat" as const } : {}),
              source: "chat",
            });
          }
        }
        if (!cancelled)
          setProgress({
            plan: now.plan,
            steps: now.steps,
            reports: lines.length,
            sends: currentSends(sends),
            actions: parseActions(sends),
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
  }, [taskId, link?.startedAt, link?.path, link?.recheck?.reports, link?.recheck?.plan.length]);
  return progress;
}

/**
 * A turn of the chat in progress: where in the conversation it began (how many messages there
 * were), and what you sent, if it was you (Orb starts some turns itself, after a send or approval).
 */
export interface ChatTurn {
  base: number;
  text: string | null;
}

/**
 * The chat as it should read during and right after a turn, so nothing jumps around while the
 * saved transcript (which lags) catches up with what was sent and streamed:
 *
 * - Everything from before the turn stays put, including a reply from the turn before that only
 *   reached the transcript after you sent this one.
 * - Your message shows from the moment you send it, then as the transcript records it.
 * - While Claude is answering, its reply is the live text (the transcript's partial copy is held
 *   back); once the turn is over, the transcript's copy, or the last live text until that lands.
 *
 * `done` means the transcript has caught up (your message and Claude's reply are in it, and nothing
 * is running), so the turn can be let go.
 */
export function chatView(
  messages: ChatMessage[],
  turn: ChatTurn | null,
  opts: { working: boolean; live: string | null; held: string | null },
): { shown: ChatMessage[]; reply: string | null; done: boolean } {
  if (!turn) return { shown: messages, reply: opts.live, done: false };
  const tail = messages.slice(turn.base);
  const at = tail.findIndex((m) => m.role === "user");
  const prior = [...messages.slice(0, turn.base), ...(at >= 0 ? tail.slice(0, at) : tail)];
  const yours = at >= 0 ? [tail[at]] : turn.text ? [{ role: "user" as const, text: turn.text }] : [];
  const after = at >= 0 ? tail.slice(at + 1) : [];
  const answered = after.some((m) => m.role === "assistant");
  if (opts.working || opts.live) return { shown: [...prior, ...yours], reply: opts.live ?? opts.held, done: false };
  if (answered) return { shown: [...prior, ...yours, ...after], reply: null, done: true };
  return { shown: [...prior, ...yours], reply: opts.held, done: false };
}

/**
 * Where a message goes, for the card and the review window: the session's own words for it when it
 * gave them, else what the target says about itself. A Slack permalink's conversation id tells the
 * kind (C a channel, D a DM, G a group DM or private channel), so a thread reads as "the thread in a
 * group DM" rather than just "the thread".
 */
export function sendDestination(send: { to: string; label?: string }): string {
  const thread = /^https?:\/\//.test(send.to);
  const id = send.to.match(/\/archives\/([A-Z0-9]+)/)?.[1] ?? "";
  // A group DM or DM by its people, never "#mpdm-…" or a pound sign (see channelLabel).
  const label = send.label && (/^#?mpdm-/.test(send.label) || /^[DG]/.test(id) ? channelLabel({ name: send.label, channel_id: id.startsWith("D") ? id : undefined }).replace(/^#/, "") : send.label);
  if (label) return thread ? `the thread in ${label}` : label;
  if (!thread) return send.to;
  const kind = id.startsWith("D") ? "a DM" : id.startsWith("G") ? "a group DM" : id.startsWith("C") ? "a channel" : null;
  return kind ? `the thread in ${kind}` : "the thread";
}
