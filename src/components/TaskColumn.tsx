import { useState } from "react";
import { addManualTask, type AdhocStore, type ManualTask, type Project, type StoredPlan } from "../db";
import { assessPendingTasks, refreshAdhoc } from "../jobs";
import type { ManualAssessment } from "../schema";
import { applyTaskState, formatMinutes, splitToday, type TaskState } from "../tasks";
import { localDate } from "../scheduler";
import { RefreshButton, Updated } from "./common";
import { TaskCard, type CardTask } from "./TaskCard";

function Group({
  title,
  tasks,
  empty,
  plans,
  assessments,
  running,
  onChange,
}: {
  title: string;
  tasks: CardTask[];
  empty: string;
  plans: Map<string, StoredPlan>;
  assessments: Map<string, ManualAssessment>;
  running: string[];
  onChange: () => void;
}) {
  return (
    <>
      <h4>{title}</h4>
      {tasks.length === 0 && <p className="muted small">{empty}</p>}
      {tasks.map((t) => (
        <TaskCard
          key={t.id}
          task={t}
          plan={plans.get(t.id)}
          planning={running.includes(`plan:${t.id}`)}
          manualAssessment={assessments.get(t.id)}
          assessing={running.includes("assess")}
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
  running: string[];
  onChange: () => void;
}) {
  const [draft, setDraft] = useState("");
  const shared = { plans, assessments, running, onChange };
  const today = localDate(new Date());

  // Slack and email items share one inbox; dated items first, soonest first.
  const inbox = splitToday(
    applyTaskState(
      [...adhoc.tasks].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999")),
      taskStates,
    ),
    today,
  );

  // The user's tasks from project snapshots: blockers first, then by due date.
  const fromProjects = (filterProject ? [filterProject] : projects).flatMap((p) => {
    const blocking = new Set(
      (p.snapshot?.blockers ?? []).filter((b) => b.owners.some((o) => o.is_me)).map((b) => b.id),
    );
    return (p.snapshot?.my_tasks ?? []).map((t) => ({
      ...t,
      source: "project" as const,
      project: { id: p.channel_id, name: p.name },
      blocking: blocking.has(t.id),
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
    ).map((t) => ({ ...t, source: "manual" as const })),
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
    <section className={`today-plan${planned.length ? "" : " empty"}`}>
      <h4>
        ☀ Today
        {planned.length > 0 && (
          <span className="today-total">
            {planned.filter((t) => !t.done).length} open{remaining > 0 && ` · ~${formatMinutes(remaining)}`}
          </span>
        )}
      </h4>
      {planned.length === 0 ? (
        <p className="muted small">Pick tasks for today with their ☀ Today button.</p>
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

  return (
    <section className="column">
      <header className="column-header">
        <div>
          <h2>Tasks</h2>
          <Updated at={adhoc.refreshed_at} />
        </div>
        <RefreshButton busy={running.includes("adhoc") || running.includes("assess")} title="Refresh tasks" onClick={() => {
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
              Tasks for <strong>#{filterProject.name}</strong>
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
          {mine.rest.length > 0 && <Group title="Mine" tasks={mine.rest} empty="" {...shared} />}
        </>
      ) : (
        <>
          {todayGroup}
          <Group title="Mine" tasks={mine.rest} empty="No tasks of your own." {...shared} />
          <Group
            title="Projects"
            tasks={projectTasks.rest}
            empty="No project tasks on you. Refresh projects to find them."
            {...shared}
          />
          <Group title="Inbox" tasks={inbox.rest} empty="Nothing waiting on you in Slack or email." {...shared} />
        </>
      )}
    </section>
  );
}
