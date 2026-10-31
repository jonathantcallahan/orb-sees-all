import type { TaskPlan } from "./schema";

/** Claude Desktop truncates prefilled prompts at about 14,000 characters. */
const MAX_PROMPT = 13_500;

export interface SessionTask {
  /** Orb's id for the task; the session carries it so Orb can find the session and follow its progress. */
  id?: string;
  title: string;
  description?: string | null;
  link?: string | null;
  requester?: string | null;
  projectName?: string | null;
}

/** What Orb knows about a task without a full plan: its quick assessment. */
export interface QuickTake {
  suggestion?: string | null;
  /** Steps Claude said it could do, in order. */
  steps: string[];
}

/**
 * A self-contained prompt for a new Claude Code session: the task and the plan
 * Claude proposed for it, or, with no plan yet, its quick assessment.
 */
export function sessionPrompt(task: SessionTask, plan: TaskPlan | null, quick?: QuickTake): string {
  const lines = [
    ...(task.id ? [sessionMarker(task.id), ""] : []),
    "I'm working on this task from my day planner and want your help getting it done.",
    "",
    `Task: ${task.title}`,
  ];
  if (task.projectName) lines.push(`Project: ${task.projectName}`);
  if (task.requester) lines.push(`Requested by: ${task.requester}`);
  if (task.link) lines.push(`Source: ${task.link}`);
  if (task.description) lines.push("", task.description);

  let hasSteps = false;
  if (plan) {
    lines.push("", "Here's the plan you proposed earlier:", "", `Approach: ${plan.approach}`, "", "Steps:");
    plan.steps.forEach((step, i) => {
      const detail = [step.detail, step.link].filter(Boolean).join(" ");
      lines.push(`${i + 1}. ${step.title}${detail ? ` (${detail})` : ""}`);
    });
    hasSteps = plan.steps.length > 0;
    if (plan.open_questions.length) lines.push("", "Open questions:", ...plan.open_questions.map((q) => `- ${q}`));
    if (plan.sources.length) lines.push("", "Sources:", ...plan.sources.map((s) => `- ${s.title}: ${s.link}`));
    lines.push("", "Help me carry this out, starting with step 1. Raise the open questions with me when they come up.");
  } else {
    if (quick?.suggestion) lines.push("", `Your first take: ${quick.suggestion}`);
    if (quick?.steps.length) {
      lines.push("", "Steps you said you could do:");
      quick.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
      hasSteps = true;
    }
    lines.push("", "Help me work out the approach and carry it out. Ask me for anything you need.");
  }
  if (task.id && hasSteps) lines.push(...progressInstructions());

  const prompt = lines.join("\n");
  return prompt.length > MAX_PROMPT ? `${prompt.slice(0, MAX_PROMPT - 1)}…` : prompt;
}

/** First line of every session Orb opens; Orb searches transcripts for it. */
export function sessionMarker(taskId: string): string {
  return `Orb task: ${taskId}`;
}

/** Asks the session to report progress, and hand Slack messages to Orb, in lines Orb can parse. */
function progressInstructions(): string[] {
  return [
    "",
    "Report progress so my planner can follow along. On its own line, write:",
    "- `[orb] step N started` when you begin one of the numbered steps above,",
    "- `[orb] step N done` when you finish it, always before you start the next step,",
    "- `[orb] step N waiting: <what you need from me>` when you stop to ask me for something.",
    "- `[orb] step N blocked: <who or what>` when a step can't move until someone else acts,",
    "- `[orb] step N skipped: <why>` when a step turns out not to be needed.",
    "N is the step's number in the list above.",
    "",
    "Don't post to Slack yourself. When a Slack message is ready, hand it to my planner, which shows it to me to review and send. Write it as its own block:",
    "[orb] send step N to <#channel-name, or the permalink of the thread to reply in>",
    "<the message, exactly as it should be posted>",
    "[orb] end",
    "then `[orb] step N waiting: review and send the message` and stop. I'll tell you once it's sent, with its link.",
  ];
}

/** Common opening: the task and its context. */
function taskLines(task: SessionTask): string[] {
  const lines = [`Task: ${task.title}`];
  if (task.projectName) lines.push(`Project: ${task.projectName}`);
  if (task.requester) lines.push(`Requested by: ${task.requester}`);
  if (task.link) lines.push(`Source: ${task.link}`);
  if (task.description) lines.push("", task.description);
  return lines;
}

export interface StartStep {
  title: string;
  /** Who does it; only the user's steps are marked, the rest are Claude's. */
  by: "claude" | "you" | null;
}

/**
 * The prompt behind "Approve & start". The session runs in the background (Orb starts it with
 * `claude -p`), so it works through the plan unattended and stops only when it needs the user,
 * who answers in Orb; Orb continues the session with the answer. Steps marked [Me] are the
 * user's: Claude stops to ask for their result when it needs it.
 */
export function startPrompt(task: SessionTask, suggestion: string, steps: StartStep[]): string {
  const lines = [
    ...(task.id ? [sessionMarker(task.id), ""] : []),
    "I've approved your suggested approach for this task from my day planner. Please carry it out.",
    "",
    ...taskLines(task),
  ];
  lines.push("", `Your suggestion: ${suggestion}`, "", "The plan, in order. Steps marked [Me] are mine; the rest are yours:");
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step.by === "you" ? "[Me] " : ""}${step.title}`));
  if (task.id) lines.push(...progressInstructions());
  lines.push("", ...workInstructions());
  const prompt = lines.join("\n");
  return prompt.length > MAX_PROMPT ? `${prompt.slice(0, MAX_PROMPT - 1)}…` : prompt;
}

/** How a session carries out an approved plan in the background. */
function workInstructions(): string[] {
  return [
    "You're running in the background: I'm not watching this conversation, and my planner tells me when you need me. So keep going on your own through your steps in order, and stop only when you need something from me.",
    "Don't do the steps marked [Me]. When one of your steps depends on an earlier step of mine, prepare everything you can without it, then ask me for that step's result (as a waiting report) and stop.",
    "When you stop for me, put everything I need to answer in the waiting report and the message just before it: the question, the options, and any draft I'm approving, since I'll read it in my planner rather than here. Ask one clear thing at a time.",
    "You can read Slack, email, Google Drive, Jira and the calendar. Don't send email, file tickets or change anything outside this session, and don't make decisions for me; ask me instead. Slack messages go to my planner as described above.",
    "When all your steps are done, write a short summary of what you did and what's left for me.",
  ];
}

/**
 * The prompt behind "Discuss plan": the same session Approve & start would open, but it talks the
 * plan through with the user first and doesn't start the work until they approve it (approvedPlan).
 */
export function discussPrompt(task: SessionTask, suggestion: string, steps: StartStep[]): string {
  const lines = [
    ...(task.id ? [sessionMarker(task.id), ""] : []),
    "Before you start on this task from my day planner, I'd like to talk through your suggested plan with you.",
    "",
    ...taskLines(task),
  ];
  lines.push("", `Your suggestion: ${suggestion}`, "", "The plan, in order. Steps marked [Me] are mine; the rest are yours:");
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step.by === "you" ? "[Me] " : ""}${step.title}`));
  if (task.id) lines.push(...progressInstructions());
  lines.push(
    "",
    "Don't start the work yet. Look things up only as far as you need to answer my questions about the plan.",
    "Open with a short take on the plan, a few sentences, and ask what I'd like to change. Then answer my questions and suggest changes where they'd help.",
    "Whenever we agree a change to the steps (added, dropped, reworded, reordered, or moved between you and me), restate the whole plan as an [orb] plan block, with [Me] in front of my steps, so my planner shows it.",
    "I'll tell you when the plan's agreed and you can start.",
  );
  const prompt = lines.join("\n");
  return prompt.length > MAX_PROMPT ? `${prompt.slice(0, MAX_PROMPT - 1)}…` : prompt;
}

/** What the user's approval says to a session that's been discussing the plan: go, as agreed. */
export function approvedPlanMessage(): string {
  return ["The plan's agreed. Please carry it out now, as we last stated it.", "", ...workInstructions()].join("\n");
}

/** An update from the briefing, as the Explain this chat sees it. */
export interface ExplainedUpdate {
  key: string;
  label: string;
  text: string;
  link?: string | null;
  date?: string | null;
}

/**
 * The prompt behind an update's "Explain this": a session that reads where the update came from and
 * explains it plainly, then answers follow-up questions in the same chat.
 */
export function explainPrompt(u: ExplainedUpdate): string {
  return [
    sessionMarker(u.key),
    "",
    "Explain this update from my day planner's briefing to me.",
    "",
    `From: ${u.label}${u.date ? ` (${u.date})` : ""}`,
    `Update: ${u.text}`,
    ...(u.link ? [`Source: ${u.link}`] : []),
    "",
    "Read the source first (the Slack thread, ticket or doc, and anything it links to that you need) so you explain what actually happened, not just the summary.",
    "Then tell me, briefly: what happened, why it matters to me and my projects, and whether there's anything I should do about it (and if so, what). If nothing's needed from me, say so.",
    "Don't send, post or change anything. I may have follow-up questions; answer them in the same plain way.",
  ].join("\n");
}

/** A message waiting on a reply, as the reply chat sees it. */
export interface ReplyTopic {
  id: string;
  source: "slack" | "email";
  from: string;
  summary: string;
  where?: string | null;
  received?: string | null;
  link?: string | null;
}

/**
 * The prompt behind an inbox item's "Draft response": a chat that reads the message, drafts a reply
 * in the user's voice and refines it with them. A Slack reply is handed to the planner to send
 * (reviewed and posted from there); an email reply is left in the chat to copy.
 */
export function replyPrompt(r: ReplyTopic): string {
  const kind = r.source === "slack" ? "Slack message" : "email";
  return [
    sessionMarker(r.id),
    "",
    `Help me reply to this ${kind}.`,
    "",
    `From: ${r.from}`,
    ...(r.where ? [`Where: ${r.where}`] : []),
    ...(r.received ? [`Sent: ${r.received}`] : []),
    `What they asked: ${r.summary}`,
    ...(r.link ? [`Link: ${r.link}`] : []),
    "",
    `Read the ${r.source === "slack" ? "thread" : "email thread"} first, and look at a few of my own recent messages there to match my tone and length.`,
    "Then propose a short reply in my voice, as I'd send it, and ask whether I'd like anything changed. Where it depends on something only I know, ask me rather than guessing.",
    r.source === "slack"
      ? `When I'm happy with it, hand it to my planner to send as a reply in the thread: a line \`[orb] send to ${r.link ?? "<the message's permalink>"}\`, the reply exactly as it should be posted, then a line \`[orb] end\`. Don't send anything yourself.`
      : "When I'm happy with it, give me the final text on its own so I can copy it into my reply. Don't send anything.",
  ].join("\n");
}

/** A link that opens a new Claude Code session in Claude Desktop with `prompt` filled in (not sent). */
export function claudeSessionUrl(prompt: string, folder?: string | null): string {
  const params = new URLSearchParams({ q: prompt });
  if (folder) params.set("folder", folder);
  // URLSearchParams encodes spaces as "+"; use %20 so the prompt reads back exactly.
  return `claude://code/new?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * A link that reopens an existing Claude Code session in Claude Desktop, by the
 * session id in its transcript's file name. Desktop may open it as a new tab
 * continuing the same conversation.
 */
export function resumeSessionUrl(sessionId: string): string {
  return `claude://resume?session=${encodeURIComponent(sessionId)}`;
}
