import { useState } from "react";
import { addManualTask, type AdhocStore, type ManualTask, type StoredPlan } from "../db";
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
  taskStates,
  plans,
  running,
  onChange,
}: {
  adhoc: AdhocStore;
  manual: ManualTask[];
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

      <Group
        title="Mine"
        tasks={applyTaskState(manual, taskStates).map((t) => ({ ...t, source: "manual" as const }))}
        empty="No tasks of your own."
        {...shared}
      />
      <Group title="Inbox" tasks={inbox} empty="Nothing waiting on you in Slack or email." {...shared} />
    </section>
  );
}
