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
  /** Steps Claude is confident it can complete on its own (research, drafting); never sending or deciding. */
  claude_steps: z.array(z.string()).nullish(),
});
export type Assessment = z.infer<typeof Assessment>;

/** Strategic priority of a project, P0 (highest) to P4. */
export const ProjectPriority = z.enum(["P0", "P1", "P2", "P3", "P4"]);
export type ProjectPriority = z.infer<typeof ProjectPriority>;

/** The user's inferred role on a project. */
export const Raci = z.enum(["responsible", "accountable", "consulted", "informed"]);
export type Raci = z.infer<typeof Raci>;

export const Person = z.object({
  name: z.string(),
  slack_user_id: z.string().nullish(),
  is_me: z.boolean(),
});
export type Person = z.infer<typeof Person>;

/** A piece of work on the project and who owns it: a blocker, or active work. */
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
  /** A short proper name for the project, e.g. "Asset refunds". */
  name: z.string().nullish(),
  description: z.string(),
  status: ProjectStatus,
  status_reason: z.string(),
  raci: z.object({ role: Raci, reason: z.string() }),
  priority: z.object({ level: ProjectPriority, reason: z.string() }),
  blockers: z.array(Blocker),
  /** Planned work that's underway and isn't holding anyone up. */
  active: z.array(Blocker).default([]),
  my_tasks: z.array(ProjectTask),
  /** Notable developments since the previous snapshot. */
  recent_updates: z.array(z.object({ summary: z.string(), date: z.string().nullish(), link: z.string().nullish() })).default([]),
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

/** A Slack message or email waiting on the user's response. */
export const QuickReply = z.object({
  /** Slack permalink, or "gmail:<thread id>". */
  id: z.string(),
  source: z.enum(["slack", "email"]),
  from: z.string(),
  /** What they asked, in a few words. */
  summary: z.string(),
  /** Where it was sent: "#channel", "DM", or the email subject. */
  where: z.string().nullish(),
  /** When it was sent: ISO date-time (older refreshes stored YYYY-MM-DD). */
  received: z.string().nullish(),
  link: z.string().nullish(),
});
export type QuickReply = z.infer<typeof QuickReply>;

/** Something worth knowing from outside the user's project channels. */
export const NewsItem = z.object({
  id: z.string(),
  headline: z.string(),
  detail: z.string().nullish(),
  /** "#channel" or "Email: <subject>". */
  where: z.string().nullish(),
  date: z.string().nullish(),
  link: z.string().nullish(),
});
export type NewsItem = z.infer<typeof NewsItem>;

export const AdhocSnapshot = z.object({
  tasks: z.array(AdhocTask),
  replies: z.array(QuickReply).default([]),
  news: z.array(NewsItem).default([]),
});
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
  /** Google Meet, Zoom or Teams URL for joining the call. */
  video_link: z.string().nullish(),
  /** What the meeting is likely to cover. */
  summary: z.string().nullish(),
  related_project: z.string().nullish(),
  prep: z.array(PrepItem),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

export const CalendarDay = z.object({
  date: z.string(),
  events: z.array(CalendarEvent),
});
export type CalendarDay = z.infer<typeof CalendarDay>;

export const ReplyDraft = z.object({ draft: z.string() });

/** Claude's second look at a blocker: is it real, and was it already solved somewhere else? */
export const BlockerCheck = z.object({
  verdict: z.enum(["still_blocking", "resolved", "partly_resolved", "not_blocking", "unclear"]),
  summary: z.string(),
  evidence: z.array(z.object({ title: z.string(), link: z.string() })).default([]),
  /** The next step that would clear it, if it's still blocking. */
  next_step: z.string().nullish(),
});
export type BlockerCheck = z.infer<typeof BlockerCheck>;

export const SentMessage = z.object({ sent: z.boolean(), link: z.string().nullish(), error: z.string().nullish() });

export const DailyReading = z.object({
  reading: z.string(),
  /** Ids of tasks the Orb recommends doing today to move P0 projects forward. */
  recommended: z.array(z.string()).default([]),
});

/** Claude's assessment of one of the user's own tasks, with a drafted description if they gave none. */
export const ManualAssessment = Assessment.extend({
  id: z.string(),
  description: z.string().nullish(),
});
export type ManualAssessment = z.infer<typeof ManualAssessment>;

export const ManualAssessmentBatch = z.object({ assessments: z.array(ManualAssessment) });

export const TaskPlan = z.object({
  approach: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      detail: z.string().nullish(),
      link: z.string().nullish(),
      /** Who does it: "claude" only if Claude can complete it independently. Older plans lack it. */
      by: z.enum(["claude", "you"]).nullish(),
    }),
  ),
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
