import { useState } from "react";
import { updateProjectConfig, type Project, type Reminder } from "../db";
import { refreshProject, sendReminder } from "../jobs";
import { reminderText, toSlackMentions } from "../prompts";
import type { Blocker, ProjectStatus, PullRequest, Raci } from "../schema";
import { age, applyTaskState, type TaskState } from "../tasks";
import { projectName, slackChannelUrl } from "../projects";
import { useJobStatus } from "../useAppData";
import { ExternalLink, RefreshButton, Updated } from "./common";

const STATUS_LABEL: Record<ProjectStatus, string> = {
  blocked: "Blocked",
  at_risk: "At risk",
  on_track: "On track",
  idle: "Idle",
};


const RACI_LABEL: Record<Raci, string> = {
  responsible: "Responsible",
  accountable: "Accountable",
  consulted: "Consulted",
  informed: "Informed",
};

/** Slack's mark: one arm (a long bar and a short nub) repeated at 90° in each brand color. */
function SlackIcon() {
  const arms = ["#36C5F0", "#2EB67D", "#ECB22E", "#E01E5A"];
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
      {arms.map((color, i) => (
        <g key={color} transform={`rotate(${i * 90} 12 12)`} fill={color}>
          <rect x="8.5" y="1" width="4" height="10" rx="2" />
          <rect x="3.5" y="7" width="4" height="4" rx="2" />
        </g>
      ))}
    </svg>
  );
}

/** Hides a project from the dashboard after an inline confirmation. */
function Untrack({ name, onConfirm }: { name: string; onConfirm: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={`untrack small${confirming ? " confirming" : ""}`}>
      {confirming ? (
        <>
          <span className="muted">Untrack {name}?</span>
          <button className="link-button small danger" onClick={onConfirm}>
            Yes
          </button>
          <button className="link-button small muted" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button
          className="link-button small muted"
          title="Stop tracking this project. You can track it again in Settings."
          onClick={() => setConfirming(true)}
        >
          Untrack
        </button>
      )}
    </div>
  );
}

/** "Send reminder" on a blocker someone else owns: an editable nudge posted to the project channel. */
function RemindAction({
  item,
  channelId,
  reminder,
  onSent,
}: {
  item: Blocker;
  channelId: string;
  reminder: Reminder | undefined;
  onSent: () => void;
}) {
  const others = item.owners.filter((o) => !o.is_me && o.slack_user_id);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sending = useJobStatus(`remind:${item.id}`);
  if (others.length === 0) return null;

  if (text === null) {
    return (
      <span className="remind">
        {reminder && (
          <ExternalLink href={reminder.link} className="muted small reminded" title={new Date(reminder.at).toLocaleString()}>
            Reminded {age(reminder.at)} ago
          </ExternalLink>
        )}
        <button
          className="link-button small remind-open"
          onClick={() => {
            setError(null);
            setText(reminderText(others, item.what, item.link));
          }}
        >
          Send reminder
        </button>
      </span>
    );
  }

  return (
    <div className="remind-composer" onClick={(e) => e.stopPropagation()}>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} disabled={!!sending} />
      <div className="remind-actions small">
        <span className="muted">
          {sending ? `${sending}…` : error ? <span className="error">Couldn't send: {error}</span> : "Posts to the project channel"}
        </span>
        <span className="remind-buttons">
          <button className="link-button small muted" disabled={!!sending} onClick={() => setText(null)}>
            Cancel
          </button>
          <button
            className="link-button small"
            disabled={!!sending || !text.trim()}
            onClick={async () => {
              try {
                await sendReminder(item.id, channelId, toSlackMentions(text.trim(), others));
                setText(null);
                onSent();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Send
          </button>
        </span>
      </div>
    </div>
  );
}

/** One line of label, owners and age, with the work itself underneath. */
function WorkItem({
  item,
  label,
  kind,
  remind,
}: {
  item: Blocker;
  label: string;
  kind: "blocker" | "active";
  /** For blockers: the channel to post a reminder in, and any reminder already sent. */
  remind?: { channelId: string; reminder: Reminder | undefined; onSent: () => void };
}) {
  return (
    <li className={`work-item ${kind}`}>
      <div className="owners">
        <h4>{label}</h4>
        {item.owners.map((o) => (
          <span key={o.slack_user_id ?? o.name} className={`owner${o.is_me ? " me" : ""}`}>
            {o.is_me ? "You" : o.name}
          </span>
        ))}
        {item.since && <span className="age">{age(item.since)}</span>}
        {remind && <RemindAction item={item} {...remind} />}
      </div>
      <ExternalLink href={item.link} className="what">
        {item.what}
      </ExternalLink>
    </li>
  );
}

function prLabel(pr: PullRequest) {
  if (pr.isDraft) return "draft";
  if (pr.kind === "review_requested") return "review me";
  return pr.reviewDecision?.toLowerCase().replace("_", " ") ?? "open";
}

export function ProjectCard({
  project,
  busy,
  taskStates,
  selected,
  reminders,
  onSelect,
  onChange,
}: {
  project: Project;
  busy: boolean;
  taskStates: Map<string, TaskState>;
  /** Whether the Tasks column is filtered to this project. */
  selected: boolean;
  /** Reminders already sent about blockers, by blocker id. */
  reminders: Record<string, Reminder>;
  onSelect: () => void;
  onChange: () => void;
}) {
  const s = project.snapshot;
  const status = s?.status;
  const repo = project.repo_state;
  const refreshStatus = useJobStatus(`project:${project.channel_id}`);
  const openTasks = applyTaskState(s?.my_tasks ?? [], taskStates).filter((t) => !t.done).length;

  return (
    <article
      className={`card project ${status ?? "unknown"}${selected ? " selected" : ""}`}
      onClick={(e) => {
        // Links, buttons and the summary toggle keep their own behavior.
        if (!(e.target as HTMLElement).closest("a, button, input, summary")) onSelect();
      }}
      title={selected ? "Showing only this project's tasks. Click to show all." : "Click to show only this project's tasks"}
    >
      <header className="card-header">
        <div>
          <h3>
            {s?.priority && (
              <span className={`p-badge ${s.priority.level}`} title={s.priority.reason}>
                {s.priority.level}
              </span>
            )}
            {s?.raci && (
              <span className={`badge raci ${s.raci.role}`} title={`${RACI_LABEL[s.raci.role]}: ${s.raci.reason}`}>
                {s.raci.role[0].toUpperCase()}
              </span>
            )}
            {projectName(project)}
            <ExternalLink href={slackChannelUrl(project.channel_id)} className="slack-link" title={`Open #${project.name} in Slack`}>
              <SlackIcon />
            </ExternalLink>
          </h3>
        </div>
        <div className="row project-header-right">
          {status && <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>}
          <RefreshButton busy={busy} status={refreshStatus} title={`Refresh ${projectName(project)}`} onClick={() => refreshProject(project.channel_id).catch(() => {})} />
        </div>
      </header>

      {project.last_error && <p className="error small">Last refresh failed: {project.last_error}</p>}
      {!s && !project.last_error && <p className="muted small">{busy ? "Reading the channel…" : "Not refreshed yet."}</p>}

      {s && (
        <>
          <details className="project-summary">
            <summary className="muted small">Summary</summary>
            {s.description && <p className="small">{s.description}</p>}
            {s.summary && <p className="small">{s.summary}</p>}
          </details>

          {status !== "on_track" && status !== "idle" && <p className="reason small">{s.status_reason}</p>}

          {s.blockers?.length > 0 && (
            <ul className="work-items">
              {s.blockers.map((b) => (
                <WorkItem
                  key={b.id}
                  item={b}
                  label="Blocked by"
                  kind="blocker"
                  remind={{ channelId: project.channel_id, reminder: reminders[b.id], onSent: onChange }}
                />
              ))}
            </ul>
          )}

          {s.active?.length > 0 && (
            <ul className="work-items">
              {s.active.map((a) => (
                <WorkItem key={a.id} item={a} label="Active" kind="active" />
              ))}
            </ul>
          )}

        </>
      )}

      {repo && (repo.local.length > 0 || repo.prs.length > 0 || repo.errors.length > 0) && (
        <footer className="chips">
          {repo.local.map((r) => (
            <span key={r.path} className={`chip${r.error ? " chip-error" : ""}`} title={r.error ?? r.path}>
              {r.path.split("/").pop()}
              {r.branch && ` · ${r.branch}`}
              {!!r.dirty && ` · ${r.dirty} changed`}
              {!!r.ahead && ` · ↑${r.ahead}`}
              {!!r.behind && ` · ↓${r.behind}`}
            </span>
          ))}
          {repo.prs.map((pr) => (
            <ExternalLink key={pr.url} href={pr.url} className={`chip pr ${pr.kind}`}>
              #{pr.number} {pr.title} · {prLabel(pr)}
            </ExternalLink>
          ))}
          {repo.errors.map((e) => (
            <span key={e} className="chip chip-error" title={e}>
              gh error
            </span>
          ))}
        </footer>
      )}
      <div className="project-footer">
        <div className="project-meta">
          <Updated at={project.last_refreshed_at} />
          {openTasks > 0 && (
            <span className="small task-count">
              · {openTasks} task{openTasks === 1 ? "" : "s"} for you{selected ? " (shown in Tasks)" : ""}
            </span>
          )}
        </div>
        <Untrack
          name={projectName(project)}
          onConfirm={async () => {
            await updateProjectConfig(project.channel_id, { hidden: true, local_repos: project.local_repos, gh_repos: project.gh_repos });
            onChange();
          }}
        />
      </div>
    </article>
  );
}
