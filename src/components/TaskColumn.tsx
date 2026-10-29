import { useState } from "react";
import { addManualTask, type AdhocStore, type ManualTask, type Project, type StoredPlan } from "../db";
import { refreshAdhoc } from "../jobs";
import { applyTaskState, type TaskState } from "../tasks";
import { RefreshButton, Updated } from "./common";
import { TaskCard, type CardTask } from "./TaskCard";

function Group({
  title,
  tasks,
  empty,
  plans,
  running,
  onChange,
}: {
  title: string;
  tasks: CardTask[];
  empty: string;
  plans: Map<string, StoredPlan>;
  running: string[];
  onChange: () => void;
}) {
  return (
    <>
      <h4>{title}</h4>
      {tasks.length === 0 && <p className="muted small">{empty}</p>}
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} plan={plans.get(t.id)} planning={running.includes(`plan:${t.id}`)} onChange={onChange} />
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
  running: string[];
  onChange: () => void;
}) {
  const [draft, setDraft] = useState("");
  // Slack and email items share one inbox; dated items first, soonest first.
  const inbox = applyTaskState(
    [...adhoc.tasks].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999")),
    taskStates,
  );
  const shared = { plans, running, onChange };

  // The user's tasks from project snapshots: blockers first, then by due date.
  const projectTasks = (filterProject ? [filterProject] : projects).flatMap((p) => {
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
  projectTasks.sort(
    (a, b) => Number(b.blocking) - Number(a.blocking) || (a.due ?? "9999").localeCompare(b.due ?? "9999"),
  );
  const mine = applyTaskState(
    manual.filter((t) => !filterProject || t.project_id === filterProject.channel_id),
    taskStates,
  ).map((t) => ({ ...t, source: "manual" as const }));

  return (
    <section className="column">
      <header className="column-header">
        <div>
          <h2>Tasks</h2>
          <Updated at={adhoc.refreshed_at} />
        </div>
        <RefreshButton busy={running.includes("adhoc")} title="Refresh tasks" onClick={() => refreshAdhoc().catch(() => {})} />
      </header>

      <form
        className="add-task"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          await addManualTask(draft.trim());
          setDraft("");
          onChange();
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
          <Group
            title="Project"
            tasks={applyTaskState(projectTasks, taskStates)}
            empty={filterProject.snapshot ? "Nothing on you for this project." : "Refresh this project to find your tasks."}
            {...shared}
          />
          {mine.length > 0 && <Group title="Mine" tasks={mine} empty="" {...shared} />}
        </>
      ) : (
        <>
          <Group title="Mine" tasks={mine} empty="No tasks of your own." {...shared} />
          <Group
            title="Projects"
            tasks={applyTaskState(projectTasks, taskStates)}
            empty="No project tasks on you. Refresh projects to find them."
            {...shared}
          />
          <Group title="Inbox" tasks={inbox} empty="Nothing waiting on you in Slack or email." {...shared} />
        </>
      )}
    </section>
  );
}
