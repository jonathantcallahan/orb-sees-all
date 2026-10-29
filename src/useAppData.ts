import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import * as db from "./db";
import { dataVersion, queue } from "./jobs";
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
  drafts: Map<string, { text: string; created_at: string }>;
  lastFullRefresh: string | null;
}

async function loadAll(): Promise<AppData> {
  const [projects, adhoc, manual, calendar, taskStates, plans, assessments, reading, drafts, lastFullRefresh] = await Promise.all([
    db.listProjects(),
    db.getAdhoc(),
    db.listManualTasks(),
    db.getCalendarDay(localDate(new Date())),
    db.getTaskStates(),
    db.getTaskPlans(),
    db.getAssessments(),
    db.getReading(),
    db.getReplyDrafts(),
    db.getSetting("last_full_refresh_date"),
  ]);
  return { projects, adhoc, manual, calendar, taskStates, plans, assessments, reading, drafts, lastFullRefresh };
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
