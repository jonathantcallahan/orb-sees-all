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
  /** The user's own hands-on time to finish it, in minutes; none when it's too vague to judge. A plan's per-step minutes replace it. */
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
  /** The id of an existing open task (any source) that this is the same work as; see taskIndex.ts. */
  refines: z.string().nullish(),
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
  /** No longer requested (nothing shows it); kept optional so older snapshots still parse. */
  summary: z.string().nullish(),
  last_activity: z.string().nullish(),
});
export type ProjectSnapshot = z.infer<typeof ProjectSnapshot>;

/**
 * What's known about a project, kept across refreshes and refined by each one: the durable facts,
 * as opposed to the snapshot's current status.
 */
export const ProjectProfile = z.object({
  /** What the project is for and what "done" looks like. */
  goal: z.string(),
  /**
   * How Claude reads the project, as short separate statements: what it covers, what isn't part of
   * it, how it's run. Shown as Project context, where the user edits, removes and adds entries.
   */
  context: z.array(z.string()).default([]),
  /** Older profiles' single-text versions of the context; read only. */
  focus: z.string().nullish(),
  out_of_scope: z.string().nullish(),
  /** Other names people use for it: codenames, ticket prefixes, abbreviations. */
  aliases: z.array(z.string()).default([]),
  people: z.array(z.object({ name: z.string(), slack_user_id: z.string().nullish(), role: z.string() })).default([]),
  /** Key docs, tickets, epics, dashboards and repos. */
  resources: z.array(z.object({ title: z.string(), link: z.string(), kind: z.string().nullish() })).default([]),
  milestones: z
    .array(z.object({ what: z.string(), date: z.string().nullish(), status: z.enum(["done", "planned", "at_risk", "missed"]) }))
    .default([]),
  decisions: z.array(z.object({ what: z.string(), date: z.string().nullish(), link: z.string().nullish() })).default([]),
});
export type ProjectProfile = z.infer<typeof ProjectProfile>;

/** Another Slack channel a refresh found the project being worked on in. */
export const RelatedChannel = z.object({ channel_id: z.string(), name: z.string(), reason: z.string() });
export type RelatedChannel = z.infer<typeof RelatedChannel>;

/** A Jira epic that belongs to a project, with how far along its child issues are. */
export const ProjectEpic = z.object({
  key: z.string(),
  title: z.string(),
  /** Jira's status name, e.g. "In Progress". */
  status: z.string(),
  done: z.number().default(0),
  total: z.number().default(0),
  link: z.string(),
  /** When it last changed, ISO 8601. */
  updated: z.string().nullish(),
});
export type ProjectEpic = z.infer<typeof ProjectEpic>;

/** What a project refresh returns: the new snapshot, the refined profile, channels and epics it found. */
export const ProjectRefresh = ProjectSnapshot.extend({
  profile: ProjectProfile,
  related_channels: z.array(RelatedChannel).default([]),
  epics: z.array(ProjectEpic).default([]),
});
export type ProjectRefresh = z.infer<typeof ProjectRefresh>;

export const Discovery = z.object({
  user_id: z.string(),
  /** Each project found, as the channels it spans; existing projects keep their id. */
  projects: z.array(
    z.object({
      project_id: z.string().nullish(),
      name: z.string(),
      reason: z.string(),
      channels: z.array(z.object({ channel_id: z.string(), name: z.string(), role: z.enum(["primary", "related"]) })),
    }),
  ),
});
export type Discovery = z.infer<typeof Discovery>;

export const AdhocTask = Task.extend({
  /** The id of an existing open task (any source) that this is the same work as; see taskIndex.ts. */
  refines: z.string().nullish(),
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
  /** The user's own RSVP. Missing on days fetched before this was recorded; treated as accepted. */
  my_response: z.enum(["accepted", "tentative", "declined", "needs_action"]).nullish(),
  related_project: z.string().nullish(),
  prep: z.array(PrepItem),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

export const CalendarDay = z.object({
  date: z.string(),
  events: z.array(CalendarEvent),
});
export type CalendarDay = z.infer<typeof CalendarDay>;


/** Claude's second look at a blocker: is it real, and was it already solved somewhere else? */
export const BlockerCheck = z.object({
  verdict: z.enum(["still_blocking", "resolved", "partly_resolved", "not_blocking", "unclear"]),
  summary: z.string(),
  evidence: z.array(z.object({ title: z.string(), link: z.string() })).default([]),
  /** The next step that would clear it, if it's still blocking. */
  next_step: z.string().nullish(),
});
export type BlockerCheck = z.infer<typeof BlockerCheck>;

/** Claude's critical second look at a task. */
export const TaskCheck = z.object({
  verdict: z.enum(["looks_right", "already_done", "not_needed", "captured_wrong", "duplicate", "unclear"]),
  summary: z.string(),
  /** Each check and what was found, e.g. {check: "Still needed", finding: "Ben closed the thread on Oct 28."}. */
  findings: z.array(z.object({ check: z.string(), finding: z.string(), ok: z.boolean() })).default([]),
  /** A corrected description when the task was captured wrong or is missing context. */
  corrected_description: z.string().nullish(),
  /** For a "duplicate" verdict: the id of the open task it duplicates. */
  duplicate_of: z.string().nullish(),
  evidence: z.array(z.object({ title: z.string(), link: z.string() })).default([]),
});
export type TaskCheck = z.infer<typeof TaskCheck>;

/** Orb's re-check of a working session's steps against its conversation. */
export const StepRecheck = z.object({
  steps: z.array(
    z.object({
      title: z.string(),
      by: z.enum(["claude", "you"]),
      state: z.enum(["todo", "started", "done", "waiting", "blocked", "skipped"]),
      /** For waiting: what's needed from the user. Blocked: who or what it's waiting on. Skipped: why. */
      note: z.string().nullish(),
    }),
  ),
});
export type StepRecheck = z.infer<typeof StepRecheck>;

/** Who the user is at work, worked out by Claude in the background (the prompts' description of them). */
export const LearnedRole = z.object({ name: z.string().nullish(), role: z.string() });

/**
 * A change the global chat proposes to the planner itself, applied only when the user clicks Apply
 * (see globalActions.ts). Project ids are channel ids, as everywhere else.
 */
export const GlobalAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_project"),
    name: z.string(),
    channels: z.array(z.object({ channel_id: z.string(), name: z.string() })).min(1),
    reason: z.string().nullish(),
  }),
  z.object({
    type: z.literal("split_project"),
    project_id: z.string(),
    new_name: z.string(),
    /** The channels that move to the new project; the first becomes its main channel. */
    channel_ids: z.array(z.string()).min(1),
    reason: z.string().nullish(),
  }),
  z.object({ type: z.literal("merge_projects"), from_id: z.string(), into_id: z.string() }),
  z.object({ type: z.literal("rename_project"), project_id: z.string(), name: z.string() }),
  z.object({ type: z.literal("set_project_tracking"), project_id: z.string(), tracked: z.boolean() }),
  /** Where a project's code lives: local checkouts (folders) and GitHub repos (owner/name), added to what's mapped. */
  z.object({ type: z.literal("add_project_repos"), project_id: z.string(), local: z.array(z.string()).default([]), github: z.array(z.string()).default([]) }),
  /** Context entries in the user's words about a project; refreshes keep to them. */
  z.object({ type: z.literal("add_project_context"), project_id: z.string(), entries: z.array(z.string()).min(1) }),
  /** Removes context entries (Demian's or the user's) from a project; refreshes leave them out. */
  z.object({ type: z.literal("remove_project_context"), project_id: z.string(), entries: z.array(z.string()).min(1) }),
  /** The project's status as the user sees it; "auto" goes back to what refreshes find. */
  z.object({ type: z.literal("set_project_status"), project_id: z.string(), status: z.enum(["blocked", "at_risk", "on_track", "idle", "auto"]), reason: z.string().nullish() }),
  /** Marks a project's blocker or active item done, as its Mark done does. */
  z.object({ type: z.literal("resolve_project_item"), project_id: z.string(), item_id: z.string(), what: z.string().nullish() }),
  /** Has Claude double-check a blocker or active item, as its Double check does. */
  z.object({ type: z.literal("check_project_item"), project_id: z.string(), item_id: z.string(), what: z.string().nullish() }),
  /** Unlinks a channel from a project, as Settings > Projects does. */
  z.object({ type: z.literal("unlink_channel"), project_id: z.string(), channel_id: z.string() }),
  z.object({ type: z.literal("add_note"), text: z.string() }),
  z.object({ type: z.literal("update_profile"), text: z.string() }),
  z.object({ type: z.literal("add_task"), title: z.string(), project_id: z.string().nullish() }),
  /** Plans an existing task for today (Today's tasks), or takes it off. */
  z.object({ type: z.literal("plan_today"), task_id: z.string(), title: z.string().nullish(), today: z.boolean().default(true) }),
  z.object({ type: z.literal("set_task_status"), task_id: z.string(), title: z.string().nullish(), status: z.enum(["todo", "in_progress", "waiting", "done"]) }),
  z.object({ type: z.literal("set_task_priority"), task_id: z.string(), title: z.string().nullish(), priority: z.enum(["critical", "high", "medium", "low"]) }),
  z.object({
    type: z.literal("refresh"),
    what: z.enum(["all", "project", "briefing", "calendar", "tasks"]),
    project_id: z.string().nullish(),
  }),
]);
export type GlobalAction = z.infer<typeof GlobalAction>;

/** What distilling the user's corrections returns: reasons inferred where none were given, and the lessons. */
export const Distilled = z.object({
  reasons: z.array(z.object({ id: z.number(), reason: z.string() })).default([]),
  lessons: z.array(z.object({ scope: z.string(), text: z.string(), evidence: z.array(z.number()).default([]) })),
});

/** An epic's child issues, with who each is assigned to. */
export const EpicChildren = z.object({
  issues: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      status: z.string(),
      /** Done, In progress or To do, from the status's category. */
      category: z.enum(["done", "in_progress", "todo"]).catch("todo"),
      assignee: z.string().nullish(),
      link: z.string().nullish(),
    }),
  ),
  /** Why the issues couldn't be read (a failed or forbidden search), rather than there being none. */
  error: z.string().nullish(),
});
export type EpicChildren = z.infer<typeof EpicChildren>;

export const SentMessage = z.object({ sent: z.boolean(), link: z.string().nullish(), error: z.string().nullish(), moved: z.string().nullish() });

export const DailyReading = z.object({
  reading: z.string(),
  /** Ids of tasks the Orb recommends doing today to move P0 projects forward. */
  recommended: z.array(z.string()).default([]),
});

/** Claude's assessment of one of the user's own tasks, with a drafted description if they gave none. */
export const ManualAssessment = Assessment.extend({
  id: z.string(),
  description: z.string().nullish(),
  /** A short title, when what the user typed was a detailed note rather than a title. */
  title: z.string().nullish(),
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
      /** The user's hands-on minutes for it (for Claude's steps, reviewing what it made). Older plans lack it. */
      minutes: z.number().nullish(),
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
