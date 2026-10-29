import { useState } from "react";
import { addManualTask, type AdhocStore, type ManualTask } from "../db";
import { refreshAdhoc } from "../jobs";
import { applyTaskState, type TaskState } from "../tasks";
import { Checklist, RefreshButton, Updated } from "./common";

export function TaskColumn({
  adhoc,
  manual,
  taskStates,
  busy,
  onChange,
}: {
  adhoc: AdhocStore;
  manual: ManualTask[];
  taskStates: Map<string, TaskState>;
  busy: boolean;
  onChange: () => void;
}) {
  const [draft, setDraft] = useState("");
  const fromSource = (source: "slack" | "email") =>
    applyTaskState(
      adhoc.tasks.filter((t) => t.source === source).map((t) => ({ ...t, detail: t.requester })),
      taskStates,
    );

  return (
    <section className="column">
      <header className="column-header">
        <div>
          <h2>Tasks</h2>
          <Updated at={adhoc.refreshed_at} />
        </div>
        <RefreshButton busy={busy} title="Refresh tasks" onClick={() => refreshAdhoc().catch(() => {})} />
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

      <div className="card">
        <h4>Mine</h4>
        <Checklist tasks={applyTaskState(manual, taskStates)} onChange={onChange} empty="No manual tasks." />
      </div>
      <div className="card">
        <h4>Slack</h4>
        <Checklist tasks={fromSource("slack")} onChange={onChange} empty="Nothing waiting in DMs or mentions." />
      </div>
      <div className="card">
        <h4>Email</h4>
        <Checklist tasks={fromSource("email")} onChange={onChange} empty="No emails need action." />
      </div>
    </section>
  );
}
