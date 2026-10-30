import { useEffect, useState, useSyncExternalStore } from "react";
import { runCli } from "../cli";
import * as db from "../db";
import { dataVersion, recheckTrackedItem, refreshTracking } from "../jobs";
import type { ProjectTracking, TrackedItem } from "../jobs/tracking";
import { linkKind } from "../links";
import { ago } from "../tasks";
import { useJobStatus } from "../useAppData";
import { ExternalLink, Spinner } from "./common";
import { LinkIcon } from "./LinkChips";

/** How many items show before "Show more". */
const FIRST = 6;

const STATE_LABEL: Record<string, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const CHECKS_LABEL = { passing: "Checks pass", failing: "Checks fail", pending: "Checks running" } as const;
const REVIEW_LABEL = { approved: "Approved", changes: "Changes requested", needed: "Review needed" } as const;

function RecheckButton({ projectId, item }: { projectId: string; item: TrackedItem }) {
  const running = useJobStatus(`tracking:${item.id}`);
  return (
    <button
      className="icon-button tracking-recheck"
      disabled={!!running}
      aria-label={`Check ${item.title} again`}
      onClick={() => recheckTrackedItem(projectId, item).catch(() => {})}
    >
      {running ? (
        <Spinner />
      ) : (
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
          <path d="M10 6a4 4 0 1 1-1.2-2.85M10 1.5v2.7H7.3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

function Row({ projectId, item }: { projectId: string; item: TrackedItem }) {
  const state = item.kind === "epic" ? item.state : (STATE_LABEL[item.state] ?? item.state);
  return (
    <li className={`tracking-item ${item.kind}`}>
      <LinkIcon kind={item.kind === "epic" ? linkKind(item.url) : "github"} />
      <div className="tracking-main">
        <div className="tracking-title-line">
          <ExternalLink href={item.url} className="tracking-title">
            {item.title}
          </ExternalLink>
        </div>
        <div className="tracking-meta">
          <span className={`tracking-pill state-${item.kind === "epic" ? "epic" : item.state}`}>{item.kind === "branch" ? "Branch" : state}</span>
          {item.checks && <span className={`tracking-pill checks-${item.checks}`}>{CHECKS_LABEL[item.checks]}</span>}
          {item.review && <span className={`tracking-pill review-${item.review}`}>{REVIEW_LABEL[item.review]}</span>}
          {item.detail && <span className="muted">{item.detail}</span>}
          {item.repo && item.kind !== "branch" && <span className="muted">{item.repo.split("/")[1]}</span>}
          {item.updatedAt && <span className="timestamp">{ago(item.updatedAt)}</span>}
        </div>
      </div>
      <RecheckButton projectId={projectId} item={item} />
    </li>
  );
}

/**
 * A project's tracking feed in its About modal: Jira epics and GitHub pull requests and open
 * branches, newest activity first, each with its status and a button to check it again.
 */
export function TrackingFeed({ projectId }: { projectId: string }) {
  const version = useSyncExternalStore(dataVersion.subscribe, dataVersion.get);
  const [tracking, setTracking] = useState<ProjectTracking | null | undefined>(undefined);
  const [github, setGithub] = useState<boolean | null>(null);
  const [all, setAll] = useState(false);
  const checking = useJobStatus(`tracking:${projectId}`);
  useEffect(() => {
    db.getProjectTracking().then((t) => setTracking(t[projectId] ?? null), () => setTracking(null));
  }, [projectId, version]);
  useEffect(() => {
    runCli("gh", ["auth", "status"]).then((out) => setGithub(out.code === 0), () => setGithub(false));
  }, []);

  const items = tracking?.items ?? [];
  const shown = all ? items : items.slice(0, FIRST);
  return (
    <section className="tracking">
      <header className="tracking-header">
        <h3>Tracking</h3>
        {tracking && <span className="timestamp">checked {ago(tracking.checkedAt)}</span>}
        <button className="link-button small" disabled={!!checking} onClick={() => refreshTracking(projectId).catch(() => {})}>
          {checking ? "Checking…" : "Check now"}
        </button>
      </header>
      {github === false && (
        <p className="small muted tracking-note">
          GitHub isn't connected, so pull requests and branches don't show. Install the <ExternalLink href="https://cli.github.com">GitHub CLI</ExternalLink> and run{" "}
          <code>gh auth login</code>, then check again.
        </p>
      )}
      {tracking === undefined ? null : items.length === 0 ? (
        <p className="small muted">
          {tracking
            ? "No epics or GitHub activity found. Add the project's repos in Settings, or refresh the project to look for its epics."
            : "Refresh the project to find its Jira epics and GitHub activity."}
        </p>
      ) : (
        <ul className="tracking-list">
          {shown.map((item) => (
            <Row key={item.id} projectId={projectId} item={item} />
          ))}
        </ul>
      )}
      {items.length > FIRST && (
        <button className="link-button small more-link" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show ${items.length - FIRST} more`}
        </button>
      )}
      {!!tracking?.errors.length && <p className="small error">Couldn't read {tracking.errors.join("; ")}</p>}
    </section>
  );
}
