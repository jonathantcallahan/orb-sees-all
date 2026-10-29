import { updateProjectConfig, type Project } from "../db";
import { refreshProject } from "../jobs";
import type { ProjectStatus, PullRequest, Raci } from "../schema";
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
          <Updated at={project.last_refreshed_at} />
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
          {status && <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>}
          <RefreshButton busy={busy} status={refreshStatus} title={`Refresh ${projectName(project)}`} onClick={() => refreshProject(project.channel_id).catch(() => {})} />
        </div>
      </header>

      {project.last_error && <p className="error small">Last refresh failed: {project.last_error}</p>}
      {!s && !project.last_error && <p className="muted small">{busy ? "Reading the channel…" : "Not refreshed yet."}</p>}

      {s && (
        <>
          <div className="badges">
            {s.raci && (
              <span className={`badge raci ${s.raci.role}`} title={s.raci.reason}>
                <strong>{s.raci.role[0].toUpperCase()}</strong> {RACI_LABEL[s.raci.role]}
              </span>
            )}
          </div>

          {s.description && <p className="project-description">{s.description}</p>}
          {status !== "on_track" && status !== "idle" && <p className="reason small">{s.status_reason}</p>}

          {s.blockers?.length > 0 && (
            <ul className="blockers">
              {s.blockers.map((b) => (
                <li key={b.id}>
                  <div className="owners">
                    <h4>Blocked by</h4>
                    {b.owners.map((o) => (
                      <span key={o.slack_user_id ?? o.name} className={`owner${o.is_me ? " me" : ""}`}>
                        {o.is_me ? "You" : o.name}
                      </span>
                    ))}
                    {b.since && <span className="age">{age(b.since)}</span>}
                  </div>
                  <ExternalLink href={b.link} className="what">
                    {b.what}
                  </ExternalLink>
                </li>
              ))}
            </ul>
          )}

          {openTasks > 0 && (
            <p className="small task-count">
              {openTasks} task{openTasks === 1 ? "" : "s"} for you {selected ? "· shown in Tasks" : "→"}
            </p>
          )}

          <details>
            <summary className="muted small">Summary</summary>
            <p className="small">{s.summary}</p>
          </details>
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
