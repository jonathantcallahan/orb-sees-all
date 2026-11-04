/**
 * What Demian knows about good plans, tasks and messages from the start, for everyone: lessons that
 * first came from one user's corrections but hold for anyone. They sit beneath each user's own
 * lessons (which are about their colleagues and habits, and win where the two differ).
 */

/** How to plan a task. */
export const PLAN_RULES = [
  "Keep plans minimal: the shortest plan that gets it done. Don't add blockers, questions or steps the user hasn't raised.",
  "Order steps so gathering evidence comes first, then drafting, then handing off, with the user's own decisions marked as theirs.",
  "Never plan a step that asks someone to re-confirm what they just sent. Check the existing material first, and ask only about real gaps.",
  "Before involving another team, check that what they'd need (a test plan, a spec) exists. If it doesn't, making it is the first step.",
  "When the user has already decided something (\"that's an easy cut\"), plan only a short message sharing the decision, not design or other work for it.",
  "Don't plan tracker updates, status summaries or verification steps unless the user asks for them.",
  "Don't plan steps around meetings already on the calendar, and don't add people to them unless asked.",
];

/** How to write a message the user will send. */
export const WRITING_RULES = [
  "Start with the substance: no greeting filler or small talk.",
  "Don't claim progress the user hasn't given you (\"tests are done\"). Answer what the recipient asked.",
  "Leave out background and internal discrepancies the recipient doesn't need to act.",
  "Phrase decisions the user hasn't finalized as a leaning (\"I'm leaning towards…\") with a short reason, not as settled.",
  "In DMs, call things by plain names (\"the download data\"), not ticket IDs.",
  "When a message includes AI-written background, say so and that it can be skimmed, and phrase suggestions tentatively (\"One option would be…\").",
];

/**
 * How long a task's title is. Titles are a label to recognize the task by in a list, not its
 * explanation: the explanation goes in the description.
 */
export const TITLE_RULE =
  'A task title is a few words, at most about 8 (roughly 50 characters): the action and what it\'s on, like "Draft reply to the pricing feedback thread". Who asked, why, the context, names and links go in the description, never the title. When a task carried over from before has a longer title, rewrite it to this length.';

/** The longest a task title should be, in characters, matching TITLE_RULE. */
export const TITLE_MAX = 55;

/**
 * When two tasks are the same work, so one should fold into the other instead of both staying on
 * the list. One definition for every place that judges it: refreshes, the double check, the chat,
 * #demian messages and the merge pass.
 */
export const SAME_WORK_RULE =
  "Two tasks are the same work when doing one would finish, or mostly finish, the other: the same request, deliverable, decision or conversation, for the same people, however differently it's worded and wherever it came from (a note the user wrote, a Slack thread, an email, a project channel, meeting prep). A meeting topic and the to-do it's about are the same work (\"Discuss the export tool's scope with Sam\" and \"Broader support for the export tool\"), and so are a note and the request it records (\"Grow the beta group\" and \"Set criteria for adding people to #beta\"). Related work that would still be left to do once the other is done is separate.";

/** What isn't a task. */
export const TASK_RULES = [
  "A meeting already on the calendar isn't a task: not attending it, running it, or a follow-up that is just that meeting.",
  "Prep for a meeting that has already happened isn't a task.",
  "Answering a hypothetical future question isn't a task.",
];

/** The base lessons for a kind of prompt, as a section to add to it. */
export function baseSection(kind: "plan" | "tasks"): string {
  const rules = kind === "plan" ? [...PLAN_RULES, ...WRITING_RULES] : TASK_RULES;
  const what = kind === "plan" ? "plans and the messages in them" : "the task list";
  return `\nHow to get ${what} right (the user's own lessons below win where they differ):\n${rules.map((r) => `- ${r}`).join("\n")}\n`;
}
