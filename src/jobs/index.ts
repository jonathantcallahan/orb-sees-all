import { activeChannels, newRelatedChannels, planDiscovery, projectName, slackThread } from "../projects";
import { acceptedRefinements, buildIndex, type IndexEntry } from "../taskIndex";
import { runClaude, runSessionTurn, TOOLS } from "../claude";
import * as db from "../db";
import { sendToChannelPrompt } from "../prompts";
import { linkSession, type PendingSend } from "../sessions";
import { adhocPrompt, assessPrompt, calendarPrompt, checkBlockerPrompt, checkTaskPrompt, sendReplyPrompt, type CheckTaskInput, draftReplyPrompt, readingPrompt, sendReminderPrompt, discoveryPrompt, planPrompt, projectPrompt, type PlanPromptInput } from "../prompts";
import { localDate, shouldRunMorning } from "../scheduler";
import { AdhocSnapshot, BlockerCheck, CalendarDay, TaskCheck, DailyReading, Discovery, ManualAssessmentBatch, ProjectRefresh, ReplyDraft, SentMessage, TaskPlan, type Blocker, type QuickReply } from "../schema";
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
      const [projects, known] = await Promise.all([db.listProjects(), db.listProjectChannels()]);
      const live = projects.filter((p) => p.state === "tracked" || p.state === "suggested");
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: discoveryPrompt({
          known: live.map((p) => ({
            project_id: p.channel_id,
            name: projectName(p),
            aliases: p.profile?.aliases ?? [],
            channels: activeChannels(p).map((c) => c.name),
          })),
          // Unlinked channels, and every channel of a project the user ignored.
          skip: known
            .filter((c) => c.role === "excluded" || projects.find((p) => p.channel_id === c.project_id)?.state === "ignored")
            .map((c) => c.name),
        }),
        schema: Discovery,
        tools: TOOLS.slackRead,
        // Sorting channels into projects; the cheaper model is fine here.
        model: "sonnet",
        // Paging through every channel, plus a look inside the unclear ones.
        maxTurns: 40,
      });
      await db.setSetting("slack_user_id", data.user_id);
      await db.applyDiscovery(planDiscovery(data.projects, known, new Set(projects.map((p) => p.channel_id))));
      return { value: undefined, costUsd };
    }),
  );
}

/** Every open task from every source, for refreshes to check new work against. */
async function loadTaskIndex(): Promise<IndexEntry[]> {
  const [projects, adhoc, manual, assessments, states, aliases] = await Promise.all([
    db.listProjects(),
    db.getAdhoc(),
    db.listManualTasks(),
    db.getAssessments(),
    db.getTaskStates(),
    db.getTaskAliases(),
  ]);
  const visible = projects.filter((p) => !p.hidden);
  const nameOf = new Map(visible.map((p) => [p.channel_id, projectName(p)]));
  return buildIndex(
    [
      ...manual.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description ?? assessments.get(t.id)?.description,
        project: t.project_id ? nameOf.get(t.project_id) : null,
      })),
      ...visible.flatMap((p) => (p.snapshot?.my_tasks ?? []).map((t) => ({ ...t, project: nameOf.get(p.channel_id) }))),
      ...adhoc.tasks,
    ],
    states,
    aliases,
  );
}

/**
 * Records the refinements a refresh reported: the new item becomes another source of the existing
 * task, and its description (the refresh's update of that task) is kept for the card.
 */
async function recordRefinements(tasks: { id: string; refines?: string | null; description?: string | null }[], index: IndexEntry[]) {
  const accepted = acceptedRefinements(tasks, index, await db.getTaskAliases());
  for (const { id, target } of accepted) {
    await db.addTaskAlias(id, target, "refined");
    const description = tasks.find((t) => t.id === id)?.description;
    if (description) await db.saveRefinedDescription(target, description);
  }
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
        // This project's own tasks are already in its previous snapshot; the index adds everything else.
        const own = new Set((project.snapshot?.my_tasks ?? []).map((t) => t.id));
        const index = (await loadTaskIndex()).filter((e) => !own.has(e.id));
        const { data, costUsd } = await runClaude({
        onStatus: status,
          prompt: projectPrompt({
            index,
            channels: activeChannels(project),
            userId: uid,
            previous: project.snapshot,
            profile: project.profile,
            lastRefreshedAt: project.last_refreshed_at,
            repoState,
            now: startedAt,
          }),
          schema: ProjectRefresh,
          tools: TOOLS.slackRead,
          model: await model(),
        });
        const { profile, related_channels, ...snapshot } = data;
        // Record when this refresh started, so the next one's window covers
        // anything posted while this one ran.
        await db.saveProjectSnapshot(channelId, snapshot, profile, startedAt.toISOString());
        // Channels the project turned up in join it, unless they're already linked somewhere or the user unlinked them.
        for (const c of newRelatedChannels(related_channels, await db.listProjectChannels())) await db.linkChannel(channelId, c, "discovered");
        await recordRefinements(data.my_tasks, index);
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
      const index = await loadTaskIndex();
      const projects = (await db.listProjects()).filter((p) => !p.hidden);
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: adhocPrompt({
          index,
          userId: uid,
          previous: previous.tasks,
          previousReplies: previous.replies,
          projectChannels: projects.flatMap((p) => activeChannels(p).map((c) => c.name)),
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
      await recordRefinements(data.tasks, index);
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
          projectNames: projects.filter((p) => !p.hidden).map((p) => projectName(p)),
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
export function checkTask(taskId: string, task: CheckTaskInput["task"], otherTasks: CheckTaskInput["otherTasks"]): Promise<void> {
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

/**
 * What a working session can use: it reads everything Orb can read and writes nothing. Slack
 * messages it drafts come back to Orb, which posts them once the user approves (sendHandoff).
 */
/** Working sessions run on Opus 5.5 at medium effort: careful enough for multi-step work, without the cost of max effort on every turn. */
const SESSION_MODEL = { model: "claude-opus-5-5", effort: "medium" } as const;

const SESSION_TOOLS = [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.calendarRead, ...TOOLS.driveRead, ...TOOLS.jiraRead, ...TOOLS.uknow];

/**
 * Runs the next turn of a task's working session in the background: the first turn from the start
 * prompt, later ones with the user's reply. The session works until it's done or needs the user,
 * reporting through its transcript; the user never has to open Claude unless they want to.
 */
function runTaskSession(taskId: string, prompt: string): Promise<void> {
  return track(`session:${taskId}`, (status) =>
    logged("session", taskId, async () => {
      const link = (await db.getSessionLinks())[taskId];
      await db.updateSessionLink(taskId, { lastError: null });
      try {
        const turn = await runSessionTurn({ prompt, tools: SESSION_TOOLS, ...SESSION_MODEL, resume: link?.sessionId, onStatus: status });
        if (turn.sessionId) await db.updateSessionLink(taskId, { sessionId: turn.sessionId });
        if (turn.error) throw new Error(turn.error);
        return { value: undefined, costUsd: turn.costUsd };
      } catch (e) {
        await db.updateSessionLink(taskId, { lastError: (e as Error).message });
        throw e;
      }
    }),
  );
}

/** Starts a working session for a task (Approve & start). */
export async function startTaskSession(taskId: string, prompt: string): Promise<void> {
  await linkSession(taskId);
  bump();
  return runTaskSession(taskId, prompt);
}

/** Continues a task's working session with the user's answer to what it asked. */
export async function continueTaskSession(taskId: string, message: string): Promise<void> {
  // One turn at a time: a turn still running would swallow this one (the queue dedupes by key), so wait it out.
  const key = `session:${taskId}`;
  while (queue.has(key)) await queue.run(key, async () => {}).catch(() => {});
  return runTaskSession(taskId, message);
}

/**
 * Posts a Slack message a working session handed over, as the user wrote or approved it, then
 * records it as sent (finishing its step) and tells the session so it carries on.
 */
export function sendHandoff(taskId: string, send: PendingSend, text: string): Promise<void> {
  return track(`handoff:${taskId}`, (status) =>
    logged("send", taskId, async () => {
      const thread = slackThread(send.to);
      const { data, costUsd } = await runClaude({
        onStatus: (s) => status(s === "Working" ? "Posting to Slack" : s),
        prompt: thread ? sendReplyPrompt(thread.channelId, thread.threadTs, text) : sendToChannelPrompt(send.to, text),
        schema: SentMessage,
        // A channel by name needs looking up first.
        tools: thread ? TOOLS.slackSend : [...TOOLS.slackSend, ...TOOLS.slackRead],
        model: "sonnet",
        maxTurns: 6,
      });
      if (!data.sent) throw new Error(data.error ?? "Slack didn't accept the message");
      const link = (await db.getSessionLinks())[taskId];
      await db.updateSessionLink(taskId, {
        sentKeys: [...(link?.sentKeys ?? []), send.key],
        ...(send.step ? { doneSteps: [...(link?.doneSteps ?? []), send.step] } : {}),
      });
      const edited = text !== send.text ? ` I edited it first; this is what went out:\n\n${text}` : "";
      continueTaskSession(taskId, `I sent the message to ${send.to}${data.link ? ` (${data.link})` : ""}.${edited}\n\nCarry on with the next step.`).catch(() => {});
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
  // Not until first-run setup is done: without Claude Code and the connectors every job would fail.
  if (!(await db.getSetting("setup_done"))) return;
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
