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
  /** The work on the project's path it moves forward or unblocks, by id (a Jira key, or a "t" id). */
  moves: z.array(z.string()).nullish().catch(null),
  description: z.string().nullish(),
  follow_up: FollowUp.nullish(),
  assessment: Assessment.nullish(),
});
export type ProjectTask = z.infer<typeof ProjectTask>;

/** A project has a start and an end (a launch, a migration, a feature); a workstream is ongoing. */
export const ProjectKind = z.enum(["project", "workstream"]);
export type ProjectKind = z.infer<typeof ProjectKind>;


/**
 * That a Jira issue sits in the plan at a different level than Jira has it, because of what it
 * effectively is (see the work levels in prompts.ts): an epic that's an initiative's worth of work, or
 * a story's. Why, in a sentence. Demian can make Jira match (see applyInitiative, applyStory).
 */
export const Realign = z.object({ from: z.literal("epic").catch("epic"), reason: z.string().default("") });
export type Realign = z.infer<typeof Realign>;

/** A story or task under a path epic (a slice one person ships in days): a Jira issue, or work no ticket covers yet (key null). */
export const PathItem = z.object({
  /** Its Jira key; null for work in no ticket. */
  key: z.string().nullish(),
  title: z.string(),
  /**
   * Its Jira issue type ("Story", "Task", "Bug", "Spike", "Collaboration"…): Jira's for a ticket, the
   * one Demian proposes for work in no ticket.
   */
  type: z.string().nullish().catch(null),
  status: z.enum(["done", "in_progress", "next", "blocked"]).catch("next"),
  /** Who it's assigned to, by name; null when nobody is. */
  assignee: z.string().nullish(),
  /** Its due date, YYYY-MM-DD. */
  date: z.string().nullish(),
  link: z.string().nullish(),
  /** The guiding doc's requirements it delivers, by id. */
  requirements: z.array(z.string()).default([]).catch([]),
  /** A Jira epic that's a single issue's worth of work, here as one (key is the epic's). */
  realign: Realign.nullish().catch(null),
  /**
   * The epic it's under in Jira now (its parent), null when none: when that isn't the epic the plan
   * puts it in, moving it there is a proposal.
   */
  jira_parent: z.string().nullish().catch(null),
  /** For work in no ticket: its id ("t1", "t2"…), kept across refreshes. A ticket's id is its key. */
  id: z.string().nullish().catch(null),
  /**
   * The GitHub pull requests and branches the ticket links itself (in its description, comments or a
   * link field), by URL: explicit, where the ones matched by its key in their name are only suggested.
   */
  code: z.array(z.string()).default([]).catch([]),
  /**
   * Pull requests and branches that are this work though the ticket doesn't link them and they don't
   * name its key, by URL: ones the project's channels, meetings, docs or tickets tie to it. On work in
   * no ticket, the code it was proposed for.
   */
  suggested_code: z.array(z.string()).default([]).catch([]),
  /**
   * The work it waits on, by id (a key, or a "t" id): "jira" for a Blocks link in Jira between two
   * tickets, "assumed" for Demian's reading of the order, with why.
   */
  waits_on: z
    .array(z.object({ id: z.string(), source: z.enum(["jira", "assumed"]).catch("assumed"), reason: z.string().nullish() }))
    .default([])
    .catch([]),
});
export type PathItem = z.infer<typeof PathItem>;

/**
 * One epic on a project's way to shipping: a project in Linear's sense, one finishable outcome a
 * small team ships in weeks (usually two to six), done when it's out and working for the people it's
 * for. A Jira epic of the project, or one Demian proposes for work no epic covers. Its items are its
 * issues (stories, tasks, bugs).
 * (Older paths' steps were stages of the work, with no epic or items.)
 */
export const PathStep = z.object({
  what: z.string(),
  status: z.enum(["done", "in_progress", "next", "blocked"]).catch("next"),
  owners: z.array(z.string()).default([]),
  /** Its target date, YYYY-MM-DD, when one is set. */
  date: z.string().nullish(),
  link: z.string().nullish(),
  /**
   * The strand of work it's on when parts of the project move at the same time ("Backend",
   * "Publisher UI", "Legal"); none when the project moves as one strand. See pathTracks.
   */
  track: z.string().nullish().catch(null),
  /** The Jira epic it is; null for an epic Demian proposes, which isn't in Jira yet. */
  epic: z.object({ key: z.string(), link: z.string().nullish() }).nullish().catch(null),
  /** What it delivers, in a sentence. */
  summary: z.string().nullish().catch(null),
  /** When its work started or is planned to start, YYYY-MM-DD (its first sprint's start). */
  start: z.string().nullish().catch(null),
  /** For a Jira epic that isn't epic-sized (an initiative's worth, or a story's): why, and what it could be instead. */
  size_note: z.string().nullish().catch(null),
  /** Its work: a Jira epic's child issues, or the issues and work a proposed one gathers. */
  items: z.array(PathItem).default([]).catch([]),
  /** The guiding doc's requirements it delivers that none of its items does on its own, by id. */
  requirements: z.array(z.string()).default([]).catch([]),
  /** The id of the initiative it's part of (see PathInitiative); none when it stands alone. */
  initiative: z.string().nullish().catch(null),
  /** The GitHub pull requests and branches the epic's own ticket links (see PathItem.code). */
  code: z.array(z.string()).default([]).catch([]),
});
export type PathStep = z.infer<typeof PathStep>;

/**
 * A strategic goal a project's epics roll up to, across teams, over quarters: an Initiative in Jira,
 * a Jira epic that's an initiative's worth of work (realign), or one Demian proposes.
 */
export const PathInitiative = z.object({
  /** Stable across refreshes: "i1", "i2"…, or its Jira key. */
  id: z.string(),
  what: z.string(),
  /** What moves when it's done, in a sentence. */
  summary: z.string().nullish().catch(null),
  /** Its issue in Jira; none when Demian proposes it. */
  jira: z.object({ key: z.string(), link: z.string().nullish() }).nullish().catch(null),
  /** For a Jira epic that's an initiative's worth of work: that, and why. */
  realign: Realign.nullish().catch(null),
  /** The guiding doc's requirements it delivers across its epics, by id. */
  requirements: z.array(z.string()).default([]).catch([]),
});
export type PathInitiative = z.infer<typeof PathInitiative>;

/**
 * A project's way from where it is now to shipping: where it stands, the stages in order (the last
 * ones done, the current one, then what's left), and what ships when, with where that date came from.
 */
export const PathToShip = z.object({
  now: z.string().default(""),
  ship: z
    .object({
      what: z.string().default(""),
      /** YYYY-MM-DD; null when nothing names a date. */
      date: z.string().nullish(),
      source: z.object({ title: z.string(), link: z.string().nullish() }).nullish().catch(null),
    })
    .nullish()
    .catch(null),
  steps: z.array(PathStep).default([]),
  /** The initiatives its epics roll up to, when there are any (see PathStep.initiative). */
  initiatives: z.array(PathInitiative).default([]).catch([]),
  /**
   * Tickets the user created from the plan for requirements outside any epic, so the plan shows each
   * as its ticket (not a proposal to create again) until a refresh reads them from Jira.
   */
  created: z
    .array(z.object({ requirement: z.string(), key: z.string(), link: z.string().nullish(), title: z.string(), type: z.string().default("Story") }))
    .default([])
    .catch([]),
});
export type PathToShip = z.infer<typeof PathToShip>;

/**
 * One piece of work on a project's map of tasks and dependencies: a Jira ticket, or a task Demian
 * assumes is part of the work though nothing in Jira is tracking it yet.
 */
export const MapItem = z.object({
  /** The Jira key, or "t1", "t2"… for a task Demian assumes. */
  id: z.string(),
  /** A few words, shown on its block: "Classify job", "Wire the UI to the PIM APIs". */
  title: z.string(),
  /** What it is, in a sentence or two, shown on hover. */
  detail: z.string().default(""),
  /** Who's responsible for it, by name; none when nobody is. */
  owner: z.string().nullish(),
  status: z.enum(["done", "in_progress", "next", "blocked"]).catch("next"),
  /** The path's track it belongs to (see PathStep.track). */
  track: z.string().nullish().catch(null),
  /** Its Jira ticket; none for a task Demian assumes. */
  jira: z.object({ key: z.string(), link: z.string().nullish() }).nullish().catch(null),
  /** For an assumed task: why Demian thinks it's part of the work. */
  reason: z.string().nullish(),
  /** Its due date, YYYY-MM-DD. */
  date: z.string().nullish(),
  /** One of the user's own tasks, shown with the work it moves forward. */
  mine: z.boolean().nullish().catch(null),
});
export type MapItem = z.infer<typeof MapItem>;

/**
 * That one piece of work waits on another: `from` has to finish before `to`. "jira" when a Jira
 * Blocks link between their tickets says so; "assumed" when it's Demian's reading of the work.
 */
export const MapLink = z.object({
  from: z.string(),
  to: z.string(),
  source: z.enum(["jira", "assumed"]).catch("assumed"),
  /** For an assumed link: why Demian thinks the one waits on the other. */
  reason: z.string().nullish(),
});
export type MapLink = z.infer<typeof MapLink>;

/** A TDD Demian drafted for a project, for the user to review before it's created in their Drive. */
export const TddDraft = z.object({
  title: z.string(),
  markdown: z.string(),
  sources: z.array(z.object({ title: z.string(), link: z.string() })).default([]),
});
export type TddDraft = z.infer<typeof TddDraft>;

/** A project's work as tasks and the dependencies between them, for its map. */
export const ProjectMap = z.object({
  items: z.array(MapItem).default([]),
  links: z.array(MapLink).default([]),
  /** Anything odd about it: links that look backwards, tickets left out. */
  note: z.string().nullish(),
});
export type ProjectMap = z.infer<typeof ProjectMap>;

export const ProjectSnapshot = z.object({
  /** A short proper name for the project, e.g. "Asset refunds". */
  name: z.string().nullish(),
  /** Whether it's a project or a workstream, as the refresh reads it, and why; the user's choice wins (see projectKind). */
  kind: z.object({ value: ProjectKind, reason: z.string().nullish() }).nullish().catch(null),
  /** How it gets from where it is now to shipping; null for a workstream (see PathToShip). */
  path: PathToShip.nullish().catch(null),
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
 * Someone on a project, as its refreshes know them: their role on it, how central they are and what
 * they're doing on it now, and their face (their Jira avatar).
 */
export const ProfilePerson = z.object({
  name: z.string(),
  slack_user_id: z.string().nullish(),
  role: z.string(),
  /** How central they are to it, from 1 (on its edges) to 5 (they drive it). */
  importance: z.number().int().min(1).max(5).nullish().catch(null),
  /** What they're doing on it now, in a sentence; "" when nothing current. */
  working_on: z.string().nullish().catch(null),
  /** Their avatar's URL, from Jira. */
  avatar: z.string().nullish().catch(null),
  /** Their part in it: owns the outcome, does the work, is asked for input, or is kept informed. */
  raci: Raci.nullish().catch(null),
});
export type ProfilePerson = z.infer<typeof ProfilePerson>;

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
  people: z.array(ProfilePerson).default([]),
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
  /** A workstream's epic: its child issues' keys, so pull requests naming one are matched to it. */
  issues: z.array(z.string()).nullish().catch(null),
  link: z.string(),
  /** When it last changed, ISO 8601. */
  updated: z.string().nullish(),
});
export type ProjectEpic = z.infer<typeof ProjectEpic>;

/** One requirement from a project's guiding doc, in the doc's own words. */
export const Requirement = z.object({
  /** "R1", "R2"…; kept for the same requirement when the doc is read again, so its progress carries over. */
  id: z.string(),
  text: z.string(),
  /** The doc's section it's under, e.g. "Refund flow". */
  section: z.string().nullish(),
  /** Only where the doc itself ranks it. */
  priority: z.enum(["must", "should", "could"]).nullish().catch(null),
});
export type Requirement = z.infer<typeof Requirement>;

/** What reading a guiding doc returns. */
export const RequirementsRead = z.object({
  title: z.string().nullish(),
  kind: z.string().nullish(),
  /** When the doc was last edited, ISO 8601, when its file says. */
  updated: z.string().nullish(),
  /** The doc hasn't been edited since it was last read, so the requirements stand. */
  unchanged: z.boolean().default(false),
  /** Why it couldn't be read (no access, a kind of doc that can't be opened); null when it was. */
  unreadable: z.string().nullish(),
  requirements: z.array(Requirement).default([]),
});
export type RequirementsRead = z.infer<typeof RequirementsRead>;

export const RequirementStatus = z.enum(["done", "in_progress", "not_started", "at_risk", "descoped", "unclear"]);
export type RequirementStatus = z.infer<typeof RequirementStatus>;

/** How far along one requirement is, as a project refresh finds it. */
export const RequirementProgress = z.object({
  id: z.string(),
  status: RequirementStatus.catch("unclear"),
  /** One sentence: what's done and what's left. */
  note: z.string().default(""),
  evidence: z.array(z.object({ title: z.string(), link: z.string() })).default([]),
});
export type RequirementProgress = z.infer<typeof RequirementProgress>;

/** What a project refresh returns: the new snapshot, the refined profile, channels and epics it found. */
export const ProjectRefresh = ProjectSnapshot.extend({
  profile: ProjectProfile,
  related_channels: z.array(RelatedChannel).default([]),
  epics: z.array(ProjectEpic).default([]),
  /** Progress on each of the guiding doc's requirements, when it has some. */
  requirements_progress: z.array(RequirementProgress).default([]),
});
export type ProjectRefresh = z.infer<typeof ProjectRefresh>;

export const Discovery = z.object({
  user_id: z.string(),
  /** Each project found, as the channels and Jira epics it spans; existing projects keep their id. */
  projects: z.array(
    z.object({
      project_id: z.string().nullish(),
      name: z.string(),
      reason: z.string(),
      channels: z.array(z.object({ channel_id: z.string(), name: z.string(), role: z.enum(["primary", "related"]) })).default([]),
      epics: z.array(z.object({ key: z.string(), title: z.string().default("") })).default([]),
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
export const LearnedRole = z.object({ name: z.string().nullish(), role: z.string(), user_id: z.string().nullish() });

/**
 * A change the global chat proposes to the planner itself, applied only when the user clicks Apply
 * (see globalActions.ts). Project ids are as the planner lists them: a channel id ("C123…") for most,
 * "jira:<epic key>" or "p:<id>" for a project with no Slack channel.
 */
export const GlobalAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_project"),
    name: z.string(),
    /** Its Slack channels, the first its main one; none for a project that has no channel. */
    channels: z.array(z.object({ channel_id: z.string(), name: z.string() })).default([]),
    /** Its Jira epics, by key. */
    epics: z.array(z.string()).default([]),
    reason: z.string().nullish(),
  }),
  /** Links a Jira epic to a project; an epic linked to another project moves to this one. */
  z.object({ type: z.literal("link_project_epic"), project_id: z.string(), epic_key: z.string() }),
  /** Unlinks a Jira epic from a project; refreshes and discovery leave it alone after. */
  z.object({ type: z.literal("unlink_project_epic"), project_id: z.string(), epic_key: z.string() }),
  /**
   * Changes one Jira issue or epic, made in Jira when the user applies the card: each field given is
   * changed, the rest left as they are. "none" clears the assignee or due date; sprint "backlog" takes
   * it out of its sprint.
   */
  z.object({
    type: z.literal("change_jira_issue"),
    key: z.string(),
    /** What it's called, for the card. */
    title: z.string().nullish(),
    /** Its new status, by name: Jira moves it there by a transition. */
    status: z.string().nullish(),
    /** Who it's assigned to, by name or email, or "none". */
    assignee: z.string().nullish(),
    /** Its due date, YYYY-MM-DD, or "none". */
    due: z.string().nullish(),
    /** A new summary (its title in Jira). */
    summary: z.string().nullish(),
    priority: z.string().nullish(),
    /** The epic it moves into, by key, or "none" to take it out of its epic. */
    epic: z.string().nullish(),
    /** The sprint it moves to, by name, or "backlog". */
    sprint: z.string().nullish(),
    /** A comment to add to it, in markdown. */
    comment: z.string().nullish(),
    reason: z.string().nullish(),
  }),
  z.object({
    type: z.literal("split_project"),
    project_id: z.string(),
    new_name: z.string(),
    /** The channels that move to the new project; the first becomes its main channel. */
    channel_ids: z.array(z.string()).default([]),
    /** The epics that move to the new project, by key. */
    epic_keys: z.array(z.string()).default([]),
    /** Channels both projects keep reading (the main channel can't move, but it can be shared). */
    shared_channel_ids: z.array(z.string()).default([]),
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
  /** Whether it's a project (with a start and an end) or a workstream (ongoing); "auto" hands it back to refreshes. */
  z.object({ type: z.literal("set_project_kind"), project_id: z.string(), kind: z.enum(["project", "workstream", "auto"]) }),
  /** Links a project's guiding doc (a TDD or PRD), whose requirements are then read and tracked; a null link removes it. */
  z.object({ type: z.literal("set_project_doc"), project_id: z.string(), link: z.string().nullable(), title: z.string().nullish() }),
  /** Marks a project's blocker or active item done, as its Mark done does. */
  z.object({ type: z.literal("resolve_project_item"), project_id: z.string(), item_id: z.string(), what: z.string().nullish() }),
  /** Has Claude double-check a blocker or active item, as its Double check does. */
  z.object({ type: z.literal("check_project_item"), project_id: z.string(), item_id: z.string(), what: z.string().nullish() }),
  /** Unlinks a channel from a project, as Settings > Projects does. */
  z.object({ type: z.literal("unlink_channel"), project_id: z.string(), channel_id: z.string() }),
  z.object({ type: z.literal("add_note"), text: z.string() }),
  z.object({ type: z.literal("update_profile"), text: z.string() }),
  /** A new task of the user's own; it can go straight into Today with a status and priority, since it has no id to name yet. */
  z.object({
    type: z.literal("add_task"),
    title: z.string(),
    project_id: z.string().nullish(),
    description: z.string().nullish(),
    today: z.boolean().nullish(),
    status: z.enum(["todo", "in_progress", "waiting", "blocked"]).nullish(),
    priority: z.enum(["critical", "high", "medium", "low"]).nullish(),
  }),
  // Changes to an existing task name it by id, with its title: the planner finds it by title when the
  // id doesn't match one (see findTask).
  /** More about an existing task, in the user's words: added to the end of its description. */
  z.object({ type: z.literal("add_task_context"), task_id: z.string().nullish(), title: z.string().nullish(), text: z.string().min(1) }),
  /** Renames or rewrites one of the user's own tasks, when what it's about has changed. */
  z.object({ type: z.literal("update_task"), task_id: z.string().nullish(), title: z.string().nullish(), new_title: z.string().nullish(), description: z.string().nullish() }),
  /** Files a task under another project (project_id null: under where it was found again, or no project for one of the user's own). */
  z.object({ type: z.literal("set_task_project"), task_id: z.string().nullish(), title: z.string().nullish(), project_id: z.string().nullable() }),
  /** Replaces a task's plan: every step in order, the user's marked "you". */
  z.object({
    type: z.literal("set_task_plan"),
    task_id: z.string().nullish(),
    title: z.string().nullish(),
    steps: z.array(z.object({ title: z.string().min(1), by: z.enum(["claude", "you"]) })).min(1),
  }),
  /** A topic to watch, in the user's words: what to follow, and what to do if it happens or doesn't by a date. */
  z.object({ type: z.literal("watch_topic"), text: z.string().min(1) }),
  /** Plans an existing task for today (Today's tasks), or takes it off. */
  z.object({ type: z.literal("plan_today"), task_id: z.string().nullish(), title: z.string().nullish(), today: z.boolean().default(true) }),
  z.object({ type: z.literal("set_task_status"), task_id: z.string().nullish(), title: z.string().nullish(), status: z.enum(["todo", "in_progress", "waiting", "blocked", "done"]) }),
  z.object({ type: z.literal("set_task_priority"), task_id: z.string().nullish(), title: z.string().nullish(), priority: z.enum(["critical", "high", "medium", "low"]) }),
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
      /** Its issue type's name (Story, Task, Bug…); missing from reads before types were kept. */
      type: z.string().nullish().catch(null),
      /** Its due date (YYYY-MM-DD), null when it has none; missing from reads before due dates were kept. */
      due: z.string().nullish().catch(null),
      /** Its T-shirt size (XS to XXL), null when it has none; missing from reads before sizes were kept. */
      size: z.string().nullish().catch(null),
      assignee: z.string().nullish(),
      /** The assignee's Jira avatar. */
      avatar: z.string().nullish(),
      link: z.string().nullish(),
      /** When it was created, and when it went done (for a done one): for an epic's burndown. */
      created: z.string().nullish().catch(null),
      done_at: z.string().nullish().catch(null),
    }),
  ),
  /** Why the issues couldn't be read (a failed or forbidden search), rather than there being none. */
  error: z.string().nullish(),
  /** The Jira field their sizes were read from, null for none: read again when the sprint's is another. */
  size_field: z.string().nullish(),
});
export type EpicChildren = z.infer<typeof EpicChildren>;

/** Which of a Jira project's sprints the Epics area shows: the one under way, or the next. */
export type SprintChoice = "current" | "upcoming";

/** An issue in a sprint: whether it's done and when it went done (for the sprint's burndown), and who has it. */
const SprintIssue = z.object({
  key: z.string(),
  category: z.enum(["done", "in_progress", "todo"]).catch("todo"),
  /** When it moved to a Done status (its statuscategorychangedate), for a done issue. */
  done_at: z.string().nullish().catch(null),
  /** Who it's assigned to (their display name), and their Jira avatar: null when no one is. */
  assignee: z.string().nullable().catch(null),
  avatar: z.string().nullable().catch(null),
  /** Its issue type's name (Story, Task, Bug…); missing from reads before types were kept. */
  type: z.string().nullish().catch(null),
  /** Its T-shirt size (XS to XXL, see sizes.ts), null when it has none. */
  size: z.string().nullish().catch(null),
});

/** A Jira project's current or upcoming sprint, and the epics with work in it (see sprintEpicsPrompt). */
export const SprintEpics = z.object({
  /** Null when the project has no such sprint (none under way, or none planned yet). */
  sprint: z
    .object({
      name: z.string(),
      /** As Jira gives them: ISO timestamps. */
      start: z.string().nullish(),
      end: z.string().nullish(),
    })
    .nullable()
    .catch(null),
  epics: z
    .array(
      z.object({
        key: z.string(),
        title: z.string(),
        status: z.string().nullish(),
        category: z.enum(["done", "in_progress", "todo"]).catch("todo"),
        link: z.string().nullish(),
        /** Its due date in Jira (YYYY-MM-DD): when it's expected to be done. Null when it has none. */
        due: z.string().nullish().catch(null),
        /** Who it's assigned to in Jira (its owner), and their avatar; null when no one is. Missing from reads before it was kept. */
        assignee: z.string().nullable().catch(null),
        avatar: z.string().nullable().catch(null),
        /** The issues it's under, from the top down (an initiative, and whatever is above that), each with its type, title and link; missing from reads before they were kept. */
        parents: z
          .array(z.object({ key: z.string(), type: z.string().nullish().catch(null), title: z.string().nullish().catch(null), link: z.string().nullish().catch(null) }))
          .nullable()
          .catch(null),
        /** Every one of its issues that has a T-shirt size, in any sprint or none, as "<size>:<category>" ("M:done"); null when sizes weren't read. */
        sized: z.array(z.string()).nullish().catch(null),
        /** Its issues in the sprint. */
        issues: z.array(SprintIssue).default([]),
        /** All its issues, in any sprint or none: how many, how many are done and how many in progress. Null when they couldn't be counted. */
        progress: z.object({ done: z.number().int().nonnegative(), started: z.number().int().nonnegative().catch(0), total: z.number().int().nonnegative() }).nullable().catch(null),
      }),
    )
    .default([]),
  /** Issues in the sprint that aren't in an epic. */
  unparented: z.number().int().nonnegative().catch(0),
  /** Those issues (the Epics area's Unaffiliated list), each with whether it's done. */
  strays: z.array(SprintIssue).catch([]).default([]),
  /** Why the sprint couldn't be read (a failed or forbidden search), rather than it being empty. */
  error: z.string().nullish(),
  /** The Jira field its T-shirt sizes were read from ("customfield_10001"), null when the project has none; missing from reads before sizes. */
  size_field: z.string().nullish().catch(null),
  /** Which way its sizes were read (see SIZES_READ). */
  sizes_read: z.number().nullish().catch(null),
});
export type SprintEpics = z.infer<typeof SprintEpics>;

/** What creating an epic the user reviewed did: the epic, and which stories went into it. */
export const EpicCreated = z.object({
  sent: z.boolean(),
  key: z.string().nullish(),
  link: z.string().nullish(),
  error: z.string().nullish(),
  moved: z.array(z.string()).default([]),
  not_moved: z.array(z.string()).default([]),
});
export type EpicCreated = z.infer<typeof EpicCreated>;

/** What creating a proposed story or task in Jira did. */
export const ItemCreated = z.object({
  sent: z.boolean(),
  key: z.string().nullish(),
  link: z.string().nullish(),
  /** The epic it's in, when it went in one. */
  parent: z.string().nullish(),
  error: z.string().nullish(),
});
export type ItemCreated = z.infer<typeof ItemCreated>;

/** What putting an initiative in Jira did: the initiative, the epics created under it, the stories moved. */
export const InitiativeApplied = z.object({
  sent: z.boolean(),
  key: z.string().nullish(),
  link: z.string().nullish(),
  /** The epics it created, by the name they were proposed under. */
  epics: z.array(z.object({ name: z.string(), key: z.string(), link: z.string().nullish() })).default([]),
  moved: z.array(z.string()).default([]),
  not_moved: z.array(z.string()).default([]),
  error: z.string().nullish(),
});
export type InitiativeApplied = z.infer<typeof InitiativeApplied>;

/** What making a story-sized Jira epic a story did: its type changed, or a story made in its place. */
export const StoryApplied = z.object({
  sent: z.boolean(),
  /** The story's key: the epic's own when its type changed, else the new story's. */
  key: z.string().nullish(),
  link: z.string().nullish(),
  changed_type: z.boolean().default(false),
  moved: z.array(z.string()).default([]),
  not_moved: z.array(z.string()).default([]),
  error: z.string().nullish(),
});
export type StoryApplied = z.infer<typeof StoryApplied>;

export const SentMessage = z.object({ sent: z.boolean(), link: z.string().nullish(), error: z.string().nullish(), moved: z.string().nullish() });

/** An issue as Jira has it, read before or after a change (see changeJiraIssuePrompt). */
const JiraIssueState = z.object({
  category: z.enum(["done", "in_progress", "todo"]).catch("todo"),
  /** Its epic's key, or null when it's in none. */
  epic: z.string().nullable().catch(null),
});

/** What changing a Jira issue the user reviewed did: what took and what Jira refused, and the issue before and after. */
export const JiraIssueChanged = z.object({
  sent: z.boolean(),
  changed: z.array(z.string()).catch([]).default([]),
  not_changed: z.array(z.string()).catch([]).default([]),
  /** Before the change; null when it couldn't be read. */
  before: JiraIssueState.nullable().catch(null).default(null),
  /** After it, as Jira now has it; null when it couldn't be read. */
  issue: JiraIssueState.extend({
    key: z.string(),
    title: z.string().nullable().catch(null),
    status: z.string().nullable().catch(null),
    type: z.string().nullable().catch(null),
    assignee: z.string().nullable().catch(null),
    avatar: z.string().nullable().catch(null),
    due: z.string().nullable().catch(null),
    link: z.string().nullable().catch(null),
    /** The open sprints it's in (active or future), by name. */
    sprints: z.array(z.string()).catch([]).default([]),
  })
    .nullable()
    .catch(null)
    .default(null),
  error: z.string().nullish(),
});
export type JiraIssueChanged = z.infer<typeof JiraIssueChanged>;

/** New, short titles for long-titled tasks, by task id. */
export const ShortTitles = z.object({ titles: z.array(z.object({ id: z.string(), title: z.string() })).default([]) });

/** A watched topic as the user wrote it, read into its fields: a title, details and outcomes. */
export const WatchedEntry = z.object({
  topic: z.string(),
  details: z.string().nullish(),
  /** The id of the user's project it belongs to, from the list they were given, or null. */
  project_id: z.string().nullish(),
  outcomes: z
    .array(
      z.object({
        when: z.enum(["happens", "not_by"]),
        event: z.string(),
        by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        then: z.string(),
      }),
    )
    .default([]),
});
export type WatchedEntry = z.infer<typeof WatchedEntry>;

/** One check of a watched topic: where it stands, and for each open outcome whether its event has happened. */
export const WatchedCheck = z.object({
  summary: z.string(),
  links: z.array(z.object({ title: z.string(), link: z.string() })).default([]),
  outcomes: z
    .array(z.object({ id: z.string(), occurred: z.boolean(), evidence: z.string().nullish(), link: z.string().nullish() }))
    .default([]),
});
export type WatchedCheck = z.infer<typeof WatchedCheck>;

/** Sets of open tasks that are the same work (see SAME_WORK_RULE), each with the one to keep. */
export const SameWork = z.object({
  groups: z.array(z.object({ keep: z.string(), drop: z.array(z.string()).default([]), why: z.string().nullish() })).default([]),
});
export type SameWork = z.infer<typeof SameWork>;

/** What a scan of your Claude Code sessions made of each one (see sessionScanPrompt). */
export const SessionScan = z.object({
  sessions: z
    .array(
      z.object({
        id: z.string(),
        action: z.enum(["connect", "new", "skip"]).catch("skip"),
        task_id: z.string().nullish(),
        title: z.string().nullish(),
        description: z.string().nullish(),
        project_id: z.string().nullish(),
        why: z.string().nullish(),
      }),
    )
    .default([]),
});
export type SessionScan = z.infer<typeof SessionScan>;

/** One check of the user's own Slack DM: the newest message seen, and the #demian messages among the new ones, as written. */
export const SelfDmPoll = z.object({
  /** Why the DM couldn't be read (the Slack connector wasn't connected yet, the read failed); null when it was. */
  unreachable: z.string().nullish(),
  latest_ts: z.string().nullish(),
  /** Each message exactly as written, so the #demian tag can be checked. */
  messages: z.array(z.object({ ts: z.string(), text: z.string() })).default([]),
});
export type SelfDmPoll = z.infer<typeof SelfDmPoll>;

/**
 * What each #demian message asks Demian to do: changes to the planner (GlobalActions, each checked
 * on its own as it's applied, so one malformed change doesn't throw out the rest), or a question
 * for the user when it can't tell.
 */
export const SelfDmActions = z.object({
  results: z
    .array(z.object({ ts: z.string(), actions: z.array(z.unknown()).default([]), question: z.string().nullish() }))
    .default([]),
});

/** The #demian messages Demian reacted to and replied under. */
export const SelfDmReplied = z.object({ done: z.array(z.string()).default([]) });
export type SelfDmActions = z.infer<typeof SelfDmActions>;

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

