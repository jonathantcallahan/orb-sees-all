import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { setTaskState, updateProjectConfig, type Project, type Reminder, type StoredBlockerCheck } from "../db";
import { checkBlocker, refreshProject, sendReminder } from "../jobs";
import { reminderText, toSlackMentions } from "../prompts";
import type { Blocker, BlockerCheck, ProjectStatus, PullRequest, Raci } from "../schema";
import { age, ago, blockerKey, stateOf, type TaskState } from "../tasks";
import { COLORED_ICONS } from "../linkIcons";
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

/** Slack's mark, the same icon the link chips use. */
function SlackIcon() {
  return <img src={COLORED_ICONS.slack} width={12} height={12} alt="" />;
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

const VERDICT_LABEL: Record<BlockerCheck["verdict"], string> = {
  still_blocking: "Still blocking",
  resolved: "Resolved elsewhere",
  partly_resolved: "Partly resolved",
  not_blocking: "Not really a blocker",
  unclear: "Unclear",
};

/** "Double check": Claude looks for whether a blocker is real and already solved elsewhere. */
function CheckAction({ checking, onCheck }: { checking: string | undefined; onCheck: () => void }) {
  if (checking) {
    return (
      <span className="muted small checking" title={checking}>
        <span className="spin">✦</span> {checking}…
      </span>
    );
  }
  return (
    <button className="link-button small more-link" onClick={onCheck}>
      Double check
    </button>
  );
}

function CheckResult({ check, onResolve, onDismiss }: { check: StoredBlockerCheck; onResolve: () => void; onDismiss: () => void }) {
  const clearable = check.verdict === "resolved" || check.verdict === "not_blocking";
  return (
    <div className={`check-result ${check.verdict}`} onClick={(e) => e.stopPropagation()}>
      <div className="check-head small">
        <span className="check-verdict">{VERDICT_LABEL[check.verdict]}</span>
        <span className="timestamp">checked {ago(check.at)}</span>
      </div>
      <p className="small">{check.summary}</p>
      {check.next_step && <p className="small muted">Next: {check.next_step}</p>}
      <div className="check-actions small">
        {check.evidence.map((e) => (
          <ExternalLink key={e.link} href={e.link} className="chip">
            {e.title}
          </ExternalLink>
        ))}
        <span className="check-buttons">
          {clearable && (
            <button className="link-button small" onClick={onResolve}>
              Mark resolved
            </button>
          )}
          <button className="link-button small muted" onClick={onDismiss}>
            Hide
          </button>
        </span>
      </div>
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

  const send = async () => {
    if (!text?.trim()) return;
    try {
      await sendReminder(item.id, channelId, toSlackMentions(text.trim(), others));
      setText(null);
      onSent();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <button
        className="link-button small"
        onClick={() => {
          setError(null);
          setText(reminderText(others, item.what, item.link));
        }}
      >
        {reminder ? "Send another reminder" : "Send reminder"}
      </button>
      {text !== null && (
        <ReminderModal
          to={others.map((o) => o.name).join(", ")}
          text={text}
          status={sending ? `${sending}…` : error ? `Couldn't send: ${error}` : null}
          failed={!!error && !sending}
          busy={!!sending}
          onChange={setText}
          onCancel={() => !sending && setText(null)}
          onSend={send}
        />
      )}
    </>
  );
}

/** The reminder text in a centered modal, editable before it's posted. Esc cancels; ⌘↩ sends. */
function ReminderModal({
  to,
  text,
  status,
  failed,
  busy,
  onChange,
  onCancel,
  onSend,
}: {
  to: string;
  text: string;
  status: string | null;
  failed: boolean;
  busy: boolean;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Portaled to <body>; clicks still bubble through React, so stop them before they select the project.
  return createPortal(
    <div
      className="modal-backdrop plan-modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="modal plan-modal" role="dialog" aria-label={`Remind ${to}`} onClick={(e) => e.stopPropagation()}>
        <header className="column-header">
          <h2>Remind {to}</h2>
        </header>
        <textarea
          autoFocus
          className="description-editor"
          rows={6}
          value={text}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSend();
          }}
        />
        <footer className="plan-modal-actions edit-actions">
          <span className={`small ${failed ? "error" : "muted"} remind-status`}>{status ?? "Posts to the project's Slack channel, tagging them."}</span>
          <button className="cta-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="cta-primary" disabled={busy || !text.trim()} onClick={onSend} title="Post to the project channel (⌘↩)">
            Send
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** Marks a list that includes something owned by the user. */
function MineDot() {
  return <span className="mine-dot" title="Includes something of yours" aria-label="Includes something of yours" />;
}

/** One line of label, owners and age, with the work itself underneath. */
function WorkItem({
  item,
  kind,
  remind,
  check,
}: {
  item: Blocker;
  kind: "blocker" | "active";
  /** For blockers: the channel to post a reminder in, and any reminder already sent. */
  remind?: { channelId: string; reminder: Reminder | undefined; onSent: () => void };
  /** For blockers: run a double check, and its latest result. */
  check?: {
    result: StoredBlockerCheck | undefined;
    onCheck: () => void;
    onResolve: () => void;
  };
}) {
  const checking = useJobStatus(`check:${item.id}`);
  const [hideResult, setHideResult] = useState(false);
  return (
    <li className={`work-item ${kind}`}>
      <div className="owners">
        {item.owners.map((o) => (
          <span key={o.slack_user_id ?? o.name} className={`owner${o.is_me ? " me" : ""}`}>
            {o.is_me ? "You" : o.name}
          </span>
        ))}
        {item.since && <span className="age">{age(item.since)}</span>}
        {remind?.reminder && (
          <ExternalLink href={remind.reminder.link} className="timestamp reminded" title={new Date(remind.reminder.at).toLocaleString()}>
            Reminded {ago(remind.reminder.at)}
          </ExternalLink>
        )}
        {(check || remind) && (
          // Slides open on hover; stays open while a double check runs so its status shows.
          <span className={`work-actions${checking ? " open" : ""}`}>
            {check && (
              <CheckAction
                checking={checking}
                onCheck={() => {
                  setHideResult(false);
                  check.onCheck();
                }}
              />
            )}
            {remind && <RemindAction item={item} {...remind} />}
          </span>
        )}
      </div>
      <span className="what">{item.what}</span>
      {check?.result && !hideResult && !checking && (
        <CheckResult check={check.result} onResolve={check.onResolve} onDismiss={() => setHideResult(true)} />
      )}
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
  blockerChecks,
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
  /** Double checks of blockers, by blocker id. */
  blockerChecks: Record<string, StoredBlockerCheck>;
  onSelect: () => void;
  onChange: () => void;
}) {
  const s = project.snapshot;
  const status = s?.status;
  const repo = project.repo_state;
  const refreshStatus = useJobStatus(`project:${project.channel_id}`);
  // Blocking and Active are tabs: none open at first, clicking the open tab closes it,
  // clicking the other one switches to it.
  const [tab, setTab] = useState<"blockers" | "active" | null>(null);
  const toggle = (next: "blockers" | "active") => setTab((current) => (current === next ? null : next));
  // Blockers the user marked resolved after a double check stay hidden.
  const blockers = (s?.blockers ?? []).filter((b) => !stateOf(taskStates, blockerKey(b.id)).dismissed);

  return (
    <article
      className={`card project ${status ?? "unknown"}${selected ? " selected" : ""}`}
      onClick={(e) => {
        // Links, buttons and inputs keep their own behavior.
        if (!(e.target as HTMLElement).closest("a, button, input, textarea, select")) onSelect();
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
          {s.status_reason && <p className="reason small">{s.status_reason}</p>}

          {(blockers.length > 0 || (s.active?.length ?? 0) > 0) && (
            <div className="work-tabs" role="tablist">
              {blockers.length > 0 && (
                <button role="tab" aria-selected={tab === "blockers"} className={`work-tab${tab === "blockers" ? " open" : ""}`} onClick={() => toggle("blockers")}>
                  Blocking {blockers.length}
                  {blockers.some((b) => b.owners.some((o) => o.is_me)) && <MineDot />}
                </button>
              )}
              {(s.active?.length ?? 0) > 0 && (
                <button role="tab" aria-selected={tab === "active"} className={`work-tab${tab === "active" ? " open" : ""}`} onClick={() => toggle("active")}>
                  Active {s.active.length}
                  {s.active.some((a) => a.owners.some((o) => o.is_me)) && <MineDot />}
                </button>
              )}
            </div>
          )}

          {tab === "blockers" && blockers.length > 0 && (
            <ul className="work-items">
              {blockers.map((b) => (
                <WorkItem
                  key={b.id}
                  item={b}
                  kind="blocker"
                  remind={{ channelId: project.channel_id, reminder: reminders[b.id], onSent: onChange }}
                  check={{
                    result: blockerChecks[b.id],
                    onCheck: () => checkBlocker(projectName(project), project.channel_id, b).then(onChange, () => {}),
                    onResolve: async () => {
                      await setTaskState(blockerKey(b.id), { dismissed: true });
                      onChange();
                    },
                  }}
                />
              ))}
            </ul>
          )}

          {tab === "active" && s.active?.length > 0 && (
            <ul className="work-items">
              {s.active.map((a) => (
                <WorkItem key={a.id} item={a} kind="active" />
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
