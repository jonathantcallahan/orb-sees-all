import { projectsOn, tasksOn, updatesOn, watchedTopicsOn } from "./features";
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
/** The changes the Demian chat can propose, one per line after the first (see globalActionDocs). */
const ACTION_DOC_LINES = [
  "A project is the planner's own record of a body of work: its purpose, people, path to ship, context and tasks. Its Slack channels and Jira epics are only sources it reads. Any of them can be linked to it, moved to another project, shared by several projects, or unlinked, its first or main channel included, and the project and its record stay. A project id is just an id (\"p:…\", or for older projects a channel id or \"jira:…\"), never a channel to read.",
  '- {"type": "create_project", "name": "Store assets", "channels": [{"channel_id": "C123", "name": "store-assets"}], "epics": ["ABC-123"], "reason": "why it\'s a project"}: a project the planner is missing. Find its Slack channels and its Jira epics first (either can be empty: a project can have only epics, only channels, or neither yet); the first channel is its main one, where reminders go.',
  '- {"type": "split_project", "project_id": "p:1a2b3c", "new_name": "Store assets", "channel_ids": ["C222"], "epic_keys": ["ABC-12"], "shared_channel_ids": ["C333"], "reason": "..."}: splits part of a project off into a new one. The channels and epics listed move to it (any of them, its main channel too); shared channels stay with this project and both read them, which is how two projects that grew up in one channel come apart. Each list can be empty, but something must move or be shared. Both records note the split.',
  '- {"type": "merge_projects", "from_id": "C111", "into_id": "C222"}',
  '- {"type": "rename_project", "project_id": "C111", "name": "..."}',
  '- {"type": "set_project_tracking", "project_id": "C111", "tracked": true}: put a project on the board or take it off.',
  '- {"type": "add_project_context", "project_id": "C111", "entries": ["one plain statement about it", "Not part of it: …"]}: adds to the project\'s context, which every refresh keeps to. Use it when I say what a project is or isn\'t about, or anything else that should shape how it\'s read.',
  '- {"type": "add_project_repos", "project_id": "C111", "github": ["owner/name"], "local": ["/Users/me/code/repo"]}: where a project\'s code lives, so plans and chats can read it. Offer it when a question needs the code and the project has no repos listed.',
  '- {"type": "remove_project_context", "project_id": "C111", "entries": ["the entry, as listed"]}: takes entries out of a project\'s context; refreshes leave them out.',
  '- {"type": "set_project_status", "project_id": "C111", "status": "blocked" | "at_risk" | "on_track" | "idle" | "auto", "reason": "why, in my words"}: sets the status the board shows; refreshes keep to it unless something clearly changes. "auto" hands it back to refreshes.',
  '- {"type": "set_project_kind", "project_id": "C111", "kind": "project" | "workstream" | "auto"}: a project is a body of work with a beginning and an end, and needs a requirements doc; a workstream is an ongoing initiative. "auto" hands it back to refreshes.',
  '- {"type": "set_project_doc", "project_id": "C111", "link": "https://docs.google.com/document/d/…", "title": "the doc\'s title"}: links the doc that sets out a project\'s requirements (a TDD or a detailed PRD); its requirements are read and their progress tracked. A null link removes it.',
  '- {"type": "resolve_project_item", "project_id": "C111", "item_id": "<id of an open blocker or active item>", "what": "<what it is>"}: marks it done, as its Mark done does.',
  '- {"type": "check_project_item", "project_id": "C111", "item_id": "...", "what": "..."}: has Claude double-check whether a blocker or active item is still real, as its Double check does.',
  '- {"type": "unlink_channel", "project_id": "C111", "channel_id": "C222"}: unlinks one of a project\'s channels (its main one too; another takes over), or one it shares with another project.',
  '- {"type": "link_project_epic", "project_id": "C111", "epic_key": "ABC-123"}: links a Jira epic to a project, so its issues are read as the project\'s plan of record; an epic linked to another project moves to this one.',
  '- {"type": "unlink_project_epic", "project_id": "C111", "epic_key": "ABC-123"}: unlinks an epic from a project; refreshes and discovery leave it alone after.',
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
];

/** The changes about projects, left out while Projects is off (see features). */
export const PROJECT_ACTIONS: ReadonlySet<string> = new Set([
  "create_project",
  "split_project",
  "merge_projects",
  "rename_project",
  "set_project_tracking",
  "add_project_context",
  "add_project_repos",
  "remove_project_context",
  "set_project_status",
  "set_project_kind",
  "set_project_doc",
  "resolve_project_item",
  "check_project_item",
  "unlink_channel",
  "link_project_epic",
  "unlink_project_epic",
  "set_task_project",
]);

/**
 * The changes to tasks, left out while Tasks is off (see features): there's no list to put them in.
 * set_task_project is about projects too.
 */
export const TASK_ACTIONS: ReadonlySet<string> = new Set(["add_task", "add_task_context", "update_task", "plan_today", "set_task_plan", "set_task_status", "set_task_priority", "set_task_project"]);

/**
 * Refresh's change, offering only what's on to reread: a project's in Projects, the briefing's in
 * Updates, and "tasks" reads Slack and email for Tasks and for Updates' inbox and news.
 */
function refreshDoc(projects: boolean, updates: boolean, tasks: boolean): string {
  const what = ["all", ...(projects ? ["project"] : []), ...(updates ? ["briefing"] : []), "calendar", ...(tasks || updates ? ["tasks"] : [])].map((w) => `"${w}"`).join(" | ");
  return `- {"type": "refresh", "what": ${what}${projects ? ', "project_id": "C111" or null' : ""}}: rereads something.`;
}

/**
 * The changes the Demian chat (and a #demian message) can propose: all of them, except watching a
 * topic while Watched topics is off, anything about projects while Projects is off, and changes to
 * tasks while Tasks is off (see features).
 */
export function globalActionDocs(watched = watchedTopicsOn(), projects = projectsOn(), updates = updatesOn(), tasks = tasksOn()): string {
  return ACTION_DOC_LINES.filter((line) => {
    const type = /"type": "([a-z_]+)"/.exec(line)?.[1];
    if (type === "watch_topic") return watched;
    if (!tasks && type && TASK_ACTIONS.has(type)) return false;
    // Projects off: the changes about projects, and what a project is (the one line that isn't a change).
    return projects || (!!type && !PROJECT_ACTIONS.has(type));
  })
    .map((line) => (line.includes('"type": "refresh"') ? refreshDoc(projects, updates, tasks) : line))
    .join("\n");
}

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

/** The task rules while Tasks is on; while it's off, that there's no task list to change. */
export function globalTaskRules(tasks = tasksOn()): string {
  return tasks
    ? GLOBAL_TASK_RULES
    : "Tasks is off in my planner, so there's no task list: don't propose adding or changing tasks. If I ask for one, say Tasks is off and can be turned on in Settings.";
}

/**
 * The opening of a global chat: the user's first message, and how Claude helps them fix the planner
 * itself. Changes go to the planner as "[orb] action" blocks, which the user applies one by one.
 */
/**
 * Which version of the changes the Demian chat can propose: a short hash of their docs, so a chat
 * begun with an older list is given the current one (see runTaskSession).
 */
export function actionDocsVersion(): string {
  const text = `${globalActionDocs()}\n${globalTaskRules()}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Whether a Demian chat began with an older list of the changes it can propose (or before the
 * planner noted which list it began with), so each of its turns needs the current one.
 */
export function hasOldActionDocs(link: { openedDocs?: string } | undefined): boolean {
  return link?.openedDocs !== actionDocsVersion();
}

/** The changes the Demian chat can propose, given to a chat that began with an older list. */
export function updatedActionDocs(): string {
  return [
    "The changes you can propose have changed since this chat began. This list replaces the one in the chat's first message: go by it alone. Don't rely on what the old list said a change can or can't do, or on anything said earlier in this chat about what the planner can't do; check it against this list again.",
    globalActionDocs(),
    globalTaskRules(),
  ].join("\n");
}

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
    globalActionDocs(),
    globalTaskRules(),
    "Propose only changes I asked for or would clearly want, and say in a sentence what each does. Don't assume a change happened until my planner lists it as applied. If what I mean is unclear, ask.",
    `My message: ${firstMessage}`,
  ].join("\n");
}

/**
 * The opening prompt of a project's chat (see projectChat.ts): the Demian chat, centered on one
 * project, which its record (told each turn) lets it answer about and change.
 */
export function projectChatPrompt(key: string, project: { name: string; id: string }, firstMessage: string): string {
  return [
    sessionMarker(key),
    "",
    `You're the assistant inside my day planner, Demian. I'm talking to you about one of my projects, ${project.name} [id ${project.id}]: what it's for, where it stands, its people, its plan of work, and the work itself.`,
    "Each turn, my planner tells you the project's record as it shows it now (its purpose, status, people, plan of work with the requirements and pull requests under what they're for, milestones, decisions and links), along with everything else it shows. Answer from that first. Read Slack, email, the calendar, Jira, Drive and the project's code when you need more, but keep it brief.",
    "You can't change the planner yourself. Propose each change as its own block, which the planner shows me as a card to apply or turn down:",
    "[orb] action",
    '{"type": "...", ...}',
    "[orb] end",
    "The changes you can propose, as JSON:",
    globalActionDocs(),
    globalTaskRules(),
    "Changes in Jira itself (creating epics, stories and tasks, or moving them) are made from the project's Work, full screen, where I review each one: point me there instead of proposing them.",
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

/** What the TDD chat is told about the project whose draft it works on. */
export interface TddChatTopic {
  /** The chat's key (see tddChatKey). */
  key: string;
  name: string;
  purpose: string | null;
  epics: { key: string; title: string }[];
  channels: { channel_id: string; name: string }[];
  /** What the draft was written from. */
  sources: { title: string; link: string }[];
}

/**
 * How the TDD chat works on the draft, said with every turn whose file or rules changed (it's the
 * planner's part of the chat's context): the file to edit, and only that file.
 */
export function tddChatNote(path: string): string {
  return [
    `The TDD draft is the Markdown file ${path}. It's the only file you may change.`,
    "Make the changes I ask for in that file with Edit (Write only to rewrite it whole), keeping its layout and plain style and leaving alone what I didn't ask about. Read it again before you edit: I sometimes change it myself between messages.",
    "Check facts against the sources, not memory: the epics' tickets in Jira, the project's Slack channels, docs in Drive and meetings in Granola. Never invent APIs, tables, numbers, dates or owners; what isn't decided goes in as \"Open question: …\", naming who would know, and every fact you add links its source.",
    "After a change, reply in a sentence or two saying what you changed and where. Don't paste the doc or its sections into the chat: I see the file. When I only ask a question, answer it without editing.",
    "Don't create the doc in Drive, write an [orb] doc block, or post, send or change anything anywhere else: I create the doc from my planner once I'm happy with it.",
  ].join("\n");
}

/**
 * The opening prompt of a TDD draft's chat, started by the user's first message: Claude works on
 * the draft's file with them (see tddChatNote, which its context carries).
 */
export function tddChatPrompt(t: TddChatTopic, firstMessage: string): string {
  return [
    sessionMarker(t.key),
    "",
    `You drafted a technical design doc (TDD) for my project "${t.name}". I'm reviewing it before I create it in my Google Drive, where it becomes the project's requirements doc, and I'd like your help changing it. Read the draft's file (named below) before anything else.`,
    "",
    ...(t.purpose ? [`Purpose: ${t.purpose}`] : []),
    t.epics.length ? `Jira epics: ${t.epics.map((e) => `${e.key} "${e.title}"`).join(", ")}` : "It has no Jira epics linked.",
    t.channels.length ? `Slack channels: ${t.channels.map((c) => `#${c.name} (${c.channel_id})`).join(", ")}` : "It has no Slack channel: search Slack for its name.",
    ...(t.sources.length ? ["The draft was written from:", ...t.sources.map((s) => `- ${s.title}: ${s.link}`)] : []),
    "",
    "Reply in plain sentences, without headings.",
    // Shown in the chat as just these words (see readableMessages).
    `My message: ${firstMessage.trim()}`,
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
