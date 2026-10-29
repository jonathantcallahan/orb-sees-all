import type { AdhocStore, ManualTask, Project } from "./db";
import type { CalendarDay, ManualAssessment } from "./schema";
import { projectName } from "./projects";
import { stateOf, type TaskState } from "./tasks";

export interface ReadingInput {
  projects: Project[];
  adhoc: AdhocStore;
  manual: ManualTask[];
  assessments: Map<string, ManualAssessment>;
  states: Map<string, TaskState>;
  calendar: CalendarDay | null;
  today: string;
}

/**
 * A compact snapshot of the user's day for the daily reading: only what Claude
 * needs to propose a focus, so the call is small and needs no tools.
 */
export function readingContext(r: ReadingInput) {
  const open = (id: string) => {
    const st = stateOf(r.states, id);
    return !st.done && !st.dismissed;
  };
  const planned = (id: string) => stateOf(r.states, id).todayOn === r.today;

  const projects = r.projects
    .filter((p) => !p.hidden && p.snapshot)
    .map((p) => {
      const s = p.snapshot!;
      return {
        name: projectName(p),
        status: s.status,
        status_reason: s.status_reason,
        priority: s.priority?.level,
        my_role: s.raci?.role,
        blocked_on_me: (s.blockers ?? []).filter((b) => b.owners.some((o) => o.is_me)).map((b) => b.what),
        blocked_on_others: (s.blockers ?? []).filter((b) => !b.owners.some((o) => o.is_me)).map((b) => `${b.what} (${b.owners.map((o) => o.name).join(", ")})`),
        recent_updates: (s.recent_updates ?? []).map((u) => u.summary),
      };
    });

  const tasks = [
    ...r.projects.flatMap((p) =>
      (p.snapshot?.my_tasks ?? []).map((t) => ({ id: t.id, title: t.title, project: projectName(p), a: t.assessment, due: t.due })),
    ),
    ...r.adhoc.tasks.map((t) => ({ id: t.id, title: t.title, project: null, a: t.assessment, due: t.due })),
    ...r.manual.map((t) => ({ id: t.id, title: t.title, project: null, a: r.assessments.get(t.id), due: null })),
  ]
    .filter((t) => open(t.id))
    .map((t) => ({
      title: t.title,
      project: t.project,
      priority: t.a?.priority ?? null,
      estimate_minutes: t.a?.estimate_minutes ?? null,
      due: t.due ?? null,
      planned_today: planned(t.id),
    }));

  return {
    today: r.today,
    projects,
    tasks,
    meetings: (r.calendar?.events ?? []).map((e) => ({ title: e.title, start: e.start, end: e.end, prep: e.prep.map((p) => p.title) })),
    replies_waiting: r.adhoc.replies.filter((x) => open(x.id)).map((x) => `${x.from}: ${x.summary}`),
    news: r.adhoc.news.map((n) => n.headline),
  };
}
