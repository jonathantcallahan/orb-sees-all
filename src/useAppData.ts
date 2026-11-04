import type { Priority } from "./schema";
import type { SessionLink } from "./sessions";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as db from "./db";
import { dataVersion, jobStatus, queue } from "./jobs";
import { enqueueStep, isChatJob, stepMs, type FeedItem } from "./statusFeed";
import { localDate } from "./scheduler";
import type { CalendarDay, ManualAssessment } from "./schema";
import type { TaskState } from "./tasks";

export interface AppData {
  projects: db.Project[];
  adhoc: db.AdhocStore;
  manual: db.ManualTask[];
  calendar: { day: CalendarDay; refreshed_at: string } | null;
  taskStates: Map<string, TaskState>;
  plans: Map<string, db.StoredPlan>;
  assessments: Map<string, ManualAssessment>;
  reading: db.StoredReading | null;
  reminders: Record<string, db.Reminder>;
  blockerChecks: Record<string, db.StoredBlockerCheck>;
  descriptionOverrides: Record<string, string>;
  taskChecks: Record<string, db.StoredTaskCheck>;
  sessionLinks: Record<string, SessionLink>;
  priorityOverrides: Record<string, Priority>;
  /** Other ids for the same tasks, mapped to their canonical ids. */
  taskAliases: Map<string, string>;
  /** Descriptions refreshes updated with new information, by canonical task id. */
  refinedDescriptions: Record<string, string>;
  /** The user's own notes on tasks they added, as typed, when a short title replaced them. */
  taskBriefs: Record<string, string>;
  /** Pairs of tasks you said aren't duplicates. */
  notDuplicates: Set<string>;
  lastFullRefresh: string | null;
}

async function loadAll(): Promise<AppData> {
  const [projects, adhoc, manual, calendar, taskStates, plans, assessments, reading, reminders, blockerChecks, descriptionOverrides, taskChecks, sessionLinks, priorityOverrides, taskAliases, refinedDescriptions, notDuplicates, lastFullRefresh, taskBriefs] = await Promise.all([
    db.listProjects(),
    db.getAdhoc(),
    db.listManualTasks(),
    db.getCalendarDay(localDate(new Date())),
    db.getTaskStates(),
    db.getTaskPlans(),
    db.getAssessments(),
    db.getReading(),
    db.getReminders(),
    db.getBlockerChecks(),
    db.getDescriptionOverrides(),
    db.getTaskChecks(),
    db.getSessionLinks(),
    db.getPriorityOverrides(),
    db.getTaskAliases(),
    db.getRefinedDescriptions(),
    db.getNotDuplicates(),
    db.getSetting("last_full_refresh_date"),
    db.getTaskBriefs(),
  ]);
  return { projects, adhoc, manual, calendar, taskStates, plans, assessments, reading, reminders, blockerChecks, descriptionOverrides, taskChecks, sessionLinks, priorityOverrides, taskAliases, refinedDescriptions, notDuplicates, lastFullRefresh, taskBriefs };
}

/** Everything the dashboard shows, reloaded whenever a job finishes or `reload` is called. */
export function useAppData() {
  const version = useSyncExternalStore(dataVersion.subscribe, dataVersion.get);
  const [data, setData] = useState<AppData | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    loadAll().then((d) => !cancelled && setData(d));
    return () => {
      cancelled = true;
    };
  }, [version, tick]);

  return { data, reload };
}

/** Keys of queued and running jobs, e.g. "project:C123", "adhoc", "all". */
export function useRunningJobs(): string[] {
  return useSyncExternalStore(queue.subscribe, queue.keys);
}

/** What a running job is doing right now, e.g. "Reading a Slack thread"; undefined when idle. */
export function useJobStatus(...keys: string[]): string | undefined {
  // The snapshot is the string itself, so a component re-renders only when its own job's line
  // changes, not on every other job's.
  const joined = keys.join("\n");
  const get = useCallback(() => {
    const statuses = jobStatus.get();
    for (const key of joined.split("\n")) {
      const s = statuses.get(key);
      if (s) return s;
    }
    return undefined;
  }, [joined]);
  return useSyncExternalStore(jobStatus.subscribe, get);
}

/** How often the line checks whether it's time for the next action. */
const FEED_TICK_MS = 60;

/**
 * The bottom bar's line on what's loading: every action any job starts, in order (see
 * statusFeed.ts), each up for stepMs. Undefined once nothing is left to say. A steady ticker moves
 * it on: with many jobs, actions arrive faster than any one-shot timer could survive.
 */
export function useStatusFeed(): string | undefined {
  const statuses = useSyncExternalStore(jobStatus.subscribe, jobStatus.get);
  const seen = useRef(new Map<string, string>());
  const queue = useRef<FeedItem[]>([]);
  const running = useRef(statuses);
  const shownRef = useRef<FeedItem | null>(null);
  const shownAt = useRef(0);
  const [shown, setShown] = useState<FeedItem | null>(null);

  // The ticker runs only while there's something queued or shown; idle, nothing wakes.
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
  };
  const start = () => {
    if (ticker.current) return;
    const show = (item: FeedItem | null) => {
      shownRef.current = item;
      shownAt.current = Date.now();
      setShown(item);
    };
    ticker.current = setInterval(() => {
      if (Date.now() - shownAt.current < stepMs(queue.current.length)) return;
      const [next, ...rest] = queue.current;
      if (next) {
        queue.current = rest;
        show(next);
      } else if (!shownRef.current) stop();
      else if (!running.current.has(shownRef.current.key)) show(null);
    }, FEED_TICK_MS);
  };
  useEffect(() => stop, []);

  // Each new action any job starts joins the queue.
  useEffect(() => {
    running.current = statuses;
    let next = queue.current;
    for (const [key, text] of statuses) if (!isChatJob(key) && seen.current.get(key) !== text) next = enqueueStep(next, { key, text });
    queue.current = next;
    seen.current = new Map(statuses);
    if (next.length || shownRef.current) start();
  }, [statuses]);

  return shown?.text;
}

