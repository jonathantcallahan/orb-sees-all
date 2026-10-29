import type { Assessment, FollowUp, TaskPlan } from "./schema";

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

/**
 * The prompt behind "Approve & start": the user has approved Claude's
 * suggested approach and next action, and wants Claude to begin on it.
 */
export function startPrompt(task: SessionTask, assessment: Assessment, next: FollowUp | null, plan: TaskPlan | null): string {
  const lines = ["I've approved your suggested approach for this task from my day planner. Please start on it.", "", ...taskLines(task)];
  lines.push("", `Your suggestion: ${assessment.suggestion}`);
  if (next) lines.push(`Next action (${next.kind}): ${next.action}`);
  if (plan) {
    lines.push("", `Plan: ${plan.approach}`);
    plan.steps.forEach((step, i) => lines.push(`${i + 1}. ${step.title}${step.detail ? ` (${step.detail})` : ""}`));
  }
  lines.push(
    "",
    `Begin with ${next ? "the next action" : "the first concrete step"} and take it as far as you can: research, draft, write up. Show me the result to review. Don't send, post or change anything outside this session without asking me first.`,
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
