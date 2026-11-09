import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import * as db from "./db";
import { sessionMarker } from "./openInClaude";
import { WATCH_CHAT } from "./watched";
import { channelLabel, slackTarget, slackThread } from "./projects";
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
  artifacts?: { step?: number; stepTitle?: string; title: string; url: string }[];
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
  /** The re-checked list Orb last asked the session to restate, so it asks once per list. */
  alignAsked?: string;
  /** The transcript state ("reports:messages") last re-checked, so the same drift isn't re-checked twice. */
  recheckedKey?: string;
  /**
   * Started as a chat about something else (an update to explain, a message to reply to), so it
   * hasn't been given a task's steps or how to report them. A task that shares its key (an inbox
   * item that's also a task) gives it them with your next message there.
   */
  topic?: boolean;
  /** Code the session asked to read ("[orb] code …") beyond its project's, found and added (see resolveCheckout). */
  code?: { label: string; dir: string }[];
  /** Its "[orb] code" requests already handled, found or not. */
  codeAsked?: string[];
  /** Why the session's last background turn failed, if it did. Cleared when the next one starts. */
  lastError?: string | null;
  /**
   * Your edits to drafts it handed over that you haven't sent yet, by the draft's key, so closing the
   * review box, the chat or the app keeps them. Dropped once the draft is sent or turned down.
   */
  edits?: Record<string, string>;
}

/** The edits with one draft's text set, or dropped when it's back to what Claude wrote (or `text` is null). */
export function withEdit(edits: Record<string, string> | undefined, key: string, text: string | null, original: string): Record<string, string> {
  const { [key]: _old, ...rest } = edits ?? {};
  return text === null || text === original ? rest : { ...rest, [key]: text };
}

/** Saves your edit to one of a session's drafts (see SessionLink.edits); null forgets it. */
export async function saveDraftEdit(taskId: string, key: string, text: string | null, original: string) {
  const link = (await db.getSessionLinks())[taskId];
  if (!link) return;
  const edits = withEdit(link.edits, key, text, original);
  if (JSON.stringify(edits) !== JSON.stringify(link.edits ?? {})) await db.updateSessionLink(taskId, { edits });
}

/** A Slack message (or a Google Doc) the session handed to Orb to send or create, for the user to review first. */
export interface PendingSend {
  /**
   * A Slack message (the default), a Google Doc, a calendar event or a Jira ticket to create; for
   * those, `to` is its title and `text` its content (for an event, its when/who lines and description;
   * for a ticket, its project/type/epic lines and description).
   */
  kind?: "message" | "doc" | "event" | "ticket";
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
  // A message that's only a note from Orb (one Orb sent itself) isn't shown at all.
  if (text.trimStart().startsWith(ORB_NOTE)) return "";
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
  /** Your messages in the conversation when it was made: one sent after it is one it hasn't heard. */
  userMessages?: number;
}

/** A step of the plan as the session last revised it. */
export interface PlanStep {
  title: string;
  by: "claude" | "you";
}

export interface SessionProgress {
  /** The plan as the session last revised it ("[orb] plan" … "[orb] end"), or null if it hasn't. Step numbers refer to it. */
  plan?: PlanStep[] | null;
  /** The plan the session itself last wrote, leaving Orb's re-checks out: the list its own step numbers follow. Null if it never restated one. */
  ownPlan?: PlanStep[] | null;
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
  /** Your messages since the opening prompt (Orb's own, after a send, count too). */
  userMessages?: number;
  /** You've said something since the session last restated the plan, or it never has: the steps may not reflect it. */
  userSincePlan?: boolean;
  /** When the transcript last changed (ms). */
  updatedAt: number | null;
  found: boolean;
}

const LINE = /^\[orb\]\s*step\s+(\d+)\s+(started|done|waiting|skipped|blocked)\b\s*:?\s*(.*)$/i;
const PLAN = /^\[orb\]\s*plan\b/i;
/** A restated plan anywhere in a message. */
const PLAN_LINE = /^[\s`\-]*\[orb\]\s*plan\b/im;

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

/** A step's title for matching across restatements: case, punctuation and a [Me] marker don't count. */
const stepKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/^\[me\]\s*/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Where each step of a restated plan stands: a step that was in the plan before (by its title)
 * keeps the state it had there, wherever it moved; a new or reworded one starts fresh. Without the
 * earlier plan's titles nothing can be matched, so nothing carries over.
 */
export function carryStates(before: PlanStep[] | null, states: Record<number, StepProgress>, after: PlanStep[]): Record<number, StepProgress> {
  if (!before?.length) return {};
  const used = new Set<number>();
  const out: Record<number, StepProgress> = {};
  after.forEach((st, j) => {
    const i = before.findIndex((old, k) => !used.has(k) && stepKey(old.title) === stepKey(st.title));
    if (i < 0) return;
    used.add(i);
    if (states[i + 1]) out[j + 1] = states[i + 1];
  });
  return out;
}

/** The plan a task's chat opened with, from its opening prompt's numbered list ("The plan, in order"); null if it has none. */
export function openingPlan(raw: ChatMessage[]): PlanStep[] | null {
  const first = raw[0];
  if (first?.role !== "user" || !first.text.startsWith("Orb task:")) return null;
  const at = first.text.indexOf("The plan, in order");
  if (at < 0) return null;
  const steps: PlanStep[] = [];
  for (const line of first.text.slice(at).split("\n").slice(1)) {
    const m = line.match(/^\d+\.\s+(.*)$/);
    if (!m) {
      if (steps.length) break;
      continue;
    }
    const mine = /^\[me\]\s*/i.test(m[1]);
    steps.push({ title: m[1].replace(/^\[me\]\s*/i, "").trim(), by: mine ? "you" : "claude" });
  }
  return steps.length ? steps : null;
}

/**
 * The plan and each step's state now. It starts from the plan the chat opened with (`opening`), or
 * from Orb's latest re-check when there is one, and follows the session's reports in order. When the
 * session restates the plan, each step it keeps (by title) keeps its state, so restating a plan
 * doesn't undo the steps already done. Plan is null while the session still has the plan it opened with.
 */
export function stepsNow(
  lines: string[],
  blocks: { header: string; body: string }[],
  recheck?: StepRecheckResult,
  opening?: PlanStep[] | null,
): { plan: PlanStep[] | null; steps: Record<number, StepProgress> } {
  const restatements = blocks.filter((b) => PLAN.test(b.header)).map((b) => parsePlan(b.body));
  let plan: PlanStep[] | null = opening?.length ? opening : null;
  let steps: Record<number, StepProgress> = {};
  let revised = false;
  let from = 0;
  let next = 0;
  if (recheck && lines.length >= recheck.reports) {
    from = recheck.reports;
    plan = recheck.plan;
    steps = { ...recheck.states };
    revised = true;
    next = lines.slice(0, from).filter((l) => PLAN.test(l)).length;
  }
  for (const line of lines.slice(from)) {
    if (PLAN.test(line)) {
      const restated = restatements[next++];
      if (!restated?.length) continue;
      steps = carryStates(plan, steps, restated);
      plan = restated;
      revised = true;
      continue;
    }
    report(steps, line);
  }
  return { plan: revised ? plan : null, steps };
}

/**
 * Whether the steps have caught up with what you said: the session restates the plan when a message
 * changes the work, so a message of yours after its last restatement (or with none yet) may not be
 * reflected. Counts your messages since the opening prompt, from the raw transcript.
 */
export function heardSincePlan(raw: ChatMessage[]): { userMessages: number; userSincePlan: boolean } {
  // Orb's own notes to the session (code it asked for, now there) aren't you speaking.
  const said = (raw[0]?.role === "user" && raw[0].text.startsWith("Orb task:") ? raw.slice(1) : raw).filter((m) => !(m.role === "user" && m.text.trimStart().startsWith(ORB_NOTE)));
  const lastSaid = said.map((m) => m.role).lastIndexOf("user");
  const restated = said.findLastIndex((m) => m.role === "assistant" && PLAN_LINE.test(m.text));
  return { userMessages: said.filter((m) => m.role === "user").length, userSincePlan: lastSaid > restated };
}

/**
 * Whether a task chat's steps should be re-checked against its conversation, once a turn is over and
 * the transcript has changed since the last check: you said something the session didn't restate the
 * plan for and the last re-check hasn't seen (`heard` is how many of your messages it had), the
 * session reported a step the list doesn't have, or the steps look out of order.
 */
export function stepsNeedRecheck(progress: Pick<SessionProgress, "steps" | "userMessages" | "userSincePlan">, shown: (StepProgress | undefined)[], heard: number): boolean {
  const unheard = !!progress.userSincePlan && (progress.userMessages ?? 0) > heard;
  const pastTheEnd = Object.keys(progress.steps).some((n) => Number(n) > shown.length);
  return unheard || pastTheEnd || looksOutOfSync(shown);
}

/**
 * The plan as the card shows it now, with each step's state, for the session's next turn: Orb's
 * re-check or the session's own restatement, whichever is newer. Null while the session still has
 * the plan it started with (its opening prompt lists it).
 */
export async function currentSessionSteps(link: SessionLink): Promise<{ plan: PlanStep[]; steps: Record<number, StepProgress>; rechecked: boolean } | null> {
  if (!link.path) return link.recheck ? { plan: link.recheck.plan, steps: link.recheck.states, rechecked: true } : null;
  const { lines, sends, messages } = await invoke<{ lines: string[]; sends: { header: string; body: string }[]; messages: ChatMessage[] }>("read_session_progress", { path: link.path });
  const now = stepsNow(lines, sends, link.recheck, openingPlan(messages));
  // The list is Orb's re-check, not one the session wrote, while it hasn't restated the plan since.
  const rechecked = !!link.recheck && lines.length >= link.recheck.reports && !lines.slice(link.recheck.reports).some((l) => PLAN.test(l));
  return now.plan?.length ? { plan: now.plan, steps: now.steps, rechecked } : null;
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

/**
 * Turns the session's "[orb] step N …" lines into each step's latest state. A step is done only when
 * it's reported done: one left started while a later step moves stays started (the steps then look
 * out of order, so Orb re-checks them against the conversation), since a later step moving doesn't
 * finish an earlier one.
 */
export function parseProgress(lines: string[]): Record<number, StepProgress> {
  const steps: Record<number, StepProgress> = {};
  for (const line of lines) report(steps, line);
  return steps;
}

/** Applies one "[orb] step N …" report to the steps' states; other lines are ignored. */
function report(steps: Record<number, StepProgress>, line: string) {
  const m = line.match(LINE);
  if (!m) return;
  const state = m[2].toLowerCase() as StepState;
  steps[Number(m[1])] = state !== "started" && state !== "done" && m[3] ? { state, note: m[3].trim() } : { state };
}

/**
 * Whether a task's plan is finished, so the task is done: every step done (or skipped as no longer
 * needed, with at least one done), and nothing the session handed over still waiting for you to
 * review and send or create. A draft isn't a finished step.
 */
export function planFinished(states: (StepProgress | undefined)[], unsent: number): boolean {
  return (
    states.length > 0 &&
    states.every((s) => s?.state === "done" || s?.state === "skipped") &&
    states.some((s) => s?.state === "done") &&
    unsent === 0
  );
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
const TICKET = /^\[orb\]\s*ticket(?:\s+step\s+(\d+))?\s*:?\s*(.+?)\s*$/i;

export function parseSends(blocks: { header: string; body: string }[]): PendingSend[] {
  return blocks.flatMap(({ header, body }): PendingSend[] => {
    const doc = header.match(DOC);
    const event = doc ? null : header.match(EVENT);
    const ticket = doc || event ? null : header.match(TICKET);
    if (doc || event || ticket) {
      const kind = doc ? ("doc" as const) : event ? ("event" as const) : ("ticket" as const);
      const m = (doc ?? event ?? ticket)!;
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
    // The target can have spaces ("Ana Lee (DM with Ana Lee)"): it ends at the first " (".
    const named = m[2].trim().match(/^(.+?)\s+\((.+)\)$/);
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

const CODE = /^\[orb\]\s*code\b\s*:?\s*(.+)$/i;

/** The code a session asked to read ("[orb] code <repo or folder>"), each once, oldest first. */
export function codeRequests(lines: string[]): string[] {
  const asked = lines.map((l) => l.match(CODE)?.[1]?.trim()).filter((a): a is string => !!a);
  return [...new Set(asked)];
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
    .replace(/^\s*`?\[orb\] (?:send|plan|action|doc|event|ticket)[^\n]*\n[\s\S]*?^\s*`?\[orb\] end`?\s*$/gim, "")
    // A block still being written (a reply streaming in) is hidden until it's complete.
    .replace(/^\s*`?\[orb\] (?:send|plan|action|doc|event|ticket)[^\n]*(?:\n[\s\S]*)?$/im, "")
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
        const heard = heardSincePlan(raw);
        const after = messages.slice(lastUserAt + 1).filter((m) => m.role === "assistant");
        const now = stepsNow(lines, sends, recheck.current, openingPlan(raw));
        // A plan the chat revised is a correction: what it was, what it became, and what was said.
        // (A watched topic's chat restates its conditional actions this way; those aren't task plans.)
        if (now.plan?.length && !taskId.startsWith(WATCH_CHAT)) {
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
            ownPlan: currentPlan(lines, sends).plan,
            steps: now.steps,
            reports: lines.length,
            ...heard,
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
  if (!thread) {
    const target = slackTarget(send.to);
    return target.kind === "person"
      ? `DM with ${target.name}`
      : target.kind === "user"
        ? "a DM"
        : target.kind === "group"
          ? target.ids.length
            ? "a group DM"
            : `group DM with ${target.names.join(", ")}`
          : send.to;
  }
  const kind = id.startsWith("D") ? "a DM" : id.startsWith("G") ? "a group DM" : id.startsWith("C") ? "a channel" : null;
  return kind ? `the thread in ${kind}` : "the thread";
}

/** Words Slack uses to address a whole channel or workspace: never one place to send to. */
const EVERYONE = /^<?[!@#]?(?:everyone|here|channel|all)>?$/i;

/** What kind of place the session's words for a destination describe, when they say. */
function labelKind(label: string): "channel" | "dm" | "group" | null {
  const l = label.trim();
  if (/^#?mpdm-/.test(l) || /^(?:a\s+)?group\s+DM\b/i.test(l)) return "group";
  if (/^#/.test(l)) return "channel";
  if (/^(?:a\s+)?DM\b/i.test(l)) return "dm";
  return null;
}

/**
 * Why a handed-over message can't be sent as it stands, or null when it can. The card shows where a
 * message goes in the session's own words, so those words and the target it actually posts to must
 * agree: a message described as a group DM must never go to a channel. Refused: a target that
 * addresses everyone ("everyone", "@here"), words and target naming different places, a bare word
 * that could be a channel or a person, and a link that isn't a Slack thread.
 */
export function sendProblem(send: Pick<PendingSend, "kind" | "to" | "label">): string | null {
  if ((send.kind ?? "message") !== "message") return null;
  const to = send.to.trim();
  const unclear = "It's not clear where this goes:";
  if (/^https?:\/\//.test(to)) return slackThread(to) ? null : `${unclear} "${to}" isn't a link to a Slack thread.`;
  if (EVERYONE.test(to) || to.split(/\s*,\s*/).some((p) => EVERYONE.test(p))) return `${unclear} "${to}" isn't a person or a conversation.`;
  const target = slackTarget(to);
  const kind = target.kind === "channel" ? "channel" : target.kind === "group" ? "group" : target.kind === "user" || target.kind === "person" ? "dm" : null;
  const said = send.label ? labelKind(send.label) : null;
  if (said && kind && (said !== kind || (kind === "channel" && target.kind === "channel" && send.label!.trim().replace(/^#/, "") !== target.name)))
    return `${unclear} the chat wrote "${to}" but called it "${send.label!.trim()}".`;
  // Channels are written "#name"; a bare word is only a channel when the session's words say so.
  if (target.kind === "channel" && !/^#/.test(to) && said !== "channel") return `${unclear} "${to}" could be a channel or a person.`;
  return null;
}

/**
 * Why a ticket wasn't filed, in plain words. When Jira won't take even the summary ("Field 'summary'
 * cannot be set. It is not on the appropriate screen"), there's no create screen for you: your
 * account can't file that type of ticket in that project. Any other error is kept as it is.
 */
export function ticketFailure(error: string, ticket: string): string {
  if (!/summary'?\s+cannot be set|summary.{0,40}not on the appropriate screen/i.test(error)) return error;
  const field = (name: string) => ticket.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim();
  const project = field("project");
  const type = field("type") ?? "ticket";
  const where = project ? ` in ${project}` : " in that project";
  const a = /^[aeiou]/i.test(type) ? "an" : "a";
  return `Jira won't let you create ${a} ${type}${where}, which usually means your account can't file tickets there. Change the project line to one you can file in, or send the ticket to someone on that team to file. Nothing was created.`;
}
