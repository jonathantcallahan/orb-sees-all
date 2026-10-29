import { useState, type ReactNode } from "react";
import { addManualTask, type AdhocStore, type ManualTask, type Project, type StoredPlan } from "../db";
import { assessPendingTasks, refreshAdhoc } from "../jobs";
import type { ManualAssessment } from "../schema";
import { applyTaskState, formatMinutes, isFiltering, matchesFilter, myBlockingIds, splitToday, taskPriority, type TaskState } from "../tasks";
import { localDate } from "../scheduler";
import { projectName } from "../projects";
import { RefreshButton, Updated } from "./common";
import { setTaskState } from "../db";
import { Inbox } from "./Inbox";
import { TaskFilters, useTaskFilter } from "./TaskFilters";
import { useJobStatus } from "../useAppData";
import { TaskCard, TASK_DRAG_TYPE, type CardTask } from "./TaskCard";

function Group({
  title,
  tasks: unsorted,
  empty,
  plans,
  assessments,
  running,
  filtered = false,
  controls,
  onChange,
}: {
  title: string;
  /** Shown at the right of the heading, e.g. filters. */
  controls?: ReactNode;
  tasks: CardTask[];
  empty: string;
  /** A filter is on, so say so when nothing is left. */
  filtered?: boolean;
  plans: Map<string, StoredPlan>;
  assessments: Map<string, ManualAssessment>;
  running: string[];
  onChange: () => void;
}) {
  // Recommended tasks first, keeping the group's order otherwise.
  const tasks = [...unsorted].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
  return (
    <>
      <div className="group-header">
        <h4 className="section-title">{title}</h4>
        {controls}
      </div>
      {tasks.length === 0 && <p className="muted small">{filtered ? "Nothing matches the filters." : empty}</p>}
      {tasks.map((t) => (
        <TaskCard
          key={t.id}
          task={t}
          plan={plans.get(t.id)}
          planning={running.includes(`plan:${t.id}`)}
          manualAssessment={assessments.get(t.id)}
          assessing={running.includes("assess")}
          compact
          onChange={onChange}
        />
      ))}
    </>
  );
}

export function TaskColumn({
  adhoc,
  manual,
  projects,
  filterProject,
  onClearFilter,
  taskStates,
  plans,
  assessments,
  drafts,
  recommended,
  running,
  onChange,
}: {
  adhoc: AdhocStore;
  manual: ManualTask[];
  /** Visible projects; their open tasks for the user show here with a project badge. */
  projects: Project[];
  /** When set, only this project's tasks are shown. */
  filterProject: Project | null;
  onClearFilter: () => void;
  taskStates: Map<string, TaskState>;
  plans: Map<string, StoredPlan>;
  assessments: Map<string, ManualAssessment>;
  drafts: Map<string, { text: string }>;
  /** Task ids today's reading recommends. */
  recommended: Set<string>;
  running: string[];
  onChange: () => void;
}) {
  const [draft, setDraft] = useState("");
  const tasksStatus = useJobStatus("adhoc", "assess");
  const [filter, setFilter] = useTaskFilter();
  const filtering = isFiltering(filter);
  /** Effective priority, matching the card's badge: tasks in P0 projects are critical. */
  const priorityOf = (t: CardTask) =>
    taskPriority((t.source === "manual" ? assessments.get(t.id) : t.assessment)?.priority, t.projectPriority, t.blocking);
  const filters = <TaskFilters filter={filter} onChange={setFilter} />;
  const keep = <T extends CardTask>(list: T[]) =>
    filtering ? list.filter((t) => matchesFilter({ status: t.status, priority: priorityOf(t), recommended: t.recommended }, filter)) : list;
  const [dropTarget, setDropTarget] = useState<"today" | "rest" | null>(null);
  const shared = { plans, assessments, running, onChange };
  const today = localDate(new Date());

  // Slack and email items share one inbox; dated items first, soonest first.
  const inbox = splitToday(
    applyTaskState(
      [...adhoc.tasks]
        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
        .map((t) => ({ ...t, recommended: recommended.has(t.id) })),
      taskStates,
    ),
    today,
  );

  // The user's tasks from project snapshots: blockers first, then by due date.
  const fromProjects = (filterProject ? [filterProject] : projects).flatMap((p) => {
    const blocking = new Set(myBlockingIds(p.snapshot?.blockers, taskStates));
    return (p.snapshot?.my_tasks ?? []).map((t) => ({
      ...t,
      source: "project" as const,
      project: { id: p.channel_id, name: projectName(p) },
      blocking: blocking.has(t.id),
      recommended: recommended.has(t.id),
      projectPriority: p.snapshot?.priority?.level,
      repoFolder: p.local_repos[0] ?? null,
    }));
  });
  fromProjects.sort(
    (a, b) => Number(b.blocking) - Number(a.blocking) || (a.due ?? "9999").localeCompare(b.due ?? "9999"),
  );
  const projectTasks = splitToday(applyTaskState(fromProjects, taskStates), today);

  const mine = splitToday(
    applyTaskState(
      manual.filter((t) => !filterProject || t.project_id === filterProject.channel_id),
      taskStates,
    ).map((t) => ({ ...t, source: "manual" as const, recommended: recommended.has(t.id) })),
    today,
  );

  // Today's plan pulls from every group; open tasks first.
  const planned = [...mine.planned, ...projectTasks.planned, ...inbox.planned].sort(
    (a, b) => Number(a.done) - Number(b.done),
  );
  const estimate = (t: (typeof planned)[number]) =>
    (t.source === "manual" ? assessments.get(t.id) : "assessment" in t ? t.assessment : null)?.estimate_minutes ?? 0;
  const remaining = planned.filter((t) => !t.done).reduce((sum, t) => sum + estimate(t), 0);
  const todayGroup = (
    <section className={`today-plan${planned.length ? "" : " empty"}${dropTarget === "today" ? " drop" : ""}`}>
      <h4 className="section-title today-heading">
        Today's tasks
        {planned.length > 0 && (
          <span className="today-total">
            {planned.filter((t) => !t.done).length} open{remaining > 0 && ` · ~${formatMinutes(remaining)}`}
          </span>
        )}
      </h4>
      {planned.length === 0 ? (
        <p className="muted small">Drag tasks here to plan your day.</p>
      ) : (
        planned.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            plan={plans.get(t.id)}
            planning={running.includes(`plan:${t.id}`)}
            manualAssessment={assessments.get(t.id)}
            assessing={running.includes("assess")}
            onChange={onChange}
          />
        ))
      )}
    </section>
  );

  // Dropping a task on Today plans it; dropping it anywhere else in the column unplans it.
  const zoneOf = (e: React.DragEvent) => ((e.target as HTMLElement).closest(".today-plan") ? "today" : "rest");
  const plannedIds = new Set(planned.map((t) => t.id));

  return (
    <section
      className={`column${dropTarget === "rest" ? " drop" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TASK_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropTarget(zoneOf(e));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
      }}
      onDrop={async (e) => {
        const id = e.dataTransfer.getData(TASK_DRAG_TYPE);
        setDropTarget(null);
        if (!id) return;
        e.preventDefault();
        const toToday = zoneOf(e) === "today";
        if (toToday === plannedIds.has(id)) return;
        await setTaskState(id, { todayOn: toToday ? today : null });
        onChange();
      }}
      onDragEnd={() => setDropTarget(null)}
    >
      <Inbox replies={adhoc.replies} states={taskStates} drafts={drafts} running={running} onChange={onChange} />
      <header className="column-header">
        <div className="title-line">
          <h2>Tasks</h2>
          <Updated at={adhoc.refreshed_at} />
        </div>
        <RefreshButton busy={running.includes("adhoc") || running.includes("assess")} status={tasksStatus} title="Refresh tasks" onClick={() => {
            refreshAdhoc().catch(() => {});
            assessPendingTasks().catch(() => {});
          }} />
      </header>

      <form
        className="add-task"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          await addManualTask(draft.trim());
          setDraft("");
          onChange();
          assessPendingTasks().catch(() => {});
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a task…" />
      </form>

      {filterProject ? (
        <>
          <div className="filter-chip">
            <span>
              Tasks for <strong>{projectName(filterProject)}</strong>
            </span>
            <button className="icon-button" onClick={onClearFilter} title="Show all tasks" aria-label="Show all tasks">
              ×
            </button>
          </div>
          {todayGroup}
          <Group
            title="Project"
            tasks={projectTasks.rest}
            empty={filterProject.snapshot ? "Nothing on you for this project." : "Refresh this project to find your tasks."}
            {...shared}
          />
          {mine.rest.length > 0 && <Group title="All tasks" tasks={keep(mine.rest)} empty="" filtered={filtering} controls={filters} {...shared} />}
        </>
      ) : (
        <>
          {todayGroup}
          <Group title="All tasks" tasks={keep(mine.rest)} empty="No tasks of your own." filtered={filtering} controls={filters} {...shared} />
          <Group
            title="Projects"
            tasks={projectTasks.rest}
            empty="No project tasks on you. Refresh projects to find them."
            {...shared}
          />
          <Group title="Requests" tasks={inbox.rest} empty="No requests from Slack or email." {...shared} />
        </>
      )}
    </section>
  );
}
