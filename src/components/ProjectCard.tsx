import { updateProjectConfig, type Project } from "../db";
import { refreshProject } from "../jobs";
import type { ProjectStatus, PullRequest } from "../schema";
import { age, applyTaskState, type TaskState } from "../tasks";
import { Checklist, ExternalLink, RefreshButton, Updated } from "./common";

const STATUS_LABEL: Record<ProjectStatus, string> = {
  blocked: "Blocked",
  at_risk: "At risk",
  on_track: "On track",
  idle: "Idle",
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
  onChange,
}: {
  project: Project;
  busy: boolean;
  taskStates: Map<string, TaskState>;
  onChange: () => void;
}) {
  const s = project.snapshot;
  const status = s?.status;
  const repo = project.repo_state;
  const tasks = applyTaskState(s?.my_tasks ?? [], taskStates);

  return (
    <article className={`card project ${status ?? "unknown"}`}>
      <header className="card-header">
        <div>
          <h3>#{project.name}</h3>
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
          <RefreshButton busy={busy} title={`Refresh #${project.name}`} onClick={() => refreshProject(project.channel_id).catch(() => {})} />
        </div>
      </header>

      {project.last_error && <p className="error small">Last refresh failed: {project.last_error}</p>}
      {!s && !project.last_error && <p className="muted small">{busy ? "Reading the channel…" : "Not refreshed yet."}</p>}

      {s && (
        <>
          <p className="reason">{s.status_reason}</p>

          {s.waiting_on.length > 0 && (
            <section>
              <h4>Waiting on</h4>
              <ul className="waiting">
                {s.waiting_on.map((w, i) => (
                  <li key={i}>
                    <strong>{w.person}</strong>
                    {w.since && <span className="age">{age(w.since)}</span>}
                    <ExternalLink href={w.link} className="what">
                      {w.what}
                    </ExternalLink>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h4>My tasks</h4>
            <Checklist tasks={tasks} onChange={onChange} empty="Nothing on you." />
          </section>

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
