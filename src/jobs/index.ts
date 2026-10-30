import { slackThread } from "../projects";
import { runClaude, TOOLS } from "../claude";
import * as db from "../db";
import { adhocPrompt, assessPrompt, calendarPrompt, checkBlockerPrompt, checkTaskPrompt, sendReplyPrompt, type CheckTaskInput, draftReplyPrompt, readingPrompt, sendReminderPrompt, discoveryPrompt, planPrompt, projectPrompt, type PlanPromptInput } from "../prompts";
import { localDate, shouldRunMorning } from "../scheduler";
import { AdhocSnapshot, BlockerCheck, CalendarDay, TaskCheck, DailyReading, Discovery, ManualAssessmentBatch, ProjectSnapshot, ReplyDraft, SentMessage, TaskPlan, type Blocker, type QuickReply } from "../schema";
import { readingContext } from "../reading";
import { JobQueue } from "./queue";
import { collectRepoState } from "./repos";

export const queue = new JobQueue(3);

/** Bumped after every job so the UI knows to reload from the database. */
let version = 0;
const versionListeners = new Set<() => void>();
export const dataVersion = {
  get: () => version,
  subscribe: (l: () => void) => {
    versionListeners.add(l);
    return () => versionListeners.delete(l);
  },
};
function bump() {
  version++;
  versionListeners.forEach((l) => l());
}

/** What each running job is doing right now, keyed like the queue ("project:C123", "adhoc", ...). */
let statuses = new Map<string, string>();
const statusListeners = new Set<() => void>();
export const jobStatus = {
  get: () => statuses,
  subscribe: (l: () => void) => {
    statusListeners.add(l);
    return () => statusListeners.delete(l);
  },
};
function setStatus(key: string, text: string | null) {
  statuses = new Map(statuses);
  if (text) statuses.set(key, text);
  else statuses.delete(key);
  statusListeners.forEach((l) => l());
}

/** Runs a job through the queue, reporting what it's doing under its key until it ends. */
function track<T>(key: string, fn: (status: (text: string) => void) => Promise<T>, limited = true): Promise<T> {
  if (!queue.has(key)) setStatus(key, "Waiting for a free slot");
  return queue.run(
    key,
    async () => {
      const status = (text: string) => setStatus(key, text);
      status("Starting");
      try {
        return await fn(status);
      } finally {
        setStatus(key, null);
      }
    },
    limited,
  );
}

async function model(): Promise<string> {
  return (await db.getSetting("model")) ?? "opus";
}

/** Wraps a job body with the refresh log and a UI reload. */
async function logged<T>(job: string, scope: string | null, fn: () => Promise<{ value: T; costUsd?: number }>): Promise<T> {
  const id = await db.logStart(job, scope);
  try {
    const { value, costUsd } = await fn();
    await db.logFinish(id, { costUsd });
    return value;
  } catch (e) {
    await db.logFinish(id, { error: (e as Error).message });
    throw e;
  } finally {
    bump();
  }
}

async function userId(): Promise<string> {
  const id = await db.getSetting("slack_user_id");
  if (id) return id;
  await discoverProjects();
  return (await db.getSetting("slack_user_id"))!;
}

export function discoverProjects(): Promise<void> {
  return track("discover", (status) =>
    logged("discover", null, async () => {
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: discoveryPrompt(),
        schema: Discovery,
        tools: TOOLS.slackRead,
        // A mechanical listing; the cheaper model is fine here.
        model: "sonnet",
        maxTurns: 10,
      });
      await db.setSetting("slack_user_id", data.user_id);
      await db.upsertChannels(data.channels);
      return { value: undefined, costUsd };
    }),
  );
}

export async function refreshProject(channelId: string): Promise<void> {
  // Resolve before taking a queue slot: discovery needs a slot of its own.
  const uid = await userId();
  return track(`project:${channelId}`, (status) =>
    logged("project", channelId, async () => {
      const project = await db.getProject(channelId);
      if (!project) throw new Error(`Unknown project ${channelId}`);
      try {
        if (project.local_repos.length || project.gh_repos.length) status("Checking repos and PRs");
        const repoState =
          project.local_repos.length || project.gh_repos.length
            ? await collectRepoState(project.local_repos, project.gh_repos)
            : null;
        if (repoState) await db.saveRepoState(channelId, repoState);

        const startedAt = new Date();
        const { data, costUsd } = await runClaude({
        onStatus: status,
          prompt: projectPrompt({
            channelId,
            channelName: project.name,
            userId: uid,
            previous: project.snapshot,
            lastRefreshedAt: project.last_refreshed_at,
            repoState,
            now: startedAt,
          }),
          schema: ProjectSnapshot,
          tools: TOOLS.slackRead,
          model: await model(),
        });
        // Record when this refresh started, so the next one's window covers
        // anything posted while this one ran.
        await db.saveProjectSnapshot(channelId, data, startedAt.toISOString());
        return { value: undefined, costUsd };
      } catch (e) {
        await db.saveProjectError(channelId, (e as Error).message);
        throw e;
      }
    }),
  );
}

export async function refreshAdhoc(): Promise<void> {
  const uid = await userId();
  return track("adhoc", (status) =>
    logged("adhoc", null, async () => {
      const previous = await db.getAdhoc();
      const startedAt = new Date();
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: adhocPrompt({
          userId: uid,
          previous: previous.tasks,
          previousReplies: previous.replies,
          lastRefreshedAt: previous.refreshed_at,
          now: startedAt,
        }),
        schema: AdhocSnapshot,
        tools: [...TOOLS.slackRead, ...TOOLS.gmailRead],
        model: await model(),
        // Reading every DM and mention thread, plus skimming wider channels for news.
        maxTurns: 100,
      });
      await db.saveAdhoc({ tasks: data.tasks, replies: data.replies, news: data.news, refreshed_at: startedAt.toISOString() });
      return { value: undefined, costUsd };
    }),
  );
}

export function refreshCalendar(): Promise<void> {
  return track("calendar", (status) =>
    logged("calendar", null, async () => {
      const projects = await db.listProjects();
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: calendarPrompt({
          date: localDate(new Date()),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          projectNames: projects.filter((p) => !p.hidden).map((p) => p.name),
        }),
        schema: CalendarDay,
        tools: [...TOOLS.calendarRead, ...TOOLS.slackRead, ...TOOLS.gmailRead],
        model: await model(),
      });
      await db.saveCalendarDay(data);
      return { value: undefined, costUsd };
    }),
  );
}

/** Tasks per Claude call when assessing the user's own tasks. */
const ASSESS_BATCH = 12;

/**
 * Has Claude assess the user's own open tasks that don't have an assessment
 * yet, drafting a description where they left none. Works in batches and
 * rechecks between them, so tasks added mid-run are picked up.
 */
export function assessPendingTasks(): Promise<void> {
  return track("assess", async (status) => {
    // Each task gets one try per run, so a result that still lacks steps can't loop forever.
    const tried = new Set<string>();
    for (;;) {
      const [tasks, assessed, states] = await Promise.all([db.listManualTasks(), db.getAssessments(), db.getTaskStates()]);
      // Unassessed tasks, and ones Claude said it can help with but assessed before it listed its steps.
      const missingSteps = (id: string) => {
        const a = assessed.get(id);
        return !!a && a.automation !== "human" && !a.claude_steps?.length;
      };
      const pending = tasks.filter(
        (t) =>
          !tried.has(t.id) && (!assessed.has(t.id) || missingSteps(t.id)) && !states.get(t.id)?.done && !states.get(t.id)?.dismissed,
      );
      if (pending.length === 0) return;
      const batch = pending.slice(0, ASSESS_BATCH);
      for (const t of batch) tried.add(t.id);
      await logged("assess", `${batch.length} tasks`, async () => {
        const { data, costUsd } = await runClaude({
        onStatus: status,
          prompt: assessPrompt({
            userId: await db.getSetting("slack_user_id"),
            tasks: batch.map((t) => ({ id: t.id, title: t.title, description: t.description })),
          }),
          schema: ManualAssessmentBatch,
          tools: [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.jiraRead],
          model: await model(),
          maxTurns: 60,
        });
        const ids = new Set(batch.map((t) => t.id));
        const results = data.assessments.filter((a) => ids.has(a.id));
        if (results.length === 0) throw new Error("Claude returned no assessments for this batch");
        await db.saveAssessments(results);
        return { value: undefined, costUsd };
      });
    }
  });
}

/** Has Claude draft a reply to an Inbox message, for the user to copy. Never sends anything. */
export function draftReply(reply: QuickReply): Promise<void> {
  return track(`draft:${reply.id}`, (status) =>
    logged("draft", reply.id, async () => {
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: draftReplyPrompt(reply, await db.getSetting("slack_user_id")),
        schema: ReplyDraft,
        tools: [...TOOLS.slackRead, ...TOOLS.gmailRead],
        model: await model(),
        maxTurns: 15,
      });
      await db.saveReplyDraft(reply.id, data.draft, costUsd);
      return { value: undefined, costUsd };
    }),
  );
}

/** Has Claude critically re-examine a task: captured right, still needed, not a duplicate. */
export function checkTask(taskId: string, task: CheckTaskInput["task"], otherTasks: string[]): Promise<void> {
  return track(`taskcheck:${taskId}`, (status) =>
    logged("taskcheck", taskId, async () => {
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: checkTaskPrompt({ task, otherTasks, userId: await db.getSetting("slack_user_id") }),
        schema: TaskCheck,
        tools: [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.jiraRead, ...TOOLS.driveRead],
        model: await model(),
      });
      await db.saveTaskCheck(taskId, data);
      return { value: undefined, costUsd };
    }),
  );
}

/** Has Claude dig into whether a blocker is real and whether it was already solved somewhere else. */
export function checkBlocker(
  projectName: string,
  channelId: string,
  blocker: Blocker,
  reminder?: { at: string; link: string | null } | null,
): Promise<void> {
  return track(`check:${blocker.id}`, (status) =>
    logged("check", blocker.id, async () => {
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: checkBlockerPrompt({ projectName, channelId, blocker, reminder, userId: await db.getSetting("slack_user_id") }),
        schema: BlockerCheck,
        tools: [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.jiraRead, ...TOOLS.driveRead],
        model: await model(),
      });
      await db.saveBlockerCheck(blocker.id, data);
      return { value: undefined, costUsd };
    }),
  );
}

/**
 * Posts a reminder the user wrote (and clicked Send on) to a project channel.
 * The only job allowed to write to Slack, and only with slack_send_message.
 */
export function sendReminder(blockerId: string, channelId: string, text: string): Promise<void> {
  return track(`remind:${blockerId}`, (status) =>
    logged("remind", blockerId, async () => {
      const { data, costUsd } = await runClaude({
        onStatus: (s) => status(s === "Working" ? "Posting to Slack" : s),
        prompt: sendReminderPrompt(channelId, text),
        schema: SentMessage,
        tools: TOOLS.slackSend,
        // A mechanical post; the cheaper model is plenty.
        model: "sonnet",
        maxTurns: 3,
      });
      if (!data.sent) throw new Error(data.error ?? "Slack didn't accept the message");
      await db.saveReminder(blockerId, { at: new Date().toISOString(), link: data.link ?? null });
      return { value: undefined, costUsd };
    }),
  );
}

/** Posts the user's reply in a Slack message's thread, then marks the message handled. */
export function sendSlackReply(replyId: string, link: string, text: string): Promise<void> {
  return track(`reply:${replyId}`, (status) =>
    logged("reply", replyId, async () => {
      const thread = slackThread(link);
      if (!thread) throw new Error("Couldn't tell which Slack thread this is");
      const { data, costUsd } = await runClaude({
        onStatus: (s) => status(s === "Working" ? "Posting to Slack" : s),
        prompt: sendReplyPrompt(thread.channelId, thread.threadTs, text),
        schema: SentMessage,
        tools: TOOLS.slackSend,
        // A mechanical post; the cheaper model is plenty.
        model: "sonnet",
        maxTurns: 3,
      });
      if (!data.sent) throw new Error(data.error ?? "Slack didn't accept the message");
      await db.setTaskState(replyId, { status: "done" });
      return { value: undefined, costUsd };
    }),
  );
}

/** Writes today's reading from what the app already knows; no connector reads. */
export function refreshReading(): Promise<void> {
  return track("reading", (status) =>
    logged("reading", null, async () => {
      const today = localDate(new Date());
      const [projects, adhoc, manual, assessments, states, calendar] = await Promise.all([
        db.listProjects(),
        db.getAdhoc(),
        db.listManualTasks(),
        db.getAssessments(),
        db.getTaskStates(),
        db.getCalendarDay(today),
      ]);
      const context = readingContext({ projects, adhoc, manual, assessments, states, calendar: calendar?.day ?? null, today });
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: readingPrompt(context),
        schema: DailyReading,
        tools: [],
        model: await model(),
        maxTurns: 2,
      });
      // Keep only ids that are real tasks, in case the model invents one.
      const ids = new Set(context.tasks.map((t) => t.id));
      await db.saveReading({
        date: today,
        text: data.reading,
        recommended: data.recommended.filter((id) => ids.has(id)),
        created_at: new Date().toISOString(),
      });
      return { value: undefined, costUsd };
    }),
  );
}

export type PlanTask = Omit<PlanPromptInput, "userId"> & { id: string };

/** Asks Claude to research a task and propose a plan; the latest plan per task is kept. */
export function planTask(task: PlanTask): Promise<void> {
  return track(`plan:${task.id}`, (status) =>
    logged("plan", task.id, async () => {
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: planPrompt({ ...task, userId: await db.getSetting("slack_user_id") }),
        schema: TaskPlan,
        tools: [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.calendarRead, ...TOOLS.driveRead, ...TOOLS.jiraRead, ...TOOLS.uknow],
        model: await model(),
      });
      await db.saveTaskPlan(task.id, data, costUsd);
      return { value: undefined, costUsd };
    }),
  );
}

/** Rediscovers channels, then refreshes the calendar, ad-hoc tasks and every visible project. */
export function refreshAll(): Promise<void> {
  return track(
    "all",
    async (status) => {
      await db.setSetting("last_full_refresh_date", localDate(new Date()));
      status("Finding your project channels");
      try {
        await discoverProjects();
      } catch {
        // Still refresh the projects we already know about.
      }
      const projects = (await db.listProjects()).filter((p) => !p.hidden);
      status(`Refreshing ${projects.length} project${projects.length === 1 ? "" : "s"}, your calendar and tasks`);
      await Promise.allSettled([
        refreshCalendar(),
        refreshAdhoc(),
        assessPendingTasks(),
        ...projects.map((p) => refreshProject(p.channel_id)),
      ]);
      // The reading summarizes everything above, so it goes last.
      status("Writing the daily briefing");
      await refreshReading().catch(() => {});
    },
    false,
  );
}

export async function maybeRunMorning(now = new Date()) {
  const due = shouldRunMorning(
    now,
    {
      time: (await db.getSetting("refresh_time")) ?? "07:30",
      weekdaysOnly: ((await db.getSetting("weekdays_only")) ?? "1") === "1",
    },
    await db.getSetting("last_full_refresh_date"),
  );
  if (due) await refreshAll();
}
