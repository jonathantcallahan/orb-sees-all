import { z } from "zod";

// Shapes Claude must return. Optional fields are nullish because the model
// sometimes sends null and sometimes leaves the key out.

export const ProjectStatus = z.enum(["on_track", "at_risk", "blocked", "idle"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const WaitingOn = z.object({
  person: z.string(),
  slack_user_id: z.string().nullish(),
  what: z.string(),
  since: z.string().nullish(),
  link: z.string().nullish(),
});
export type WaitingOn = z.infer<typeof WaitingOn>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  link: z.string().nullish(),
  due: z.string().nullish(),
});
export type Task = z.infer<typeof Task>;

export const ProjectSnapshot = z.object({
  status: ProjectStatus,
  status_reason: z.string(),
  waiting_on: z.array(WaitingOn),
  my_tasks: z.array(Task),
  summary: z.string(),
  last_activity: z.string().nullish(),
});
export type ProjectSnapshot = z.infer<typeof ProjectSnapshot>;

export const Discovery = z.object({
  user_id: z.string(),
  channels: z.array(z.object({ channel_id: z.string(), name: z.string() })),
});
export type Discovery = z.infer<typeof Discovery>;

export const FollowUpKind = z.enum(["reply", "review", "decide", "do", "schedule", "share"]);
export type FollowUpKind = z.infer<typeof FollowUpKind>;

export const FollowUp = z.object({
  kind: FollowUpKind,
  /** Imperative and specific, e.g. "Reply in the thread with the Nov 17 date". */
  action: z.string(),
});
export type FollowUp = z.infer<typeof FollowUp>;

export const AdhocTask = Task.extend({
  source: z.enum(["slack", "email"]),
  requester: z.string().nullish(),
  description: z.string().nullish(),
  follow_up: FollowUp.nullish(),
});
export type AdhocTask = z.infer<typeof AdhocTask>;

export const AdhocSnapshot = z.object({ tasks: z.array(AdhocTask) });
export type AdhocSnapshot = z.infer<typeof AdhocSnapshot>;

export const PrepItem = z.object({
  id: z.string(),
  title: z.string(),
  link: z.string().nullish(),
});
export type PrepItem = z.infer<typeof PrepItem>;

export const CalendarEvent = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  attendees: z.array(z.string()),
  link: z.string().nullish(),
  related_project: z.string().nullish(),
  prep: z.array(PrepItem),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

export const CalendarDay = z.object({
  date: z.string(),
  events: z.array(CalendarEvent),
});
export type CalendarDay = z.infer<typeof CalendarDay>;

export const TaskPlan = z.object({
  approach: z.string(),
  steps: z.array(z.object({ title: z.string(), detail: z.string().nullish(), link: z.string().nullish() })),
  open_questions: z.array(z.string()),
  sources: z.array(z.object({ title: z.string(), link: z.string() })),
});
export type TaskPlan = z.infer<typeof TaskPlan>;

// Collected locally from git and gh, not by Claude.

export interface LocalRepoState {
  path: string;
  branch?: string;
  dirty?: number;
  ahead?: number;
  behind?: number;
  error?: string;
}

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;
  kind: "mine" | "review_requested";
}

export interface RepoState {
  local: LocalRepoState[];
  prs: PullRequest[];
  errors: string[];
}
