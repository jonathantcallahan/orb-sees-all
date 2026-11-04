import { activeChannels, mergeProfile, newRelatedChannels, planDiscovery, projectContext, projectName, projectStatus, slackThread } from "../projects";
import { acceptedRefinements, buildIndex, type IndexEntry } from "../taskIndex";
import { runClaude, runSessionTurn, TOOLS } from "../claude";
import * as db from "../db";
import { createDocPrompt, createEventPrompt, distillPrompt, epicCheckPrompt, epicChildrenPrompt, learnRolePrompt, recheckStepsPrompt, sendToChannelPrompt, setUserProfile } from "../prompts";
import { approvedPlanMessage, globalChatPrompt } from "../openInClaude";
import { linkSession, ORB_NOTE, sendDestination, type PendingSend, type PlanStep, type SessionLink, type SessionProgress, type StepProgress } from "../sessions";
import { adhocPrompt, assessPrompt, calendarPrompt, checkBlockerPrompt, checkTaskPrompt, sendReplyPrompt, type CheckTaskInput, readingPrompt, sendReminderPrompt, discoveryPrompt, planPrompt, projectPrompt, type PlanPromptInput } from "../prompts";
import { localDate, shouldRunMorning } from "../scheduler";
import { AdhocSnapshot, Distilled, EpicChildren, BlockerCheck, CalendarDay, TaskCheck, DailyReading, Discovery, ManualAssessmentBatch, ProjectEpic, ProjectRefresh, LearnedRole, SentMessage, StepRecheck, TaskPlan, type Blocker } from "../schema";
import { blockerKey } from "../tasks";
import { readingContext } from "../reading";
import { asUserHasIt, keepDismissed, learningFor, lessonsFor, planLearning } from "../feedback";
import { codeFor, codeNote, githubReposOf, projectOfTask } from "../code";
import { JobQueue } from "./queue";
import { collectRepoState } from "./repos";
import { byRecency, collectTracking, epicItem, projectRepos, recheckGithubItem, type TrackedItem } from "./tracking";

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
  const [projects, adhoc, manual, assessments, states, aliases, descriptions, notDuplicates] = await Promise.all([
    db.listProjects(),
    db.getAdhoc(),
    db.listManualTasks(),
    db.getAssessments(),
    db.getTaskStates(),
    db.getTaskAliases(),
    db.getDescriptionOverrides(),
    db.getNotDuplicates(),
  ]);
  const visible = projects.filter((p) => !p.hidden);
  const nameOf = new Map(visible.map((p) => [p.channel_id, projectName(p)]));
  const entries = buildIndex(
    [
      ...manual.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description ?? assessments.get(t.id)?.description,
        project: t.project_id ? nameOf.get(t.project_id) : null,
      })),
      // Tasks as the user has them: their edited description over the refresh's.
      ...visible.flatMap((p) => (p.snapshot?.my_tasks ?? []).map((t) => ({ ...t, description: descriptions[t.id] ?? t.description, project: nameOf.get(p.channel_id) }))),
      ...adhoc.tasks.map((t) => ({ ...t, description: descriptions[t.id] ?? t.description })),
    ],
    states,
    aliases,
  );
  // Pairs the user said aren't duplicates, so a refresh never folds one into the other.
  const listed = new Set(entries.map((e) => e.id));
  const separate = new Map<string, string[]>();
  for (const key of notDuplicates) {
    const [a, b] = key.split("|");
    if (!listed.has(a) || !listed.has(b)) continue;
    separate.set(a, [...(separate.get(a) ?? []), b]);
    separate.set(b, [...(separate.get(b) ?? []), a]);
  }
  return entries.map((e) => (separate.has(e.id) ? { ...e, not_same_as: separate.get(e.id) } : e));
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
        // What the user has taught it about this project, and its tasks as the user has them.
        const [learning, descriptions, priorities] = await Promise.all([
          learningFor(channelId, ["projects", "tasks", "priority"]),
          db.getDescriptionOverrides(),
          db.getPriorityOverrides(),
        ]);
        const previous = project.snapshot
          ? { ...project.snapshot, my_tasks: project.snapshot.my_tasks.map((t) => asUserHasIt(t, descriptions, priorities)) }
          : null;
        const { data, costUsd } = await runClaude({
        onStatus: status,
          prompt: projectPrompt({
            index,
            channels: activeChannels(project),
            userId: uid,
            previous,
            profile: project.profile,
            excluded: project.channels.filter((c) => c.role === "excluded").map((c) => c.channel_id),
            learning,
            lastRefreshedAt: project.last_refreshed_at,
            repoState,
            now: startedAt,
            statusSetByUser:
              project.status_override && (!project.last_refreshed_at || project.status_override.at > project.last_refreshed_at) ? project.status_override : null,
          }),
          schema: ProjectRefresh,
          // Jira too, to find the project's epics.
          tools: [...TOOLS.slackRead, ...TOOLS.jiraRead],
          model: await model(),
        });
        const { profile: found, related_channels, epics, ...snapshot } = data;
        // What's known builds up: the refresh's profile folds into the last one (kept in history),
        // with the user's own names for the project among its aliases.
        if (project.profile) await db.archiveProfile(channelId, project.profile);
        const profile = mergeProfile(project.profile, found, project.focus?.aliases ?? []);
        // Record when this refresh started, so the next one's window covers
        // anything posted while this one ran.
        await db.saveProjectSnapshot(channelId, snapshot, profile, startedAt.toISOString());
        // Channels the project turned up in join it, unless they're already linked somewhere or the user unlinked them.
        for (const c of newRelatedChannels(related_channels, await db.listProjectChannels())) await db.linkChannel(channelId, c, "discovered");
        // Its tracking feed: the epics just found, and its repos' PRs and branches (read locally with gh).
        status("Checking GitHub");
        const links = [...profile.resources.map((r) => r.link), ...snapshot.recent_updates.map((u) => u.link), ...snapshot.my_tasks.map((t) => t.link)];
        await db.saveProjectTracking(channelId, await collectTracking(projectRepos(project.gh_repos, links), epics));
        await recordRefinements(data.my_tasks, index);
        await keepDismissed(data.my_tasks, channelId);
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
      const [learning, descriptions, priorities] = await Promise.all([learningFor(null, ["tasks", "priority"]), db.getDescriptionOverrides(), db.getPriorityOverrides()]);
      const projects = (await db.listProjects()).filter((p) => !p.hidden);
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: adhocPrompt({
          index,
          userId: uid,
          previous: previous.tasks.map((t) => asUserHasIt(t, descriptions, priorities)),
          previousReplies: previous.replies,
          learning,
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
      await keepDismissed(data.tasks, null);
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
        // A task added as a detailed note gets the short title written for it; the note becomes its brief.
        for (const r of results) {
          const t = batch.find((b) => b.id === r.id);
          const title = r.title?.trim();
          if (t && title && title !== t.title.trim()) await db.retitleManualTask(t.id, title, t.title);
        }
        return { value: undefined, costUsd };
      });
    }
  });
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
  kind: "blocker" | "active" = "blocker",
): Promise<void> {
  return track(`check:${blocker.id}`, (status) =>
    logged("check", blocker.id, async () => {
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: checkBlockerPrompt({ projectName, channelId, blocker, reminder, kind, userId: await db.getSetting("slack_user_id") }),
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

/**
 * What a working session can use: it reads everything Orb can read and writes nothing. Slack
 * messages it drafts come back to Orb, which posts them once the user approves (sendHandoff).
 */
/** Working sessions run on Opus 5.5 at medium effort: careful enough for multi-step work, without the cost of max effort on every turn. */
const SESSION_MODEL = { model: "claude-opus-5-5", effort: "medium" } as const;

/** A message asking for a Google Doc (or turning something into one). */
const DOC_ASK = /\b(google\s*)?docs?\b|\bdocument\b/i;
/** A message stating a lasting preference ("stop using…", "don't…", "always…", "from now on…"). */
const PREFERENCE_ASK = /\b(stop|don'?t|do not|never|always|from now on|going forward|in future|next time)\b/i;
const PREFERENCE_REMINDER =
  ORB_NOTE +
  " if this is a lasting preference, hand it to me on its own line as `[orb] remember <scope>: <the preference, as an instruction>` (scope: plans, writing, tasks, priority, projects or global). I save it and apply it to every later plan, refresh and session. You can't save memories or files yourself, so don't try or say you couldn't.)";

/** A message asking to schedule something or about the calendar. */
const EVENT_ASK = /\b(schedul\w*|invite|meeting|calendar|book (a|some) time|set up a (call|meeting|sync))\b/i;
const EVENT_REMINDER =
  ORB_NOTE + " you can read my calendar, find a time that's free for every attendee with suggest_time (look up their emails in Slack first, and never pick a time from my calendar alone), and have me create events: write the invite as a block, a line `[orb] event: <title>` (or `[orb] event step N: <title>`), then `when:`, `who:` and optionally `meet: yes` lines, a blank line, the description, and `[orb] end`. I show it to the user to review, create it and send the invites. Don't call create_event yourself, and don't say you lack calendar access.)";
const DOC_REMINDER =
  ORB_NOTE + " you can make Google Docs here, through me. Write the doc as a block, a line `[orb] doc: <title>` (or `[orb] doc step N: <title>` for a plan step), then its content in Markdown, then `[orb] end`. I show it to the user to review and create it in their Drive, then send you its link. Don't call any Drive or Docs tool, and don't say you can't make docs or that it needs a permission; if you said so earlier, that was wrong.)";

const SESSION_TOOLS = [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.calendarRead, ...TOOLS.driveRead, ...TOOLS.jiraRead, ...TOOLS.zoomRead, ...TOOLS.amplitudeRead];

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
        // After a re-check, the session sees the list Orb shows, so its step numbers match it.
        const steps = link?.recheck?.plan
          .map((st, i) => {
            const s = link.recheck!.states[i + 1];
            return `${i + 1}. ${st.by === "you" ? "[Me] " : ""}${st.title} (${s ? s.state : "not started"})`;
          })
          .join("\n");
        // Sessions carry out plans and write messages for the user, so they get those lessons too.
        const lessons = await lessonsFor(["plans", "writing"]);
        // The code they can read: the task's project's, or for the Demian chat every project's that's
        // already on hand (it spans them all, so it doesn't clone).
        // A task filed under no project gets the same as the Demian chat, so a question only the code
        // answers never finds it missing.
        const global = taskId.startsWith("global:");
        const own = global ? null : await projectOfTask(taskId);
        const everyProject = !own;
        const codeProjects = everyProject ? (await db.listProjects()).filter((p) => p.state === "tracked") : [own];
        const code = codeProjects.length ? await codeFor(codeProjects, !everyProject, everyProject ? 12 : 4) : [];
        const context = [
          taskId.startsWith("global:")
            ? await globalContext(link)
            : steps
              ? `My planner now shows these steps; number your [orb] reports against this list:\n${steps}`
              : "",
          lessons.length ? `What my corrections have taught you about how I like plans and messages:\n${lessons.map((l) => `- ${l}`).join("\n")}` : "",
          codeNote(code, everyProject ? [] : codeProjects),
        ]
          .filter(Boolean)
          .join("\n\n") || undefined;
        // The reply as it's written, for the chat to show live: at most every 80ms, and always the
        // latest text in the end (Claude Code sends a reply in quick bursts, so a dropped update can be
        // most of it).
        const liveKey = `live:${taskId}`;
        let latest = "";
        let flush = 0;
        let last = 0;
        const publish = () => {
          flush = 0;
          last = Date.now();
          setStatus(liveKey, latest);
        };
        const onText = (text: string) => {
          latest = text;
          const wait = 80 - (Date.now() - last);
          if (wait <= 0) publish();
          else if (!flush) flush = window.setTimeout(publish, wait);
        };
        // Asked for a doc: say plainly how, every time. A session that once decided it can't make
        // docs (it can't call Drive itself) keeps saying so from its own history otherwise.
        const asked = [prompt, DOC_ASK.test(prompt) ? DOC_REMINDER : "", EVENT_ASK.test(prompt) ? EVENT_REMINDER : "", PREFERENCE_ASK.test(prompt) ? PREFERENCE_REMINDER : ""].filter(Boolean).join("\n\n");
        const turn = await runSessionTurn({ prompt: asked, tools: SESSION_TOOLS, ...SESSION_MODEL, resume: link?.sessionId, onStatus: status, context, onText, dirs: code.map((c) => c.dir) }).finally(() => {
          // The whole reply goes out before it's cleared, so the chat holds all of it until the
          // transcript's copy arrives.
          window.clearTimeout(flush);
          if (latest) setStatus(liveKey, latest);
          window.setTimeout(() => setStatus(liveKey, null), 60);
        });
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

/** How many of a project's open blockers and active items the global chat's context lists. */
const CONTEXT_ITEMS = 3;
/** The same for a blocked or at-risk project. */
const CONTEXT_ITEMS_URGENT = 8;

/** What the planner shows right now, for the global chat's next turn, so it works from current ids. */
async function globalContext(link: SessionLink | undefined): Promise<string> {
  const [projects, reading, adhoc, manual, states, profile, notes] = await Promise.all([
    db.listProjects(),
    db.getReading(),
    db.getAdhoc(),
    db.listManualTasks(),
    db.getTaskStates(),
    db.getSetting("user_profile"),
    db.getNotes(),
  ]);
  const open = (id: string) => !["done"].includes(states.get(id)?.status ?? "todo") && !states.get(id)?.dismissed;
  const projectLines = projects
    .filter((p) => p.state !== "merged")
    .map((p) => {
      const channels = p.channels.filter((c) => c.role !== "excluded").map((c) => `#${c.name} (${c.channel_id})`).join(", ");
      const shown = projectStatus(p);
      const setByMe = p.status_override && shown === p.status_override.status && p.status_override.at > (p.last_refreshed_at ?? "");
      const status = shown ? ` — ${shown}${setByMe ? " (set by me)" : p.snapshot ? `: ${p.snapshot.status_reason}` : ""}` : "";
      // Open blockers and active work, with ids, so the chat can mark them done or check them.
      const items = p.state === "tracked" && p.snapshot
        ? [...p.snapshot.blockers.map((b) => ({ ...b, kind: "blocker" })), ...(p.snapshot.active ?? []).map((a) => ({ ...a, kind: "active" }))]
            .filter((it) => !states.get(blockerKey(it.id))?.dismissed)
            .map((it) => `${it.kind} [id ${it.id}] ${it.what} (${it.owners.map((o) => (o.is_me ? "me" : o.name)).join(", ") || "no owner"})`)
        : [];
      // A few per project, blockers first, so the context stays short however big the board gets;
      // a project that's blocked or at risk shows more, since it's the likeliest to come up.
      const cap = shown === "blocked" || shown === "at_risk" ? CONTEXT_ITEMS_URGENT : CONTEXT_ITEMS;
      if (items.length > cap) items.splice(cap, items.length, `${items.length - cap} more not listed`);
      const context = projectContext(p)
        .map((c) => `${c.text}${c.by === "you" ? " (mine)" : ""}`)
        .join("; ");
      const repos = [...p.local_repos, ...githubReposOf(p)];
      return `- ${projectName(p)} [id ${p.channel_id}, ${p.state}] channels: ${channels}${status}${context ? `. Context: ${context}` : ""}. Code: ${repos.length ? repos.join(", ") : "none mapped"}${items.length ? `\n  Open: ${items.join("; ")}` : ""}`;
    });
  const calendar = await db.getCalendarDay(localDate(new Date()));
  const tasks = [
    ...projects
      .filter((p) => p.state === "tracked")
      .flatMap((p) => (p.snapshot?.my_tasks ?? []).map((t) => ({ id: t.id, title: t.title, where: projectName(p), gist: t.description }))),
    ...adhoc.tasks.map((t) => ({ id: t.id, title: t.title, where: t.source, gist: t.description })),
    ...manual.map((t) => ({ id: t.id, title: t.title, where: "added by me", gist: t.description })),
    ...(calendar?.day.events ?? []).flatMap((ev) => ev.prep.map((p) => ({ id: p.id, title: p.title, where: `prep for ${ev.title}`, gist: null }))),
  ].filter((t) => open(t.id));
  const today = localDate(new Date());
  const taskLine = (t: (typeof tasks)[number]) => {
    const st = states.get(t.id);
    const gist = t.gist ? ` — ${t.gist.replace(/\s+/g, " ").slice(0, 120)}` : "";
    return `- [id ${t.id}] ${t.title} (${t.where}${st?.todayOn === today ? ", in Today's tasks" : ""}${st?.status && st.status !== "todo" ? `, ${st.status.replace("_", " ")}` : ""})${gist}`;
  };
  return [
    "What my planner shows right now:",
    `About me: ${profile?.trim() || "(not set)"}`,
    notes.length ? `Corrections I've already given:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
    `Projects (tracked ones are on the board; suggested and ignored ones aren't):\n${projectLines.join("\n") || "(none)"}`,
    reading ? `Today's briefing: ${reading.text}` : "",
    `My open tasks (use these ids in task changes):\n${tasks.slice(0, 120).map(taskLine).join("\n") || "(none)"}`,
    link?.applied && Object.keys(link.applied).length
      ? `Changes you proposed that I've applied (the rest I haven't, or turned down):\n${Object.values(link.applied).map((a) => `- ${a.summary}. ${a.result}`).join("\n")}`
      : "",
    link?.dismissedKeys?.length ? `I turned down ${link.dismissedKeys.length} of your proposed changes.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Re-checks a working session's steps against its conversation when they've drifted (a report went
 * missing, or a decision changed the plan), and keeps the result: the card shows it, with the
 * session's later reports on top, and the session is shown the same list on its next turn so its
 * step numbers line up.
 */
export function recheckSessionSteps(
  taskId: string,
  task: string,
  steps: { title: string; by: "claude" | "you" | null; progress?: StepProgress }[],
  progress: SessionProgress,
): Promise<void> {
  const key = `${progress.reports ?? 0}:${progress.messages?.length ?? 0}`;
  return track(`recheck:${taskId}`, (status) =>
    logged("recheck", taskId, async () => {
      // Recorded first, so a failed re-check isn't retried until the conversation moves on.
      await db.updateSessionLink(taskId, { recheckedKey: key });
      status("Re-checking the steps");
      const { data, costUsd } = await runClaude({
        prompt: recheckStepsPrompt({
          task,
          steps: steps.map((st) => ({ title: st.title, by: st.by, state: st.progress?.state ?? null, note: st.progress?.note })),
          conversation: progress.messages ?? [],
        }),
        schema: StepRecheck,
        tools: [],
        model: "sonnet",
        maxTurns: 2,
      });
      const plan: PlanStep[] = data.steps.map((st) => ({ title: st.title, by: st.by }));
      const states: Record<number, StepProgress> = {};
      data.steps.forEach((st, i) => {
        if (st.state !== "todo") states[i + 1] = st.note ? { state: st.state, note: st.note } : { state: st.state };
      });
      if (plan.length) await db.updateSessionLink(taskId, { recheck: { plan, states, reports: progress.reports ?? 0 } });
      return { value: undefined, costUsd };
    }),
  );
}

/** Starts a working session for a task (Approve & start). */
export async function startTaskSession(taskId: string, prompt: string): Promise<void> {
  await linkSession(taskId);
  bump();
  return runTaskSession(taskId, prompt);
}

/**
 * Opens a task's session to talk the plan through first (Discuss plan). Resolves once the task is
 * linked, while Claude's opening turn runs on; `onTurn` hears when that turn ends.
 */
export async function discussTaskPlan(taskId: string, prompt: string, onTurn: () => void): Promise<void> {
  await linkSession(taskId);
  await db.updateSessionLink(taskId, { discussing: true });
  bump();
  runTaskSession(taskId, prompt).then(onTurn, onTurn);
}

/**
 * Opens a chat session about something that isn't a task (an update to explain, a message to reply
 * to). It's a session like a task's, keyed by `key`; resolves once it's linked, while Claude's first
 * answer is written.
 */
export async function startChatSession(key: string, prompt: string, onTurn: () => void): Promise<void> {
  await linkSession(key);
  bump();
  runTaskSession(key, prompt).then(onTurn, onTurn);
}

/** The global chat's current conversation, kept across restarts until New chat starts another. */
export async function globalChatKey(fresh = false): Promise<string> {
  const current = await db.getSetting("global_chat_key");
  if (current && !fresh) return current;
  const key = `global:${Date.now()}`;
  await db.setSetting("global_chat_key", key);
  return key;
}

/** Starts the global chat's session with the user's first message; resolves once it's linked. */
export async function startGlobalChat(key: string, message: string, onTurn: () => void): Promise<void> {
  await linkSession(key);
  bump();
  runTaskSession(key, globalChatPrompt(key, message)).then(onTurn, onTurn);
}

/** The user approved the plan they discussed: the same session starts the work, as agreed. */
export async function approveDiscussedPlan(taskId: string): Promise<void> {
  await db.updateSessionLink(taskId, { discussing: false });
  bump();
  return continueTaskSession(taskId, approvedPlanMessage());
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
      const doc = send.kind === "doc";
      const event = send.kind === "event";
      const thread = doc || event ? null : slackThread(send.to);
      const { data, costUsd } = await runClaude({
        onStatus: (s) => status(s === "Working" ? (doc ? "Creating the doc" : event ? "Creating the event" : "Posting to Slack") : s),
        prompt: doc
          ? createDocPrompt(send.to, text)
          : event
            ? createEventPrompt(send.to, text)
            : thread
              ? sendReplyPrompt(thread.channelId, thread.threadTs, text)
              : sendToChannelPrompt(send.to, text),
        schema: SentMessage,
        // A channel by name needs looking up first.
        tools: doc ? TOOLS.docCreate : event ? TOOLS.eventCreate : thread ? TOOLS.slackSend : [...TOOLS.slackSend, ...TOOLS.slackRead],
        model: "sonnet",
        maxTurns: 6,
      });
      if (!data.sent)
        throw new Error(data.error ?? (doc ? "Google Drive didn't create the doc" : event ? "Google Calendar didn't create the event" : "Slack didn't accept the message"));
      const link = (await db.getSessionLinks())[taskId];
      // Its link, kept with the step it finished, for a chip beside that step.
      const artifact = data.link
        ? [{ ...(send.step ? { step: send.step } : {}), url: data.link, title: doc || event ? send.to : `Message in ${sendDestination(send)}` }]
        : [];
      await db.updateSessionLink(taskId, {
        sentKeys: [...(link?.sentKeys ?? []), send.key],
        artifacts: [...(link?.artifacts ?? []), ...artifact],
        ...(send.step ? { doneSteps: [...(link?.doneSteps ?? []), send.step] } : {}),
      });
      const edited = text !== send.text ? ` I edited it first; this is what ${doc || event ? "it says" : "went out"}:\n\n${text}` : "";
      // How the user rewrote Claude's draft says something about how they write.
      if (text !== send.text)
        db.logFeedback({ kind: "message_edit", subject: "message", subject_id: taskId, before: { to: send.to, text: send.text }, after: { text } }).catch(() => {});
      continueTaskSession(
        taskId,
        `${doc ? `I created the Google Doc "${send.to}"` : event ? `I created the event "${send.to}" and sent its invites${data.moved ? `, moved to ${data.moved} since the reviewed time was no longer free for everyone` : ""}` : `I sent the message to ${sendDestination(send)}${send.to.startsWith("http") ? ` (${send.to})` : ""}`}${data.link ? ` (${data.link})` : ""}.${edited}\n\nCarry on with the next step.`,
      ).catch(() => {});
      return { value: undefined, costUsd };
    }),
  );
}

/** Rebuilds a project's tracking feed now: GitHub read again, epics as the last refresh found them. */
export function refreshTracking(projectId: string): Promise<void> {
  return track(`tracking:${projectId}`, async () => {
    const [project, stored] = await Promise.all([db.getProject(projectId), db.getProjectTracking()]);
    if (!project) return;
    const prior = stored[projectId];
    const links = [...(project.profile?.resources ?? []).map((r) => r.link), ...(project.snapshot?.recent_updates ?? []).map((u) => u.link)];
    const repos = projectRepos(project.gh_repos, [...links, ...(prior?.repos ?? []).map((r) => `https://github.com/${r}`)]);
    await db.saveProjectTracking(projectId, await collectTracking(repos, prior?.epics ?? []));
    bump();
  });
}

/** Reads an epic's child issues and their assignees from Jira, for its row in the tracking feed. */
export function loadEpicChildren(key: string): Promise<void> {
  return track(`epic:${key}`, (status) =>
    logged("epic", key, async () => {
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: epicChildrenPrompt(key),
        schema: EpicChildren,
        tools: TOOLS.jiraRead,
        model: "sonnet",
        maxTurns: 8,
      });
      await db.saveEpicChildren(key, data);
      bump();
      return { value: undefined, costUsd };
    }),
  );
}

/** Looks at one item in a project's tracking feed again: a PR or branch with gh, an epic through Jira. */
export function recheckTrackedItem(projectId: string, item: TrackedItem): Promise<void> {
  return track(`tracking:${item.id}`, (status) =>
    logged("tracking", item.id, async () => {
      let fresh: TrackedItem | null = null;
      let costUsd = 0;
      let epic: ProjectEpic | null = null;
      if (item.kind === "epic") {
        const res = await runClaude({
          onStatus: status,
          prompt: epicCheckPrompt(item.id.slice("epic:".length)),
          schema: ProjectEpic,
          tools: TOOLS.jiraRead,
          model: "sonnet",
          maxTurns: 8,
        });
        epic = res.data;
        fresh = epicItem(res.data);
        costUsd = res.costUsd;
      } else fresh = await recheckGithubItem(item);
      const tracking = (await db.getProjectTracking())[projectId];
      if (tracking) {
        // A branch that's gone (merged and deleted) drops out of the feed.
        const items = tracking.items.flatMap((x) => (x.id === item.id ? (fresh ? [fresh] : []) : [x])).sort(byRecency);
        const epics = epic ? tracking.epics.map((e) => (e.key === epic!.key ? epic! : e)) : tracking.epics;
        await db.saveProjectTracking(projectId, { ...tracking, items, epics });
      }
      return { value: undefined, costUsd };
    }),
  );
}

/** Writes today's reading from what the app already knows; no connector reads. */
export function refreshReading(): Promise<void> {
  return track("reading", (status) =>
    logged("reading", null, async () => {
      const today = localDate(new Date());
      const [projects, adhoc, manual, assessments, states, calendar, priorityOverrides, plans] = await Promise.all([
        db.listProjects(),
        db.getAdhoc(),
        db.listManualTasks(),
        db.getAssessments(),
        db.getTaskStates(),
        db.getCalendarDay(today),
        db.getPriorityOverrides(),
        db.getTaskPlans(),
      ]);
      const context = readingContext({ projects, adhoc, manual, assessments, states, calendar: calendar?.day ?? null, today, priorityOverrides, plans });
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
      // The task's project code, so the plan can rest on how things are actually built.
      const project = await projectOfTask(task.id);
      if (project) status("Getting the code");
      const code = project ? await codeFor([project]) : [];
      const note = codeNote(code, project ? [project] : []);
      const { data, costUsd } = await runClaude({
        onStatus: status,
        dirs: code.map((c) => c.dir),
        prompt: `${planPrompt({ ...task, userId: await db.getSetting("slack_user_id"), learning: await planLearning() })}${note ? `\n\n${note}` : ""}`,
        schema: TaskPlan,
        tools: [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.calendarRead, ...TOOLS.driveRead, ...TOOLS.jiraRead, ...TOOLS.zoomRead, ...TOOLS.amplitudeRead],
        model: await model(),
      });
      await db.saveTaskPlan(task.id, data, costUsd);
      return { value: undefined, costUsd };
    }),
  );
}

/** Rediscovers channels, then refreshes the calendar, ad-hoc tasks and every visible project. */
/**
 * Works out the user's role from their Slack profile and activity, calendar and Jira, and saves it
 * as the prompts' description of them (the chat can correct it), along with the first name they go by.
 * Returns the role.
 */
/** How often Claude looks at the user's role again, in the morning refresh. */
const ROLE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

export function learnRole(): Promise<string> {
  return track("role", (status) =>
    logged("role", null, async () => {
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: learnRolePrompt(),
        schema: LearnedRole,
        tools: [...TOOLS.slackRead, ...TOOLS.calendarRead, ...TOOLS.jiraRead],
        model: "sonnet",
        maxTurns: 14,
      });
      const role = data.role.trim();
      if (role) {
        await db.setSetting("user_profile", role);
        setUserProfile(role);
      }
      await db.setSetting("user_profile_at", String(Date.now()));
      const name = data.name?.trim();
      if (name) await db.setSetting("user_name", name);
      return { value: role, costUsd };
    }),
  );
}

/** Distil after this many new corrections, or once a day when there are any. */
const DISTILL_AFTER = 5;
const DISTILL_EVERY_MS = 24 * 60 * 60 * 1000;

/** Distils the user's corrections into lessons when enough have built up (see distillLessons). */
export async function maybeDistill(): Promise<void> {
  if (!(await db.getSetting("setup_done"))) return;
  const pending = await db.listFeedback({ undistilled: true, limit: DISTILL_AFTER });
  if (!pending.length) return;
  const last = Number((await db.getSetting("lessons_distilled_at")) ?? 0);
  if (pending.length >= DISTILL_AFTER || Date.now() - last > DISTILL_EVERY_MS) await distillLessons();
}

/**
 * Turns the user's corrections into lessons: short, scoped guidance that every later refresh,
 * plan and session is given (see lessonsFor). Also infers a reason for corrections given none.
 * Lessons the user wrote or edited are kept as they are.
 */
export function distillLessons(): Promise<void> {
  return track("lessons", (status) =>
    logged("lessons", null, async () => {
      status("Learning from your corrections");
      const [feedback, lessons, projects] = await Promise.all([db.listFeedback({ limit: 150 }), db.listLessons(), db.listProjects()]);
      const names = new Map(projects.map((p) => [p.channel_id, projectName(p)]));
      const { data, costUsd } = await runClaude({
        prompt: distillPrompt({
          feedback: feedback.map((f) => ({
            id: f.id,
            kind: f.kind,
            at: f.at,
            project: f.project_id ? (names.get(f.project_id) ?? f.project_id) : null,
            before: f.before,
            after: f.after,
            reason: f.reason,
          })),
          lessons: lessons.map((l) => ({ scope: l.scope, text: l.text, evidence: l.evidence, origin: l.origin })),
          projects: projects.filter((p) => p.state === "tracked").map((p) => ({ id: p.channel_id, name: projectName(p) })),
        }),
        schema: Distilled,
        tools: [],
        model: "sonnet",
        maxTurns: 2,
      });
      const known = new Set(feedback.map((f) => f.id));
      for (const r of data.reasons) if (known.has(r.id) && !feedback.find((f) => f.id === r.id)?.reason) await db.setFeedbackReason(r.id, r.reason, "inferred");
      await db.replaceLearnedLessons(data.lessons.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text));
      await db.markDistilled(feedback.map((f) => f.id));
      await db.setSetting("lessons_distilled_at", String(Date.now()));
      return { value: undefined, costUsd };
    }),
  );
}

export function refreshAll(): Promise<void> {
  return track(
    "all",
    async (status) => {
      await db.setSetting("last_full_refresh_date", localDate(new Date()));
      // Claude works out who you are the first time, and looks again each week, so every prompt knows
      // your current role without you writing it.
      const roleAt = Number((await db.getSetting("user_profile_at")) ?? 0);
      if (!(await db.getSetting("user_profile"))?.trim() || Date.now() - roleAt > ROLE_EVERY_MS) {
        status("Getting to know your role");
        await learnRole().catch(() => {});
      }
      // What the latest corrections teach goes into this refresh's prompts.
      await maybeDistill().catch(() => {});
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
