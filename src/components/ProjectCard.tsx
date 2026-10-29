import { updateProjectConfig, type Project } from "../db";
import { refreshProject } from "../jobs";
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

/** One line of label, owners and age, with the work itself underneath. */
function WorkItem({ item, label, kind }: { item: Blocker; label: string; kind: "blocker" | "active" }) {
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
  onSelect,
  onChange,
}: {
  project: Project;
  busy: boolean;
  taskStates: Map<string, TaskState>;
  /** Whether the Tasks column is filtered to this project. */
  selected: boolean;
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
            {projectName(project)}
          </h3>
          <ExternalLink href={slackChannelUrl(project.channel_id)} className="project-channel">
            #{project.name}
          </ExternalLink>
          <div className="project-meta">
            <Updated at={project.last_refreshed_at} />
            {openTasks > 0 && (
              <span className="small task-count">
                · {openTasks} task{openTasks === 1 ? "" : "s"} for you{selected ? " (shown in Tasks)" : ""}
              </span>
            )}
          </div>
        </div>
        <div className="row">
          <button
            className="link-button small untrack"
            title="Stop tracking this project. You can track it again in Settings."
            onClick={async () => {
              await updateProjectConfig(project.channel_id, { hidden: true, local_repos: project.local_repos, gh_repos: project.gh_repos });
              onChange();
            }}
          >
            Untrack
          </button>
          {s?.raci && (
            <span className={`badge raci ${s.raci.role}`} title={`${RACI_LABEL[s.raci.role]}: ${s.raci.reason}`}>
              {s.raci.role[0].toUpperCase()}
            </span>
          )}
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
                <WorkItem key={b.id} item={b} label="Blocked by" kind="blocker" />
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
    </article>
  );
}
