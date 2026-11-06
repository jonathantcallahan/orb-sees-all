import { actionLine, WATCH_CHAT } from "./watched";
import { SAME_WORK_RULE, STEP_RULE, TITLE_RULE } from "./baseLessons";
import type { TaskPlan } from "./schema";

/** Claude Desktop truncates prefilled prompts at about 14,000 characters. */
const MAX_PROMPT = 13_500;

export interface SessionTask {
  /** Orb's id for the task; the session carries it so Orb can find the session and follow its progress. */
  id?: string;
  title: string;
  description?: string | null;
  /** The user's own note on the task as they typed it, when its title was written from it. */
  brief?: string | null;
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
  if (task.brief) lines.push("", `My own note on it, as I wrote it: ${task.brief}`);

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

/**
 * A note for a chat that began as something else (a Draft response, an Explain) and is now a task's
 * chat in the planner: the task's numbered steps and how to report them, so the card follows its
 * progress. Added to the user's next message as an Orb note (the chat doesn't show it).
 */
export function adoptAsTaskNote(title: string, steps: string[]): string {
  return [
    `(From Orb: this chat is now the task "${title}" in my planner.`,
    ...(steps.length ? ["Its steps, numbered as I track them:", ...steps.map((st, i) => `${i + 1}. ${st}`)] : []),
    ...progressInstructions(),
    "Report where each step stands now (done, skipped or waiting), revising the plan if this conversation changed it, then answer my message.)",
  ].join("\n");
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
    "[orb] send step N to <#channel-name, @person for a DM (their Slack user ID, like @U0123ABCD, when you know it, else their full name), or the permalink of the thread to reply in>",
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
  if (task.brief) lines.push("", `My own note on it, as I wrote it: ${task.brief}`);
  return lines;
}

export interface StartStep {
  title: string;
  /** Who does it; only the user's steps are marked, the rest are Claude's. */
  by: "claude" | "you" | null;
}

/** How a session carries out the plan once the user tells it to go ahead. */
function workInstructions(): string[] {
  return [
    "Once you've started, keep going on your own through your steps in order, and stop only when you need something from me. I may not be watching this chat: my planner tells me when you need me.",
    "Don't do the steps marked [Me]. When one of your steps depends on an earlier step of mine, prepare everything you can without it, then ask me for that step's result (as a waiting report) and stop.",
    "When you stop for me, put everything I need to answer in the waiting report and the message just before it: the question, the options, and any draft I'm approving, since I may read it in my planner rather than here. Ask one clear thing at a time.",
    "You can read Slack, email, Google Drive, Jira and the calendar. Don't send email or change anything outside this session yourself, and don't make decisions for me; ask me instead. Slack messages, docs, invites and Jira tickets go to my planner to review and send or create, as described above.",
    "When all your steps are done, write a short summary of what you did and what's left for me.",
  ];
}

/**
 * The prompt behind a task's "Open in chat": the session talks the plan through with the user
 * first, then carries it out once they tell it to go ahead in the chat. Throughout, the steps on
 * the card follow the chat: the session restates the plan whenever what's agreed changes it.
 */
/**
 * The opening of a task's chat. With `firstMessage` (the chat starts when you send your first
 * message, never just by opening it), Claude answers that first; it's quoted last, so the chat shows
 * it as your message.
 */
export function taskChatPrompt(task: SessionTask, suggestion: string, steps: StartStep[], firstMessage?: string): string {
  const lines = [
    ...(task.id ? [sessionMarker(task.id), ""] : []),
    "I'd like to work through this task from my day planner with you, here in its chat.",
    "",
    ...taskLines(task),
  ];
  if (suggestion.trim()) lines.push("", `Your suggestion: ${suggestion}`);
  if (steps.length) {
    lines.push("", "The plan, in order. Steps marked [Me] are mine; the rest are yours:");
    steps.forEach((step, i) => lines.push(`${i + 1}. ${step.by === "you" ? "[Me] " : ""}${step.title}`));
  } else {
    lines.push("", "There's no plan for it yet. Start by asking me whether I'd like you to plan the steps. If I do, work them out with me: the steps, and which are mine and which are yours.");
  }
  if (task.id) lines.push(...progressInstructions());
  lines.push(
    "",
    firstMessage?.trim()
      ? "Talk the plan through with me first: answer my message below. Until I tell you to go ahead, look things up only as far as you need to answer my questions about the plan, and don't start the steps."
      : "Talk the plan through with me first. Open with a short take on it, a few sentences, and ask what I'd like to change. Until I tell you to go ahead, look things up only as far as you need to answer my questions about the plan, and don't start the steps.",
    // Without a task, there's no planner following along (and no [orb] reports).
    ...(task.id
      ? [
          "The steps in my planner follow this chat, so keep them current. Whenever what we agree changes the work, restate the whole plan as an [orb] plan block, finished steps included, with [Me] in front of my steps. " + STEP_RULE + " Shorten any longer steps when you restate them. That's any step added, dropped, reworded, reordered or moved between you and me, and anything I ask for that the steps don't cover yet (another analysis, a further check, a change to a draft), which is a new step. It holds after you've started too, and when I tell you to go ahead and add something in the same message: restate the plan first, then carry on and number your reports against it.",
        ]
      : []),
    "When I tell you to go ahead, carry out the plan as we last stated it.",
    ...workInstructions(),
  );
  // Your message goes last, whole, however long the rest is.
  const mine = firstMessage?.trim() ? `\nMy message: ${firstMessage.trim()}` : "";
  const room = Math.max(1000, MAX_PROMPT - mine.length);
  const prompt = lines.join("\n");
  return (prompt.length > room ? `${prompt.slice(0, room - 1)}…` : prompt) + mine;
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

/** A chat about a watched topic: where it stands, read from the sources, then the user's questions. */
export function watchChatPrompt(t: {
  id: string;
  topic: string;
  details: string | null;
  status: { summary: string; links: { link: string }[] } | null;
  projectName?: string | null;
  outcomes: { when: "happens" | "not_by"; event: string; by: string | null; then: string }[];
}): string {
  return [
    sessionMarker(`${WATCH_CHAT}${t.id}`),
    "",
    `I'm keeping an eye on this in my day planner, and want to talk about it: ${t.topic}`,
    ...(t.projectName ? [`It's part of my project "${t.projectName}".`] : []),
    ...(t.details?.trim() ? [`What I wrote about it: ${t.details.trim()}`] : []),
    ...(t.status ? [`Where my planner last found it stands: ${t.status.summary}`, ...t.status.links.map((l) => `Source: ${l.link}`)] : []),
    ...(t.outcomes.length
      ? ["", "What my planner does about it, its conditional actions:", ...t.outcomes.map((o, i) => `${i + 1}. ${actionLine(o)}`)]
      : ["", "It has no conditional actions yet: my planner just keeps track of where it stands."]),
    "",
    "Read the latest on it first (the Slack threads, emails or tickets about it), then tell me briefly where it stands now and whether anything needs me. If nothing does, say so.",
    "If I ask to add, change or remove a conditional action, agree it with me, then write the whole new list on its own lines between `[orb] plan` and `[orb] end`, one action per numbered line in exactly the form above: `If <what happens> | hasn't happened by YYYY-MM-DD | then <what to do>`, or `If <what happens> | has happened | then <what to do>`. What to do becomes a task, so write it as a task title: ${TITLE_RULE} My planner takes that list as the topic's conditional actions and hides the block from our chat, so also tell me in a sentence what you changed. Leave out the block when nothing changes.",
    "Don't send, post or change anything. I may have follow-up questions; answer them in the same plain way.",
  ].join("\n");
}

/**
 * The changes Demian can make to itself, as the JSON a chat (or a #demian message) proposes; one list,
 * so the global chat and the DM can't drift apart. See GlobalAction and globalActions.ts.
 */
export const GLOBAL_ACTION_DOCS = [
  '- {"type": "create_project", "name": "Store assets", "channels": [{"channel_id": "C123", "name": "store-assets"}], "reason": "why it\'s a project"}: a project the planner is missing. Find its channels in Slack first; the first is its main channel.',
  '- {"type": "split_project", "project_id": "C111", "new_name": "Store assets", "channel_ids": ["C222"], "reason": "..."}: moves those channels out of a project into a new one. A project\'s own id (its main channel) can\'t move.',
  '- {"type": "merge_projects", "from_id": "C111", "into_id": "C222"}',
  '- {"type": "rename_project", "project_id": "C111", "name": "..."}',
  '- {"type": "set_project_tracking", "project_id": "C111", "tracked": true}: put a project on the board or take it off.',
  '- {"type": "add_project_context", "project_id": "C111", "entries": ["one plain statement about it", "Not part of it: …"]}: adds to the project\'s context, which every refresh keeps to. Use it when I say what a project is or isn\'t about, or anything else that should shape how it\'s read.',
  '- {"type": "add_project_repos", "project_id": "C111", "github": ["owner/name"], "local": ["/Users/me/code/repo"]}: where a project\'s code lives, so plans and chats can read it. Offer it when a question needs the code and the project has no repos listed.',
  '- {"type": "remove_project_context", "project_id": "C111", "entries": ["the entry, as listed"]}: takes entries out of a project\'s context; refreshes leave them out.',
  '- {"type": "set_project_status", "project_id": "C111", "status": "blocked" | "at_risk" | "on_track" | "idle" | "auto", "reason": "why, in my words"}: sets the status the board shows; refreshes keep to it unless something clearly changes. "auto" hands it back to refreshes.',
  '- {"type": "resolve_project_item", "project_id": "C111", "item_id": "<id of an open blocker or active item>", "what": "<what it is>"}: marks it done, as its Mark done does.',
  '- {"type": "check_project_item", "project_id": "C111", "item_id": "...", "what": "..."}: has Claude double-check whether a blocker or active item is still real, as its Double check does.',
  '- {"type": "unlink_channel", "project_id": "C111", "channel_id": "C222"}: unlinks one of a project\'s linked channels (not its main one).',
  '- {"type": "add_note", "text": "..."}: a standing correction or piece of context every refresh will take into account (e.g. "Refunds is paused until Q3; don\'t treat it as at risk"). Write it as a plain fact about my work.',
  '- {"type": "update_profile", "text": "..."}: replaces the one- or two-sentence description of me.',
  '- {"type": "add_task", "title": "...", "project_id": "C111" or null, "description": "<what you found, with links>" or null, "today": true or null, "status": "in_progress" or null, "priority": "high" or null}: a new task of my own. A new task has no id until it\'s applied, so set Today, status and priority here, in the same card, rather than in separate ones. Its title: ' + TITLE_RULE + ' Before adding one, look through my open tasks for the same piece of work. ' + SAME_WORK_RULE + ' If there is one, use add_task_context, plan_today or set_task_status on it instead of adding a second.',
  '- {"type": "add_task_context", "task_id": "<id from my task list>", "title": "<its title>", "text": "..."}: adds what I said to the end of an existing task\'s description (details, links, who\'s involved), so its plan and chat take it into account.',
  '- {"type": "watch_topic", "text": "<in my words: what to follow, and what to do if it happens or doesn\'t by a date>"}: something to keep an eye on rather than do now. My planner adds it to Watched topics, works out its title, project and conditional actions from the text, and checks it every refresh.',
  '- {"type": "plan_today", "task_id": "<id from my task list>", "title": "<its title>", "today": true}: put one of my existing tasks in Today\'s tasks (today false takes it off). When I ask whether I have a task about something, find it in my task list (match on meaning, not just words), tell me which, and propose this if I want it today.',
  '- {"type": "update_task", "task_id": "<id from my task list>", "title": "<its title now>", "new_title": "..." or null, "description": "..." or null}: renames or rewrites one of my own tasks (ids starting "manual:") when what it\'s about has changed. Use it rather than adding a second task for the same piece of work. Its new title: ' + TITLE_RULE + ' For tasks from Slack, email or a project, use add_task_context instead.',
  '- {"type": "set_task_project", "task_id": "<id from my task list>", "title": "<its title>", "project_id": "C111" or null}: files a task under another project, when it belongs to a different one than it shows; null takes one of my own out of its project. Use it whenever I say a task is for a different project: never make a copy and mark the original done.',
  '- {"type": "set_task_plan", "task_id": "<id from my task list>", "title": "<its title>", "steps": [{"title": "...", "by": "claude" | "you"}]}: replaces the task\'s plan with these steps, in order, finished ones included, "you" for mine. ' + STEP_RULE + ' Use it when I ask to change or adjust a task\'s plan. If the task has its own chat, my planner passes the plan to it.',
  '- {"type": "set_task_status", "task_id": "...", "title": "...", "status": "todo" | "in_progress" | "waiting" | "blocked" | "done"}: "blocked" when it can\'t move until someone else acts (an answer, an approval); "waiting" when it\'s waiting on me.',
  '- {"type": "set_task_priority", "task_id": "...", "title": "...", "priority": "critical" | "high" | "medium" | "low"}',
  '- {"type": "refresh", "what": "all" | "project" | "briefing" | "calendar" | "tasks", "project_id": "C111" or null}: rereads something.',
].join("\n");

/**
 * How the Demian chat changes existing tasks. In its opening prompt and, with the list of changes,
 * on every turn, so a chat that's been open a while knows the current ones.
 */
export const GLOBAL_TASK_RULES = [
  "When I talk about a task I'm looking at, find it by what I describe (in Today's tasks, its project, its steps), and trust what I say about it. If I say it belongs to a different project or is about something other than its title says, change that task (set_task_project, update_task, add_task_context): don't point me to a different task, and don't take my words as a sign it's a duplicate. Only mark a task done when I've said it's done. If two tasks could fit what I describe, name both and ask which, without proposing changes yet.",
  "My task list is current every turn, and includes the tasks you added through cards I applied (their ids are also among the applied changes). When I mention a task, find it there, matching on meaning, before saying it isn't there. Never ask me whether I applied a card, or to send another message so you can see the list. Propose one card per change, not alternatives depending on what I did.",
  "To change an existing task, change that task rather than adding another: update_task when one of my own tasks is now about something different, add_task_context for more detail, set_task_status (blocked when someone else has to act first), set_task_plan for its steps.",
  "Give each task change its task_id from the list and its exact title. If you truly can't find the id, give the exact title and leave task_id out: my planner finds the task by its title.",
  "This chat has no plan or steps of its own, so don't write [orb] plan or [orb] step lines here. A task's plan changes through set_task_plan.",
].join("\n");

/**
 * The opening of a global chat: the user's first message, and how Claude helps them fix the planner
 * itself. Changes go to the planner as "[orb] action" blocks, which the user applies one by one.
 */
export function globalChatPrompt(key: string, firstMessage: string): string {
  return [
    sessionMarker(key),
    "",
    "You're the assistant inside my day planner, Demian. It reads my Slack, email, calendar and Jira, and shows my projects, tasks, inbox and a daily briefing. I'm talking to you about the planner itself: something it has wrong or is missing, or something I want it to do.",
    "Each turn, my planner tells you what it currently shows (my projects with their ids and channels, today's briefing, my tasks, and what you already know about me). Use those ids.",
    "Read Slack, email, the calendar, Jira and Drive when you need to check something or find what I mean (a channel for a project, who's involved), but keep it brief.",
    "You can't change the planner yourself. Propose each change as its own block, which the planner shows me as a card to apply or turn down:",
    "[orb] action",
    '{"type": "...", ...}',
    "[orb] end",
    "The changes you can propose, as JSON:",
    GLOBAL_ACTION_DOCS,
    GLOBAL_TASK_RULES,
    "Propose only changes I asked for or would clearly want, and say in a sentence what each does. Don't assume a change happened until my planner lists it as applied. If what I mean is unclear, ask.",
    `My message: ${firstMessage}`,
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
