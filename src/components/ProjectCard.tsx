import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { setTaskState, updateProjectConfig, type Project, type Reminder, type StoredBlockerCheck } from "../db";
import { checkBlocker, refreshProject, sendReminder } from "../jobs";
import { reminderText, toSlackMentions, updateRequestText } from "../prompts";
import type { Blocker, BlockerCheck, ProjectStatus, PullRequest, Raci } from "../schema";
import { age, ago, blockerKey, stateOf, type TaskState } from "../tasks";
import { COLORED_ICONS } from "../linkIcons";
import { linkKind } from "../links";
import { LinkChips } from "./LinkChips";
import { TrackingFeed } from "./TrackingFeed";
import { activeChannels, projectName, slackChannelUrl } from "../projects";
import { useJobStatus } from "../useAppData";
import { CloseIcon, ComposeModal, ExternalLink, RefreshButton, Spinner, Updated } from "./common";

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

/** Message links from the project's snapshot, which carry its Slack workspace's domain. */
function channelPermalinks(project: Project): (string | null | undefined)[] {
  const s = project.snapshot;
  if (!s) return [];
  return [...s.blockers.map((b) => b.link), ...(s.active ?? []).map((a) => a.link), ...s.my_tasks.map((t) => t.link), ...(s.recent_updates ?? []).map((u) => u.link)];
}

type ProfilePerson = NonNullable<Project["profile"]>["people"][number];

/** A person on the project; hovering shows their role in a card (native tooltips don't show in the app). */
function PersonChip({ person }: { person: ProfilePerson }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const width = 220;
  return (
    <>
      <span className="chip person-chip" onMouseEnter={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} onMouseLeave={() => setAnchor(null)}>
        {person.name}
      </span>
      {anchor &&
        createPortal(
          <div
            className="card meeting-card person-card"
            role="tooltip"
            style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)), top: anchor.bottom + 6, width }}
          >
            <div className="meeting-card-title">{person.name}</div>
            <div className="small">{person.role}</div>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * What's known about the project, built up by its refreshes: goal, channels, people, milestones,
 * links, decisions. A centered modal, portaled to <body>.
 */
function ProfileModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const p = project.profile;
  const channels = activeChannels(project);
  const permalinks = channelPermalinks(project);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clicks still bubble through React from the portal, so stop them before they select the project.
  return createPortal(
    <div
      className="modal-backdrop plan-modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="modal plan-modal profile-modal" role="dialog" aria-label={`About ${projectName(project)}`} onClick={(e) => e.stopPropagation()}>
        <header className="column-header">
          <h2>{projectName(project)}</h2>
          <button className="icon-button" title="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        {(p?.goal || project.snapshot?.description) && <p className="profile-goal">{p?.goal || project.snapshot?.description}</p>}
      <dl>
        <dt>Channels</dt>
        <dd>
          <LinkChips links={channels.map((c) => ({ url: slackChannelUrl(c.channel_id, permalinks), title: `#${c.name}`, kind: "slack" as const }))} />
        </dd>
        {!!p?.aliases.length && (
          <>
            <dt>Also called</dt>
            <dd>{p.aliases.join(", ")}</dd>
          </>
        )}
        {!!p?.people.length && (
          <>
            <dt>People</dt>
            <dd className="profile-channels">
              {p.people.map((x) => (
                <PersonChip key={x.name} person={x} />
              ))}
            </dd>
          </>
        )}
        {!!p?.milestones.length && (
          <>
            <dt>Milestones</dt>
            <dd>
              <ul className="profile-list">
                {p.milestones.map((m) => (
                  <li key={m.what} className={`milestone ${m.status}`}>
                    {m.date && <span className="muted">{m.date} · </span>}
                    {m.what}
                    {m.status !== "planned" && <span className="muted"> · {m.status.replace("_", " ")}</span>}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {!!p?.resources.length && (
          <>
            <dt>Links</dt>
            <dd>
              <LinkChips links={p.resources.map((r) => ({ url: r.link, title: r.title, kind: linkKind(r.link) }))} />
            </dd>
          </>
        )}
        {!!p?.decisions.length && (
          <>
            <dt>Decisions</dt>
            <dd>
              <ul className="profile-list">
                {p.decisions.slice(0, 4).map((d) => (
                  <li key={d.what}>
                    {d.link ? <ExternalLink href={d.link}>{d.what}</ExternalLink> : d.what}
                    {d.date && <span className="muted"> · {d.date}</span>}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        </dl>
        {!p && <p className="muted small">The next refresh builds the project's profile.</p>}
        <TrackingFeed projectId={project.channel_id} />
      </div>
    </div>,
    document.body,
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

const VERDICT_LABEL: Record<BlockerCheck["verdict"], string> = {
  still_blocking: "Still blocking",
  resolved: "Resolved elsewhere",
  partly_resolved: "Partly resolved",
  not_blocking: "Not really a blocker",
  unclear: "Unclear",
};

/** "Double check": Claude looks for whether a blocker is real and already solved elsewhere. */
function CheckAction({ checking, onCheck, label = "Double check" }: { checking: string | undefined; onCheck: () => void; label?: string }) {
  if (checking) {
    return (
      <span className="muted small checking" title={checking}>
        <Spinner /> {checking}…
      </span>
    );
  }
  return (
    <button className="link-button small more-link" onClick={onCheck}>
      {label}
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
        <LinkChips links={check.evidence.map((e) => ({ url: e.link, title: e.title, kind: linkKind(e.link) }))} />
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
  ask = "reminder",
}: {
  item: Blocker;
  channelId: string;
  reminder: Reminder | undefined;
  onSent: () => void;
  /** A nudge on a blocker, or a check-in on active work. Both post to the channel, tagging the owners. */
  ask?: "reminder" | "update";
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
          setText((ask === "update" ? updateRequestText : reminderText)(others, item.what, item.link));
        }}
      >
        {ask === "update" ? (reminder ? "Ask again" : "Ask for update") : reminder ? "Send another reminder" : "Send reminder"}
      </button>
      {text !== null && (
        <ComposeModal
          heading={`${ask === "update" ? "Ask for an update from" : "Remind"} ${others.map((o) => o.name).join(", ")}`}
          note="Posts to the project's Slack channel, tagging them."
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


/** The × in an open tab. The tab itself toggles, so clicking it (or the ×) closes the tab. */
function TabClose() {
  return (
    <span className="tab-close" aria-label="Close" title="Close">
      <CloseIcon />
    </span>
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
  /** The channel to post a reminder (blockers) or update request (active work) in, and any already sent. */
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
            {kind === "active" ? "Asked" : "Reminded"} {ago(remind.reminder.at)}
          </ExternalLink>
        )}
        {(check || remind) && (
          // Slides open on hover; stays open while a double check runs so its status shows.
          <span className={`work-actions${checking ? " open" : ""}`}>
            {/* After a reminder, the same check looks for replies to it: Check status. */}
            {check && (
              <CheckAction
                label={remind?.reminder ? "Check status" : "Double check"}
                checking={checking}
                onCheck={() => {
                  setHideResult(false);
                  check.onCheck();
                }}
              />
            )}
            {remind && <RemindAction item={item} ask={kind === "active" ? "update" : "reminder"} {...remind} />}
            {/* A blocker that's been handled: clear it by hand, as a double check's Mark resolved does. */}
            {check && (
              <button
                className="link-button small more-link"
                onClick={check.onResolve}
                title={item.owners.some((o) => o.is_me) ? "Done: clear the blocker and mark your task done" : "They've done it: stop listing this as blocking"}
              >
                Mark done
              </button>
            )}
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
  const [aboutOpen, setAboutOpen] = useState(false);
  const toggle = (next: "blockers" | "active") => setTab((current) => (current === next ? null : next));
  // Blockers the user marked resolved after a double check stay hidden.
  const blockers = (s?.blockers ?? []).filter((b) => !stateOf(taskStates, blockerKey(b.id)).dismissed);
  const channelCount = activeChannels(project).length;

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
            <ExternalLink
              href={slackChannelUrl(project.channel_id, channelPermalinks(project))}
              className="slack-link"
              title={`Open #${project.name} in Slack${channelCount > 1 ? ` (${channelCount - 1} more channel${channelCount > 2 ? "s" : ""} in About)` : ""}`}
            >
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

          {/* title="" keeps the card's "Click to show…" tooltip off the tabs and their lists. */}
          <div className={`work-tabs${tab ? " has-open" : ""}`} role="tablist" title="">
              {blockers.length > 0 && (
                <button role="tab" aria-selected={tab === "blockers"} className={`work-tab${tab === "blockers" ? " open" : ""}`} onClick={() => toggle("blockers")}>
                  Blocking {blockers.length}
                  {blockers.some((b) => b.owners.some((o) => o.is_me)) && <MineDot />}
                  {tab === "blockers" && <TabClose />}
                </button>
              )}
              {(s.active?.length ?? 0) > 0 && (
                <button role="tab" aria-selected={tab === "active"} className={`work-tab${tab === "active" ? " open" : ""}`} onClick={() => toggle("active")}>
                  Active {s.active.length}
                  {s.active.some((a) => a.owners.some((o) => o.is_me)) && <MineDot />}
                  {tab === "active" && <TabClose />}
                </button>
              )}
              <button className="work-tab about-tab" onClick={() => setAboutOpen(true)}>
                About
                {channelCount > 1 && <span className="muted"> · {channelCount} channels</span>}
              </button>
            </div>

          {tab === "blockers" && blockers.length > 0 && (
            <ul className="work-items tab-panel" role="tabpanel" title="">
              {blockers.map((b) => (
                <WorkItem
                  key={b.id}
                  item={b}
                  kind="blocker"
                  remind={{ channelId: project.channel_id, reminder: reminders[b.id], onSent: onChange }}
                  check={{
                    result: blockerChecks[b.id],
                    onCheck: () => checkBlocker(projectName(project), project.channel_id, b, reminders[b.id]).then(onChange, () => {}),
                    onResolve: async () => {
                      await setTaskState(blockerKey(b.id), { dismissed: true });
                      // Your own blockers are also tasks on your list (same id); finishing one finishes both.
                      if (b.owners.some((o) => o.is_me)) await setTaskState(b.id, { status: "done" });
                      onChange();
                    },
                  }}
                />
              ))}
            </ul>
          )}

          {aboutOpen && <ProfileModal project={project} onClose={() => setAboutOpen(false)} />}

          {tab === "active" && s.active?.length > 0 && (
            <ul className="work-items tab-panel" role="tabpanel" title="">
              {s.active.map((a) => (
                <WorkItem
                  key={a.id}
                  item={a}
                  kind="active"
                  remind={{ channelId: project.channel_id, reminder: reminders[a.id], onSent: onChange }}
                />
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
