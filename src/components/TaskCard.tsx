import { useState } from "react";
import { setTaskState, updateManualTask, type StoredPlan } from "../db";
import { planTask } from "../jobs";
import type { FollowUp, FollowUpKind } from "../schema";
import { ExternalLink } from "./common";

export interface CardTask {
  id: string;
  title: string;
  description?: string | null;
  link?: string | null;
  due?: string | null;
  requester?: string | null;
  follow_up?: FollowUp | null;
  source: "manual" | "slack" | "email";
  done: boolean;
}

const FOLLOW_UP_LABEL: Record<FollowUpKind, string> = {
  reply: "Reply",
  review: "Review",
  decide: "Decide",
  do: "Do",
  schedule: "Schedule",
  share: "Share",
};

const SOURCE_LABEL = { manual: null, slack: "Slack", email: "Email" } as const;

function Plan({ stored }: { stored: StoredPlan }) {
  const { plan } = stored;
  return (
    <div className="plan">
      <p className="small">{plan.approach}</p>
      <ol className="plan-steps small">
        {plan.steps.map((step, i) => (
          <li key={i}>
            <ExternalLink href={step.link} className="plan-step-title">
              {step.title}
            </ExternalLink>
            {step.detail && <div className="muted">{step.detail}</div>}
          </li>
        ))}
      </ol>
      {plan.open_questions.length > 0 && (
        <>
          <h4>Open questions</h4>
          <ul className="small plan-list">
            {plan.open_questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}
      {plan.sources.length > 0 && (
        <div className="chips">
          {plan.sources.map((s) => (
            <ExternalLink key={s.link} href={s.link} className="chip">
              {s.title}
            </ExternalLink>
          ))}
        </div>
      )}
    </div>
  );
}

function EditableDescription({ task, onChange }: { task: CardTask; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.description ?? "");
  if (!editing) {
    return (
      <p className={`description small${task.description ? "" : " muted placeholder"}`} onClick={() => setEditing(true)} title="Click to edit">
        {task.description || "Add a description…"}
      </p>
    );
  }
  return (
    <textarea
      autoFocus
      rows={3}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={async () => {
        setEditing(false);
        if (text.trim() !== (task.description ?? "")) {
          await updateManualTask(task.id, { title: task.title, description: text.trim() || null });
          onChange();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setText(task.description ?? "");
          setEditing(false);
        }
      }}
      placeholder="What's involved, who it's for, links…"
    />
  );
}

export function TaskCard({
  task,
  plan,
  planning,
  onChange,
}: {
  task: CardTask;
  plan: StoredPlan | undefined;
  planning: boolean;
  onChange: () => void;
}) {
  const [showPlan, setShowPlan] = useState(false);
  // Inbox tasks come with a follow-up; for the rest, the plan's first step is the next action.
  const firstStep = plan?.plan.steps[0];
  const followUp: FollowUp | null = task.follow_up ?? (firstStep ? { kind: "do", action: firstStep.title } : null);
  const runPlan = () => {
    setShowPlan(true);
    planTask({
      id: task.id,
      title: task.title,
      description: task.description ?? null,
      link: task.link ?? null,
      requester: task.requester ?? null,
      source: task.source === "manual" ? "the user's own to-do list" : task.source,
    }).catch(() => {});
  };

  return (
    <article className={`card task-card${task.done ? " done" : ""}`}>
      <header className="task-card-header">
        <input
          type="checkbox"
          checked={task.done}
          onChange={async (e) => {
            await setTaskState(task.id, { done: e.target.checked, dismissed: false });
            onChange();
          }}
        />
        <ExternalLink href={task.link} className="task-title">
          {task.title}
        </ExternalLink>
        <button
          className="icon-button dismiss"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={async () => {
            await setTaskState(task.id, { done: task.done, dismissed: true });
            onChange();
          }}
        >
          ×
        </button>
      </header>

      {(SOURCE_LABEL[task.source] || task.requester || task.due) && (
        <div className="muted small task-meta">
          {SOURCE_LABEL[task.source] && <span className={`source ${task.source}`}>{SOURCE_LABEL[task.source]}</span>}
          {task.requester && <span>{task.requester}</span>}
          {task.due && <span className="due">due {task.due}</span>}
        </div>
      )}

      {task.source === "manual" ? (
        <EditableDescription key={task.description ?? ""} task={task} onChange={onChange} />
      ) : (
        task.description && <p className="description small">{task.description}</p>
      )}

      {followUp && (
        <div className={`follow-up ${followUp.kind}`}>
          <span className="follow-up-kind">{task.follow_up ? FOLLOW_UP_LABEL[followUp.kind] : "Next"}</span>
          <span className="small">{followUp.action}</span>
        </div>
      )}

      <footer className="task-card-actions">
        {planning ? (
          <span className="muted small">
            <span className="spin">↻</span> Claude is researching a plan…
          </span>
        ) : plan ? (
          <>
            <button className="link-button small" onClick={() => setShowPlan((s) => !s)}>
              {showPlan ? "Hide plan" : `Show plan (${plan.plan.steps.length} steps)`}
            </button>
            <button className="link-button small muted" onClick={runPlan}>
              Regenerate
            </button>
          </>
        ) : (
          <button className="link-button small" onClick={runPlan}>
            ✦ Plan with Claude
          </button>
        )}
      </footer>

      {showPlan && plan && !planning && <Plan stored={plan} />}
    </article>
  );
}
