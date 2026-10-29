import { z } from "zod";

// Shapes Claude must return. Optional fields are nullish because the model
// sometimes sends null and sometimes leaves the key out.

export const ProjectStatus = z.enum(["on_track", "at_risk", "blocked", "idle"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  link: z.string().nullish(),
  due: z.string().nullish(),
});
export type Task = z.infer<typeof Task>;

export const FollowUpKind = z.enum(["reply", "review", "decide", "do", "schedule", "share"]);
export type FollowUpKind = z.infer<typeof FollowUpKind>;

export const FollowUp = z.object({
  kind: FollowUpKind,
  /** Imperative and specific, e.g. "Reply in the thread with the Nov 17 date". */
  action: z.string(),
});
export type FollowUp = z.infer<typeof FollowUp>;

export const Priority = z.enum(["critical", "high", "medium", "low"]);
export type Priority = z.infer<typeof Priority>;

/** Who can get a task done: the user alone, the user with Claude's help, or Claude. */
export const Automation = z.enum(["human", "assisted", "claude"]);
export type Automation = z.infer<typeof Automation>;

export const Assessment = z.object({
  automation: Automation,
  /** One sentence: a first take on how to approach it, or what Claude would do. */
  suggestion: z.string(),
  /** Too vague to act on without more from the user. */
  needs_details: z.boolean(),
  /** What to ask the user when needs_details is true. */
  details_question: z.string().nullish(),
  /** Expected hands-on time for the user, in minutes. */
  estimate_minutes: z.number().nullish(),
  priority: Priority.nullish(),
});
export type Assessment = z.infer<typeof Assessment>;

/** The user's inferred role on a project. */
export const Raci = z.enum(["responsible", "accountable", "consulted", "informed"]);
export type Raci = z.infer<typeof Raci>;

export const Person = z.object({
  name: z.string(),
  slack_user_id: z.string().nullish(),
  is_me: z.boolean(),
});
export type Person = z.infer<typeof Person>;

/** A task that's holding the project up, and who owns it. */
export const Blocker = z.object({
  /** Permalink of the message that raised it; matches the my_tasks id when the user owns it. */
  id: z.string(),
  what: z.string(),
  owners: z.array(Person),
  since: z.string().nullish(),
  link: z.string().nullish(),
});
export type Blocker = z.infer<typeof Blocker>;

export const ProjectTask = Task.extend({
  description: z.string().nullish(),
  follow_up: FollowUp.nullish(),
  assessment: Assessment.nullish(),
});
export type ProjectTask = z.infer<typeof ProjectTask>;

export const ProjectSnapshot = z.object({
  description: z.string(),
  status: ProjectStatus,
  status_reason: z.string(),
  raci: z.object({ role: Raci, reason: z.string() }),
  priority: z.object({ level: Priority, reason: z.string() }),
  blockers: z.array(Blocker),
  my_tasks: z.array(ProjectTask),
  summary: z.string(),
  last_activity: z.string().nullish(),
});
export type ProjectSnapshot = z.infer<typeof ProjectSnapshot>;

export const Discovery = z.object({
  user_id: z.string(),
  channels: z.array(z.object({ channel_id: z.string(), name: z.string() })),
});
export type Discovery = z.infer<typeof Discovery>;

export const AdhocTask = Task.extend({
  source: z.enum(["slack", "email"]),
  requester: z.string().nullish(),
  description: z.string().nullish(),
  follow_up: FollowUp.nullish(),
  assessment: Assessment.nullish(),
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

/** Claude's assessment of one of the user's own tasks, with a drafted description if they gave none. */
export const ManualAssessment = Assessment.extend({
  id: z.string(),
  description: z.string().nullish(),
});
export type ManualAssessment = z.infer<typeof ManualAssessment>;

export const ManualAssessmentBatch = z.object({ assessments: z.array(ManualAssessment) });

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
