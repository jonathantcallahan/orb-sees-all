import { invoke } from "@tauri-apps/api/core";
import { activeChannels, mergeProfile, newRelatedChannels, planDiscovery, projectContext, projectName, projectStatus, slackThread } from "../projects";
import { acceptedRefinements, buildIndex, type IndexEntry } from "../taskIndex";
import { runClaude, runSessionTurn, TOOLS } from "../claude";
import * as db from "../db";
import { createDocPrompt, createEventPrompt, createTicketPrompt, distillPrompt, epicCheckPrompt, epicChildrenPrompt, learnRolePrompt, recheckStepsPrompt, sendToChannelPrompt, setUserProfile } from "../prompts";
import { GLOBAL_ACTION_DOCS, GLOBAL_TASK_RULES, globalChatPrompt } from "../openInClaude";
import { codeRequests, currentSessionSteps, linkSession, ORB_NOTE, sendDestination, type PendingSend, type PlanStep, type SessionLink, type SessionProgress, type StepProgress } from "../sessions";
import { adhocPrompt, assessPrompt, calendarPrompt, checkBlockerPrompt, checkTaskPrompt, sendReplyPrompt, type CheckTaskInput, readingPrompt, sameWorkPrompt, shortenTitlesPrompt, selfDmActionsPrompt, selfDmPrompt, selfDmReplyPrompt, watchedEntryPrompt, watchedTopicPrompt, sendReminderPrompt, discoveryPrompt, planPrompt, projectPrompt, type PlanPromptInput } from "../prompts";
import { localDate, shouldRunMorning } from "../scheduler";
import { actionsFromPlan, openOutcomes, stillWatched, WATCH_CHAT } from "../watched";
import { parseSelfDmState, SELF_DM_TRIES, selfDmEvery, selfDmOldest, selfDmReplies, takeFromPoll, type SelfDmOutcome } from "../selfDm";
import { AdhocSnapshot, Distilled, EpicChildren, BlockerCheck, CalendarDay, TaskCheck, DailyReading, Discovery, ManualAssessmentBatch, ProjectEpic, ProjectRefresh, LearnedRole, GlobalAction, SameWork, SelfDmActions, SelfDmPoll, SelfDmReplied, SentMessage, ShortTitles, WatchedCheck, WatchedEntry, StepRecheck, TaskPlan, type Blocker } from "../schema";
import { blockerKey, longTitled, stateOf } from "../tasks";
import { readingContext } from "../reading";
import { asUserHasIt, keepDismissed, learningFor, lessonsFor, planLearning } from "../feedback";
import { codeFor, codeNote, githubReposOf, projectOfTask, resolveCheckout, type CodeSource } from "../code";
import { acceptedMerges } from "../duplicates";
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

/** Reads what the user wrote about a topic to watch into its fields. No tools: it only reads their words. */
export async function parseWatchedEntry(text: string): Promise<WatchedEntry> {
  const projects = (await db.listProjects()).filter((p) => !p.hidden).map((p) => ({ id: p.channel_id, name: projectName(p) }));
  const { data } = await runClaude({ prompt: watchedEntryPrompt(text, new Date(), projects), schema: WatchedEntry, tools: [], model: "sonnet", maxTurns: 2 });
  // Only a project they have: an id Claude made up is dropped.
  return { ...data, project_id: projects.some((p) => p.id === data.project_id) ? data.project_id : null };
}

/**
 * Watches a topic from what the user wrote: it's added at once (titled with their words), then
 * Demian fills in its fields from them and checks it. If filling in fails, it stays as written.
 * Filling in is one quick call with no tools, so it takes no slot in the queue: a refresh under way
 * doesn't keep the card on "Generating title…".
 */
export async function watchFromText(text: string): Promise<string> {
  const id = await db.addWatchedTopic(text, null, []);
  bump();
  track(
    `watchfill:${id}`,
    async (status) => {
      status("Filling in your watched topic");
      try {
        const f = await parseWatchedEntry(text);
        await db.updateWatchedTopic(id, {
          topic: f.topic.trim() || text,
          details: f.details?.trim() || null,
          projectId: f.project_id ?? null,
          outcomes: f.outcomes.map((o) => ({ id: crypto.randomUUID(), when: o.when, event: o.event, by: o.when === "not_by" ? (o.by ?? null) : null, then: o.then })),
        });
      } catch {
        // Left as they wrote it; they can fill it in with Edit.
      } finally {
        bump();
      }
    },
    false,
  )
    .then(() => checkWatchedTopic(id))
    .catch(() => {});
  return id;
}

/**
 * Takes the conditional actions a topic's Discuss chat wrote (its "[orb] plan" lines) as the topic's
 * own, once per new list, read against the topic as it is now. Lines it can't read change nothing.
 * Returns whether anything changed.
 */
export async function applyDiscussedActions(id: string, lines: string[]): Promise<boolean> {
  const topic = await db.getWatchedTopic(id);
  if (!topic) return false;
  const outcomes = actionsFromPlan(topic.outcomes, lines);
  if (!outcomes) return false;
  const key = db.watchedActionsKey(id);
  const sig = lines.join("\n");
  if ((await db.getSetting(key)) === sig) return false;
  await db.updateWatchedTopic(id, { outcomes });
  await db.setSetting(key, sig);
  bump();
  checkWatchedTopic(id).catch(() => {});
  return true;
}

/** Checks one watched topic: its status, and whether each outcome it's still waiting on has happened. */
export function checkWatchedTopic(id: string): Promise<void> {
  return track(`watch:${id}`, (status) =>
    logged("watch", id, async () => {
      const topic = await db.getWatchedTopic(id);
      if (!topic) return { value: undefined };
      const project = topic.projectId ? (await db.listProjects()).find((p) => p.channel_id === topic.projectId) : null;
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: watchedTopicPrompt({
          userId: await db.getSetting("slack_user_id"),
          today: localDate(new Date()),
          topic: topic.topic,
          details: topic.details,
          project: project ? { name: projectName(project), channels: activeChannels(project).map((c) => `#${c.name} (${c.channel_id})`) } : null,
          checkedAt: topic.checkedAt,
          lastSummary: topic.status?.summary ?? null,
          outcomes: openOutcomes(topic).map((o) => ({ id: o.id, event: o.event, by: o.by })),
        }),
        schema: WatchedCheck,
        tools: [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.jiraRead],
        // A focused look at one topic: the cheaper model is plenty.
        model: "sonnet",
        maxTurns: 30,
      });
      await db.saveWatchedCheck(id, { summary: data.summary, links: data.links.slice(0, 3) }, data.outcomes);
      return { value: undefined, costUsd };
    }),
  );
}

/**
 * Checks every topic still watched (not done, not unwatched), so each shows where it stands now;
 * conditional actions are only looked into while still open.
 */
export async function checkWatchedTopics(): Promise<void> {
  const states = await db.getTaskStates();
  const topics = (await db.listWatchedTopics()).filter((t) => stillWatched(stateOf(states, t.id)));
  await Promise.allSettled(topics.map((t) => checkWatchedTopic(t.id)));
}

let selfDmBusy = false;
let selfDmLastRun = 0;

/**
 * Checks the user's own Slack DM for messages tagged #demian and does what each asks: anything the
 * global chat can do (add a task, watch a topic, create or change a project, add context, ...),
 * applied at once through applyAction, since tagging the message is the instruction. Then each
 * message gets a reaction and a reply in its thread with what was done, or a question when Demian
 * couldn't tell. The read only reads, and the reply text is the app's own account of what happened,
 * posted as written. Runs outside the job queue and the status line, since it runs every few
 * minutes: it never holds up a refresh, and the refresh log gets an entry only when it acts on
 * something or starts failing.
 */
export async function pollSelfDm(now = new Date()): Promise<void> {
  if (selfDmBusy) return;
  const every = selfDmEvery(await db.getSetting("self_dm_every"));
  if (every === "off" || now.getTime() - selfDmLastRun < Number(every) * 1000 - 2000) return;
  const uid = await db.getSetting("slack_user_id");
  if (!uid) return;
  selfDmBusy = true;
  selfDmLastRun = now.getTime();
  const state = parseSelfDmState(await db.getSetting("self_dm_state"));
  const oldest = selfDmOldest(state, now);
  try {
    const read = await runClaude({
      prompt: selfDmPrompt(uid, oldest),
      schema: SelfDmPoll,
      tools: TOOLS.selfDmRead,
      // A mechanical read, every few minutes: the cheapest model.
      model: "haiku",
      maxTurns: 8,
    });
    const { messages, state: next } = takeFromPoll(state, read.data, oldest, now, read.costUsd);
    if (messages.length === 0) {
      await db.setSetting("self_dm_state", JSON.stringify(next));
      return;
    }
    // What each message asks for, against what the planner shows now (the global chat's context, with ids).
    let asked: Awaited<ReturnType<typeof runClaude<SelfDmActions>>>;
    try {
      asked = await runClaude({
        prompt: selfDmActionsPrompt(messages, await globalContext(undefined)),
        schema: SelfDmActions,
        tools: TOOLS.slackRead,
        model: "sonnet",
        maxTurns: 20,
      });
    } catch (e) {
      // Tried again next check, from the same place; after a few failures in a row the messages are
      // skipped, so a message Demian can't work out isn't retried forever. (A failed read doesn't count.)
      const error = (e as Error).message;
      const tries = state.tries + 1;
      if (tries < SELF_DM_TRIES) {
        if (error !== state.lastError) await db.logFinish(await db.logStart("selfdm", null), { error });
        await db.setSetting("self_dm_state", JSON.stringify({ ...state, lastError: error, tries }));
        return;
      }
      await db.logFinish(await db.logStart("selfdm", `Skipped ${messages.length} from your DM after ${tries} tries`), { error });
      await db.setSetting("self_dm_state", JSON.stringify({ ...next, lastError: error }));
      return;
    }
    // globalActions imports from this module, so it's loaded when first needed rather than at the top.
    const { actionNames, applyAction, describeAction } = await import("../globalActions");
    const names = actionNames(await db.listProjects());
    const outcomes: SelfDmOutcome[] = [];
    let addedTask = false;
    for (const m of messages) {
      const result = asked.data.results.find((r) => r.ts === m.ts);
      const changes: SelfDmOutcome["changes"] = [];
      for (const raw of result?.actions ?? []) {
        const parsed = GlobalAction.safeParse(raw);
        if (!parsed.success) {
          changes.push({ ok: false, line: "Couldn't read one of the changes, so it wasn't made." });
          continue;
        }
        const a = parsed.data;
        try {
          changes.push({ ok: true, line: await applyAction(a, m.text, describeAction(a, names.project, names.channel, names.item)) });
          if (a.type === "add_task") addedTask = true;
        } catch (e) {
          changes.push({ ok: false, line: `Couldn't ${lowerFirst(describeAction(a, names.project, names.channel, names.item))}: ${(e as Error).message}` });
        }
      }
      outcomes.push({ ts: m.ts, changes, question: result?.question?.trim() || null });
    }
    // Acted on: from here they're never read again, even if the reply below fails.
    await db.setSetting("self_dm_state", JSON.stringify({ ...next, usd: next.usd + asked.costUsd }));
    bump();
    if (addedTask) assessPendingTasks().catch(() => {});
    const done = outcomes.flatMap((o) => o.changes.filter((c) => c.ok).map((c) => c.line));
    const log = await db.logStart("selfdm", `${messages.length} from your DM${done.length ? `: ${done.join(" ").slice(0, 200)}` : ""}`);
    let replyCost = 0;
    try {
      const replies = selfDmReplies(outcomes);
      const replied = await runClaude({ prompt: selfDmReplyPrompt(uid, replies), schema: SelfDmReplied, tools: TOOLS.selfDmReply, model: "haiku", maxTurns: replies.length * 2 + 2 });
      replyCost = replied.costUsd;
    } catch {
      // The changes are made; the messages just aren't answered in Slack.
    }
    await db.logFinish(log, { costUsd: read.costUsd + asked.costUsd + replyCost });
  } catch (e) {
    // Nothing was acted on: the state stays where it was, so the next check reads the same messages again.
    const message = (e as Error).message;
    if (message !== state.lastError) {
      const log = await db.logStart("selfdm", null);
      await db.logFinish(log, { error: message });
    }
    await db.setSetting("self_dm_state", JSON.stringify({ ...state, lastError: message }));
  } finally {
    selfDmBusy = false;
  }
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Once: shortens the titles of the user's own tasks that run long, written before titles had a
 * length rule. The original text stays as the task's brief (see retitleManualTask), and becomes its
 * description when it has none, so nothing the user wrote is lost. Only a title still as it was is
 * changed.
 */
export async function shortenLongTitles(): Promise<void> {
  if (await db.getSetting("titles_shortened")) return;
  const states = await db.getTaskStates();
  const long = longTitled((await db.listManualTasks()).filter((t) => !states.get(t.id)?.done && !states.get(t.id)?.dismissed));
  if (long.length) {
    await logged("titles", `${long.length} tasks`, async () => {
      const { data, costUsd } = await runClaude({
        prompt: shortenTitlesPrompt(long.map((t) => ({ id: t.id, title: t.title }))),
        schema: ShortTitles,
        tools: [],
        model: "sonnet",
        maxTurns: 2,
      });
      for (const { id, title } of data.titles) {
        const t = long.find((x) => x.id === id);
        const short = title.trim();
        if (!t || !short || short.length >= t.title.trim().length) continue;
        await db.retitleManualTask(id, short, t.title);
        await db.describeManualTaskIfEmpty(id, t.title);
      }
      return { value: undefined, costUsd };
    });
  }
  await db.setSetting("titles_shortened", new Date().toISOString());
}

/**
 * Given on every turn of a watched topic's chat, in place of a task's step list: the session-wide
 * instructions are about tasks and their plans, and this chat's "plan" is the topic's conditional
 * actions, in their own form.
 */
const WATCH_CHAT_CONTEXT = [
  "This chat is about a topic I'm watching in my planner, not a task: there are no steps to carry out or report on, so write no `[orb] step` lines.",
  "Its plan is the topic's conditional actions. When we agree to add, change or remove one, write the whole list as an `[orb] plan` block, one numbered line per action in exactly this form, and nothing else in the block:",
  "`If <what happens> | hasn't happened by YYYY-MM-DD | then <what to do>` or `If <what happens> | has happened | then <what to do>`.",
  "No [Me] markers and no task-style steps. My planner takes that list as the topic's actions and hides the block, so say in a sentence what changed.",
].join(" ");

/**
 * Given on every turn of a task's chat: the project it's filed under, the projects it could move
 * to, and how to propose the move (a card the user applies), plus what came of earlier ones.
 */
async function taskProjectNote(own: db.Project | null, link: SessionLink | undefined): Promise<string> {
  const tracked = (await db.listProjects()).filter((p) => p.state === "tracked");
  const applied = Object.values(link?.applied ?? {});
  return [
    own ? `My planner files this task under the project "${projectName(own)}" [id ${own.channel_id}].` : "My planner doesn't file this task under any project.",
    `If I say it belongs to a different project, propose the move as its own block, which my planner shows me as a card to apply:\n[orb] action\n{"type": "set_task_project", "project_id": "<id from the list below>"}\n[orb] end\nThat's the only kind of change to propose here. Use an id from this list, and ask me if more than one could fit:\n${tracked.map((p) => `- ${projectName(p)} [id ${p.channel_id}]`).join("\n")}`,
    applied.length ? `Changes you proposed that I applied: ${applied.map((a) => `${a.summary}. ${a.result}`).join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Given on every turn of a task's chat, so the steps on its card follow the conversation: a session
 * left to judge it on its own often carries on with work the steps don't list.
 */
const PLAN_REMINDER =
  "If what I just said changes the work (it asks for something the steps don't cover, drops or changes a step, or moves one between us), restate the whole plan as an [orb] plan block before you carry on, finished steps included, and number your reports against it.";

/** Tasks per Claude call when assessing the user's own tasks. */
const ASSESS_BATCH = 12;

/**
 * Has Claude assess the user's own open tasks that don't have an assessment
 * yet, drafting a description where they left none. Works in batches and
 * rechecks between them, so tasks added mid-run are picked up.
 */
export function assessPendingTasks(): Promise<void> {
  // Tasks seen for the first time this run: once assessed, checked against the rest for the same work.
  const fresh = new Set<string>();
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
      for (const t of batch) {
        tried.add(t.id);
        if (!assessed.has(t.id)) fresh.add(t.id);
      }
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
    // After the assess job, not inside it, so the merge pass takes its own slot in the queue.
  }).then(() => (fresh.size ? dedupeTasks([...fresh]).catch(() => {}) : undefined));
}

/**
 * Folds open tasks that are the same work (SAME_WORK_RULE) into one card each: all of them after a
 * full refresh (refreshes run side by side, so two can each add the same work), or only those
 * matching `focus`, tasks just added. Each merge is recorded under the kept task so its card can
 * show it and Separate can undo it; a pair the user separated is never merged again.
 */
export function dedupeTasks(focus?: string[]): Promise<void> {
  return track(focus ? `dedupe:${focus.join(",")}` : "dedupe", (status) =>
    logged("dedupe", focus ? `${focus.length} new` : "all open", async () => {
      const index = await loadTaskIndex();
      const open = new Set(index.map((e) => e.id));
      const [aliases, manual, links, notDuplicates] = await Promise.all([db.getTaskAliases(), db.listManualTasks(), db.getSessionLinks(), db.getNotDuplicates()]);
      const focusOpen = focus?.map((id) => aliases.get(id) ?? id).filter((id) => open.has(id));
      if (index.length < 2 || (focus && !focusOpen?.length)) return { value: undefined };
      const { data, costUsd } = await runClaude({
        onStatus: status,
        prompt: sameWorkPrompt(index, focusOpen),
        schema: SameWork,
        tools: [],
        // Judging meaning across many short entries: worth more than the cheapest model, no tools needed.
        model: "sonnet",
        maxTurns: 2,
      });
      const merges = acceptedMerges(data.groups, {
        open,
        mine: new Set(manual.map((t) => t.id)),
        notDuplicates,
        sessions: new Set(Object.entries(links).filter(([, l]) => !!l.sessionId).map(([id]) => id)),
        aliases,
        focus: focusOpen ? new Set(focusOpen) : undefined,
      });
      const titleOf = new Map(index.map((e) => [e.id, e.title]));
      for (const m of merges) await db.mergeTasks(m.keep, m.drop, titleOf.get(m.drop) ?? m.drop);
      if (merges.length) bump();
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
/** A message that asks for a Jira ticket. */
const TICKET_ASK = /\b(jira|tickets?)\b/i;
/** Said with such a message, every time: a session that once decided it can't file tickets keeps saying so otherwise. */
const TICKET_REMINDER =
  ORB_NOTE + " you can file Jira tickets here, through me. Write the ticket as a block, a line `[orb] ticket: <summary>` (or `[orb] ticket step N: <summary>` for a plan step), then `project:`, `type:` and, when they apply, `epic:`, `component:`, `priority:`, `labels:` and `links:` lines, a blank line, the description, and `[orb] end`. I show it to the user to review and file it in Jira as them, then send you its link. Don't call any Jira tool that creates or changes issues, and don't say you can't file tickets or that it's the user's step; if you said so earlier, that was wrong.)";

const DOC_REMINDER =
  ORB_NOTE + " you can make Google Docs here, through me. Write the doc as a block, a line `[orb] doc: <title>` (or `[orb] doc step N: <title>` for a plan step), then its content in Markdown, then `[orb] end`. I show it to the user to review and create it in their Drive, then send you its link. Don't call any Drive or Docs tool, and don't say you can't make docs or that it needs a permission; if you said so earlier, that was wrong.)";

// A task's chat also gets Amplitude's experiment and flag tools, which can change them too: the user
// is in the conversation, and SESSION_DISPLAY says to change one only when they ask.
const SESSION_TOOLS = [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.calendarRead, ...TOOLS.driveRead, ...TOOLS.jiraRead, ...TOOLS.zoomRead, ...TOOLS.amplitudeRead, ...TOOLS.amplitudeExperiments];

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
        const global = taskId.startsWith("global:");
        const watched = taskId.startsWith(WATCH_CHAT) ? await db.getWatchedTopic(taskId.slice(WATCH_CHAT.length)) : null;
        /** A task's own chat, with a plan to keep current (not the Demian chat, a watched topic, or a chat about something else). */
        const taskChat = !global && !watched && !link?.topic;
        // Once the plan has moved on from the opening prompt's (the session restated it, or Orb
        // re-checked it), the session sees the list the card shows, with where each step stands, so
        // its step numbers match it.
        const shown = taskChat && link ? await currentSessionSteps(link).catch(() => null) : null;
        const steps = shown?.plan
          .map((st, i) => {
            const s = shown.steps[i + 1];
            return `${i + 1}. ${st.by === "you" ? "[Me] " : ""}${st.title} (${s ? s.state : "not started"})`;
          })
          .join("\n");
        // Sessions carry out plans and write messages for the user, so they get those lessons too.
        const lessons = await lessonsFor(["plans", "writing"]);
        // The code they can read: the task's project's, or for the Demian chat every project's that's
        // already on hand (it spans them all, so it doesn't clone).
        // A task filed under no project gets the same as the Demian chat, so a question only the code
        // answers never finds it missing.
        const own = global
          ? null
          : watched
            ? ((await db.listProjects()).find((p) => p.channel_id === watched.projectId) ?? null)
            : await projectOfTask(taskId);
        const everyProject = !own;
        const codeProjects = everyProject ? (await db.listProjects()).filter((p) => p.state === "tracked") : [own];
        const projectCode = codeProjects.length ? await codeFor(codeProjects, !everyProject, everyProject ? 12 : 4) : [];
        // Plus code the session asked for along the way ("[orb] code …"), while it's still on disk.
        const onDisk = link?.code?.length ? await invoke<string[]>("existing_dirs", { paths: link.code.map((c) => c.dir) }).catch(() => []) : [];
        const code = [...projectCode, ...(link?.code ?? []).filter((c) => onDisk.includes(c.dir) && !projectCode.some((p) => p.dir === c.dir))];
        const context = [
          taskId.startsWith("global:")
            ? await globalContext(link)
            : watched
              ? WATCH_CHAT_CONTEXT
              : [
                  taskChat ? await taskProjectNote(own, link) : "",
                  steps
                    ? shown?.rechecked
                      ? `I re-checked your steps against our conversation, so my planner's list, and its step numbers, may differ from the ones you've been using. From now on, number every [orb] report against this list, not your earlier one:\n${steps}`
                      : `My planner now shows these steps; number your [orb] reports against this list:\n${steps}`
                    : "",
                  taskChat ? PLAN_REMINDER : "",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
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
        const asked = [prompt, DOC_ASK.test(prompt) ? DOC_REMINDER : "", EVENT_ASK.test(prompt) ? EVENT_REMINDER : "", TICKET_ASK.test(prompt) ? TICKET_REMINDER : "", PREFERENCE_ASK.test(prompt) ? PREFERENCE_REMINDER : ""].filter(Boolean).join("\n\n");
        const turn = await runSessionTurn({ prompt: asked, tools: SESSION_TOOLS, ...SESSION_MODEL, resume: link?.sessionId, onStatus: status, context, onText, dirs: code.map((c) => c.dir) }).finally(() => {
          // The whole reply goes out before it's cleared, so the chat holds all of it until the
          // transcript's copy arrives.
          window.clearTimeout(flush);
          if (latest) setStatus(liveKey, latest);
          window.setTimeout(() => setStatus(liveKey, null), 60);
        });
        if (turn.sessionId) await db.updateSessionLink(taskId, { sessionId: turn.sessionId });
        if (turn.error) throw new Error(turn.error);
        // Code it asked to read: added for its next turns, and it's told so it carries on. That turn
        // waits for this one to finish (see continueTaskSession), so it isn't awaited here.
        const note = await addRequestedCode(taskId).catch(() => null);
        if (note) void continueTaskSession(taskId, note).catch(() => {});
        return { value: undefined, costUsd: turn.costUsd };
      } catch (e) {
        await db.updateSessionLink(taskId, { lastError: (e as Error).message });
        throw e;
      }
    }),
  );
}

/**
 * The code a session asked for ("[orb] code …"), or tried to read and was refused (its file tools
 * only reach its own folders), that it hasn't been answered about: each found checkout is added to
 * its code folders (see resolveCheckout), and the note to tell it comes back, or null when there's
 * nothing new. A refused read counts as asking for the git checkout it's in, outside the folders
 * macOS guards (see checkout_root): sessions don't reliably ask.
 */
async function addRequestedCode(taskId: string): Promise<string | null> {
  const link = (await db.getSessionLinks())[taskId];
  if (!link?.path) return null;
  const { lines, blocked = [] } = await invoke<{ lines: string[]; blocked?: string[] }>("read_session_progress", { path: link.path });
  const refused = await Promise.all(blocked.map((path) => invoke<string | null>("checkout_root", { path }).catch(() => null)));
  const fresh = [...new Set([...codeRequests(lines), ...refused.filter((r): r is string => !!r)])].filter((ask) => !link.codeAsked?.includes(ask));
  if (!fresh.length) return null;
  const found: CodeSource[] = [];
  const missing: string[] = [];
  for (const ask of fresh) {
    const source = await resolveCheckout(ask);
    if (source) found.push(source);
    else missing.push(ask);
  }
  const code = [...(link.code ?? []), ...found.filter((f) => !link.code?.some((c) => c.dir === f.dir))];
  await db.updateSessionLink(taskId, { code, codeAsked: [...(link.codeAsked ?? []), ...fresh] });
  return [
    ORB_NOTE,
    found.length ? `you can read ${found.map((f) => `${f.label} (${f.dir})`).join(", ")} now, read-only, with Read, Grep and Glob; reads there that were refused will work if you try them again.` : "",
    missing.length
      ? `I couldn't find ${missing.map((m) => `"${m}"`).join(", ")} as a code checkout on this computer or a GitHub repo I can copy. Ask me for it by its GitHub owner/name if you know it, or tell the user which repo you need so they can add it to a project in Settings.`
      : "",
    "Carry on where you left off.)",
  ]
    .filter(Boolean)
    .join(" ");
}

/** How many of a project's open blockers and active items the global chat's context lists. */
const CONTEXT_ITEMS = 3;
/** The same for a blocked or at-risk project. */
const CONTEXT_ITEMS_URGENT = 8;

/** What the planner shows right now, for the global chat's next turn, so it works from current ids. */
async function globalContext(link: SessionLink | undefined): Promise<string> {
  const [projects, reading, adhoc, manual, states, profile, notes, aliases, moved, sessions] = await Promise.all([
    db.listProjects(),
    db.getReading(),
    db.getAdhoc(),
    db.listManualTasks(),
    db.getTaskStates(),
    db.getSetting("user_profile"),
    db.getNotes(),
    db.getTaskAliases(),
    db.getProjectOverrides(),
    db.getSessionLinks(),
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
  // Each task as its card shows it: one merged into another isn't listed on its own (its card is the
  // other's), and one you moved shows under the project you moved it to.
  const nameOf = (id: string | null | undefined) => {
    const p = id ? projects.find((x) => x.channel_id === id) : undefined;
    return p ? projectName(p) : null;
  };
  const filedIn = (id: string, found: string | null) => nameOf(moved[id]) ?? found;
  const tasks = [
    ...projects
      .filter((p) => p.state === "tracked")
      .flatMap((p) => (p.snapshot?.my_tasks ?? []).map((t) => ({ id: t.id, title: t.title, where: filedIn(t.id, projectName(p)) ?? projectName(p), gist: t.description }))),
    ...adhoc.tasks.map((t) => ({ id: t.id, title: t.title, where: filedIn(t.id, null) ?? t.source, gist: t.description })),
    ...manual.map((t) => ({ id: t.id, title: t.title, where: nameOf(t.project_id) ? `added by me, in ${nameOf(t.project_id)}` : "added by me", gist: t.description })),
    ...(calendar?.day.events ?? []).flatMap((ev) => ev.prep.map((p) => ({ id: p.id, title: p.title, where: `prep for ${ev.title}`, gist: null }))),
  ].filter((t) => !aliases.has(t.id) && open(t.id));
  // What a task's own chat agreed its steps are (they can say more about it than its title).
  const chatSteps = (id: string) => {
    const s = sessions[id];
    const steps = s?.recheck?.plan.map((st) => st.title) ?? s?.loggedPlan?.map((st) => st.replace(/^\[Me\]\s*/, ""));
    return steps?.length ? ` Steps agreed in its chat: ${steps.join("; ").replace(/\s+/g, " ").slice(0, 400)}` : "";
  };
  const today = localDate(new Date());
  // Past the cap, the ones least likely to come up go: Today's tasks first, then my own (newest
  // first, so one just added is always there), then the rest.
  const added = new Map(manual.map((t) => [t.id, t.created_at ?? ""]));
  const rank = (t: (typeof tasks)[number]) => (states.get(t.id)?.todayOn === today ? 0 : added.has(t.id) ? 1 : 2);
  const byRelevance = (list: typeof tasks) => [...list].sort((a, b) => rank(a) - rank(b) || (added.get(b.id) ?? "").localeCompare(added.get(a.id) ?? ""));
  const taskLine = (t: (typeof tasks)[number]) => {
    const st = states.get(t.id);
    const gist = t.gist ? ` — ${t.gist.replace(/\s+/g, " ").slice(0, 120)}` : "";
    return `- [id ${t.id}] ${t.title} (${t.where}${st?.todayOn === today ? ", in Today's tasks" : ""}${st?.status && st.status !== "todo" ? `, ${st.status.replace("_", " ")}` : ""})${gist}${chatSteps(t.id)}`;
  };
  return [
    // The current changes and rules, every turn: a chat open since before one was added still knows it.
    `The changes you can propose, as [orb] action blocks (the current list, which replaces any earlier one):\n${GLOBAL_ACTION_DOCS}\n\n${GLOBAL_TASK_RULES}`,
    "What my planner shows right now:",
    `About me: ${profile?.trim() || "(not set)"}`,
    notes.length ? `Corrections I've already given:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
    `Projects (tracked ones are on the board; suggested and ignored ones aren't):\n${projectLines.join("\n") || "(none)"}`,
    reading ? `Today's briefing: ${reading.text}` : "",
    `My open tasks (use these ids in task changes):\n${byRelevance(tasks).slice(0, 120).map(taskLine).join("\n") || "(none)"}`,
    link?.applied && Object.keys(link.applied).length
      ? `Changes you proposed that I've applied (the rest I haven't, or turned down):\n${Object.values(link.applied).map((a) => `- ${a.summary}. ${a.result}`).join("\n")}`
      : "",
    link?.dismissedKeys?.length ? `I turned down ${link.dismissedKeys.length} of your proposed changes.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Re-checks a task chat's steps against its conversation when they may have drifted (a report went
 * missing, a step was reported that the card doesn't have, or you said something the session didn't
 * restate the plan for), and keeps the result: the card shows it, with the
 * session's later reports on top, and the session is shown the same list on its next turn so its
 * step numbers line up.
 */
export function recheckSessionSteps(
  taskId: string,
  task: string,
  steps: { title: string; by: "claude" | "you" | null; progress?: StepProgress }[],
  progress: SessionProgress,
  /** The list the session's own step numbers follow: the plan it last wrote, else the one it started with. */
  sessionSteps: { title: string; by: "claude" | "you" | null }[] = steps,
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
      if (plan.length) await db.updateSessionLink(taskId, { recheck: { plan, states, reports: progress.reports ?? 0, userMessages: progress.userMessages ?? 0 } });
      // The card's list isn't the one the session numbers by (steps added, dropped, reworded or
      // reordered since it last wrote its plan): the session restates it, so its step numbers match
      // the card's from here on. Otherwise it goes on reporting, and handing over, against its own
      // list, and a report or a sent message lands on the wrong step. Once per list, so a session
      // that doesn't restate isn't asked again and again.
      const line = (st: { title: string; by: string | null }) => `${st.by === "you" ? "[Me] " : ""}${st.title}`;
      const shown = plan.map(line).join("\n");
      const link = (await db.getSessionLinks())[taskId];
      if (plan.length && shown !== sessionSteps.map(line).join("\n") && shown !== link?.alignAsked) {
        await db.updateSessionLink(taskId, { alignAsked: shown });
        const list = plan.map((st, i) => `${i + 1}. ${line(st)} (${states[i + 1]?.state ?? "not started"})`).join("\n");
        void continueTaskSession(
          taskId,
          `${ORB_NOTE} I re-checked your steps against our conversation, and my planner now shows this list:\n${list}\nRestate it as your plan, an [orb] plan block with these steps in this order, and from now on number every report and hand-off against it. Hand over again, with its new step number, anything still waiting for the user to send or create. Then carry on where you left off without redoing finished work; if we're still talking the plan through, keep talking it through.)`,
        ).catch(() => {});
      }
      return { value: undefined, costUsd };
    }),
  );
}

/**
 * Opens a task's chat (Open in chat): the session talks the plan through, then carries it out once
 * you tell it to go ahead there. Resolves once the task is linked, while Claude's opening turn runs
 * on; `onTurn` hears when that turn ends.
 */
export async function startTaskChat(taskId: string, prompt: string, onTurn: () => void): Promise<void> {
  await linkSession(taskId);
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
  await db.updateSessionLink(key, { topic: true });
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
      const ticket = send.kind === "ticket";
      const thread = doc || event || ticket ? null : slackThread(send.to);
      const { data, costUsd } = await runClaude({
        onStatus: (s) => status(s === "Working" ? (doc ? "Creating the doc" : event ? "Creating the event" : ticket ? "Filing the ticket" : "Posting to Slack") : s),
        prompt: doc
          ? createDocPrompt(send.to, text)
          : event
            ? createEventPrompt(send.to, text)
            : ticket
              ? createTicketPrompt(send.to, text)
              : thread
                ? sendReplyPrompt(thread.channelId, thread.threadTs, text)
                : sendToChannelPrompt(send.to, text),
        schema: SentMessage,
        // A channel by name needs looking up first.
        tools: doc ? TOOLS.docCreate : event ? TOOLS.eventCreate : ticket ? TOOLS.ticketCreate : thread ? TOOLS.slackSend : [...TOOLS.slackSend, ...TOOLS.slackRead],
        model: "sonnet",
        maxTurns: ticket ? 10 : 6,
      });
      if (!data.sent)
        throw new Error(
          data.error ?? (doc ? "Google Drive didn't create the doc" : event ? "Google Calendar didn't create the event" : ticket ? "Jira didn't create the ticket" : "Slack didn't accept the message"),
        );
      const link = (await db.getSessionLinks())[taskId];
      // Its link, kept with the step it finished, for a chip beside that step.
      // The step it finished, by title too: the chip stays beside that step if the steps are renumbered later.
      const stepTitle = send.step && link ? (await currentSessionSteps(link).catch(() => null))?.plan[send.step - 1]?.title : undefined;
      const artifact = data.link
        ? [{ ...(send.step ? { step: send.step } : {}), ...(stepTitle ? { stepTitle } : {}), url: data.link, title: doc || event || ticket ? send.to : `Message in ${sendDestination(send)}` }]
        : [];
      await db.updateSessionLink(taskId, {
        sentKeys: [...(link?.sentKeys ?? []), send.key],
        artifacts: [...(link?.artifacts ?? []), ...artifact],
        ...(send.step ? { doneSteps: [...(link?.doneSteps ?? []), send.step] } : {}),
      });
      const edited = text !== send.text ? ` I edited it first; this is what ${doc || event || ticket ? "it says" : "went out"}:\n\n${text}` : "";
      // How the user rewrote Claude's draft says something about how they write.
      if (text !== send.text)
        db.logFeedback({ kind: "message_edit", subject: "message", subject_id: taskId, before: { to: send.to, text: send.text }, after: { text } }).catch(() => {});
      continueTaskSession(
        taskId,
        `${doc ? `I created the Google Doc "${send.to}"` : ticket ? `I filed the Jira ticket "${send.to}"${data.error ? ` (${data.error})` : ""}` : event ? `I created the event "${send.to}" and sent its invites${data.moved ? `, moved to ${data.moved} since the reviewed time was no longer free for everyone` : ""}` : `I sent the message to ${sendDestination(send)}${send.to.startsWith("http") ? ` (${send.to})` : ""}`}${data.link ? ` (${data.link})` : ""}.${edited}\n\nCarry on with the next step.`,
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
        checkWatchedTopics(),
        ...projects.map((p) => refreshProject(p.channel_id)),
      ]);
      // Refreshes ran side by side, so two may have added the same work; and this catches any already there.
      status("Merging duplicate tasks");
      await dedupeTasks().catch(() => {});
      // The reading summarizes everything above, so it goes last.
      status("Writing the daily briefing");
      await refreshReading().catch(() => {});
      // Once, for tasks written before titles had a length rule.
      await shortenLongTitles().catch(() => {});
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
