import { runClaude, TOOLS } from "../claude";
import * as db from "../db";
import { adhocPrompt, calendarPrompt, discoveryPrompt, planPrompt, projectPrompt, type PlanPromptInput } from "../prompts";
import { localDate, shouldRunMorning } from "../scheduler";
import { AdhocSnapshot, CalendarDay, Discovery, ProjectSnapshot, TaskPlan } from "../schema";
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
  return queue.run("discover", () =>
    logged("discover", null, async () => {
      const { data, costUsd } = await runClaude({
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
  return queue.run(`project:${channelId}`, () =>
    logged("project", channelId, async () => {
      const project = await db.getProject(channelId);
      if (!project) throw new Error(`Unknown project ${channelId}`);
      try {
        const repoState =
          project.local_repos.length || project.gh_repos.length
            ? await collectRepoState(project.local_repos, project.gh_repos)
            : null;
        if (repoState) await db.saveRepoState(channelId, repoState);

        const startedAt = new Date();
        const { data, costUsd } = await runClaude({
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
  return queue.run("adhoc", () =>
    logged("adhoc", null, async () => {
      const previous = await db.getAdhoc();
      const startedAt = new Date();
      const { data, costUsd } = await runClaude({
        prompt: adhocPrompt({
          userId: uid,
          previous: previous.tasks,
          lastRefreshedAt: previous.refreshed_at,
          now: startedAt,
        }),
        schema: AdhocSnapshot,
        tools: [...TOOLS.slackRead, ...TOOLS.gmailRead],
        model: await model(),
      });
      await db.saveAdhoc({ tasks: data.tasks, refreshed_at: startedAt.toISOString() });
      return { value: undefined, costUsd };
    }),
  );
}

export function refreshCalendar(): Promise<void> {
  return queue.run("calendar", () =>
    logged("calendar", null, async () => {
      const projects = await db.listProjects();
      const { data, costUsd } = await runClaude({
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

export type PlanTask = Omit<PlanPromptInput, "userId"> & { id: string };

/** Asks Claude to research a task and propose a plan; the latest plan per task is kept. */
export function planTask(task: PlanTask): Promise<void> {
  return queue.run(`plan:${task.id}`, () =>
    logged("plan", task.id, async () => {
      const { data, costUsd } = await runClaude({
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
  return queue.run(
    "all",
    async () => {
      await db.setSetting("last_full_refresh_date", localDate(new Date()));
      try {
        await discoverProjects();
      } catch {
        // Still refresh the projects we already know about.
      }
      const projects = (await db.listProjects()).filter((p) => !p.hidden);
      await Promise.allSettled([refreshCalendar(), refreshAdhoc(), ...projects.map((p) => refreshProject(p.channel_id))]);
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
