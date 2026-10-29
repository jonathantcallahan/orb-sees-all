import type { TaskPlan } from "./schema";

/** Claude Desktop truncates prefilled prompts at about 14,000 characters. */
const MAX_PROMPT = 13_500;

export interface SessionTask {
  title: string;
  description?: string | null;
  link?: string | null;
  requester?: string | null;
  projectName?: string | null;
}

/** A self-contained prompt for a new Claude Code session: the task and the plan Claude proposed for it. */
export function sessionPrompt(task: SessionTask, plan: TaskPlan): string {
  const lines = ["I'm working on this task from my day planner and want your help getting it done.", "", `Task: ${task.title}`];
  if (task.projectName) lines.push(`Project: ${task.projectName}`);
  if (task.requester) lines.push(`Requested by: ${task.requester}`);
  if (task.link) lines.push(`Source: ${task.link}`);
  if (task.description) lines.push("", task.description);

  lines.push("", "Here's the plan you proposed earlier:", "", `Approach: ${plan.approach}`, "", "Steps:");
  plan.steps.forEach((step, i) => {
    const detail = [step.detail, step.link].filter(Boolean).join(" ");
    lines.push(`${i + 1}. ${step.title}${detail ? ` (${detail})` : ""}`);
  });
  if (plan.open_questions.length) lines.push("", "Open questions:", ...plan.open_questions.map((q) => `- ${q}`));
  if (plan.sources.length) lines.push("", "Sources:", ...plan.sources.map((s) => `- ${s.title}: ${s.link}`));
  lines.push("", "Help me carry this out, starting with step 1. Raise the open questions with me when they come up.");

  const prompt = lines.join("\n");
  return prompt.length > MAX_PROMPT ? `${prompt.slice(0, MAX_PROMPT - 1)}…` : prompt;
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
 * The prompt behind "Approve & start": the whole plan in order, with the user's
 * steps marked. Claude does only its own steps, and stops to ask for
 * the result of any earlier step of the user's that it depends on.
 */
export function startPrompt(task: SessionTask, suggestion: string, steps: StartStep[]): string {
  const lines = ["I've approved your suggested approach for this task from my day planner. Please start on it.", "", ...taskLines(task)];
  lines.push("", `Your suggestion: ${suggestion}`, "", "The plan, in order. Steps marked [Me] are mine; the rest are yours:");
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step.by === "you" ? "[Me] " : ""}${step.title}`));
  lines.push(
    "",
    "Do your steps in order. Don't do the steps marked [Me].",
    "When one of your steps depends on an earlier step of mine, prepare everything you can without it, then stop and ask me for that step's result before going on. If you can't tell whether I've done a step of mine yet, ask.",
    "Show me the results of each of your steps to review. You can post in Slack and follow up with people there, but show me each message and where it's going, and wait for my OK before posting. Don't send email, file tickets or change anything else outside this session, and don't make decisions for me; ask me instead.",
  );
  const prompt = lines.join("\n");
  return prompt.length > MAX_PROMPT ? `${prompt.slice(0, MAX_PROMPT - 1)}…` : prompt;
}

/** A link that opens a new Claude Code session in Claude Desktop with `prompt` filled in (not sent). */
export function claudeSessionUrl(prompt: string, folder?: string | null): string {
  const params = new URLSearchParams({ q: prompt });
  if (folder) params.set("folder", folder);
  // URLSearchParams encodes spaces as "+"; use %20 so the prompt reads back exactly.
  return `claude://code/new?${params.toString().replace(/\+/g, "%20")}`;
}
