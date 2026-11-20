import { formatWhen } from "../scheduler";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { logFeedback, saveFocus, setProjectPriority, type Project } from "../db";
import { refreshProject } from "../jobs";
import type { ProjectPriority, ProjectStatus, Raci } from "../schema";
import type { TaskState } from "../tasks";
import { linkKind } from "../links";
import { LinkChips } from "./LinkChips";
import { channelLabel, dedupeStatements, pathToShip, projectContext, projectKind, projectName, projectPriority, projectStatus, readChannels, slackChannelUrl } from "../projects";
import { Requirements } from "./ProjectRequirements";
import { CardDue, PathToShip, StatusBox, WorkstreamWork } from "./ProjectRecord";
import { People } from "./People";
import { useJobStatus } from "../useAppData";
import { CloseIcon, ExternalLink, RefreshButton, UnreadDot, updatedText } from "./common";
import { usePointerFocus } from "./TaskCard";
import { label, recordCorrection } from "../feedback";

const STATUS_LABEL: Record<ProjectStatus, string> = {
  blocked: "Blocked",
  at_risk: "At risk",
  on_track: "On track",
  idle: "Idle",
};


/** A milestone's health, as its badge says it; planned ones have none. */
const MILESTONE_LABEL: Record<"done" | "planned" | "at_risk" | "missed", string> = {
  done: "Done",
  planned: "Planned",
  at_risk: "At risk",
  missed: "Missed",
};

const RACI_LABEL: Record<Raci, string> = {
  responsible: "Responsible",
  accountable: "Accountable",
  consulted: "Consulted",
  informed: "Informed",
};

/** Message links from the project's snapshot, which carry its Slack workspace's domain. */
function channelPermalinks(project: Project): (string | null | undefined)[] {
  const s = project.snapshot;
  if (!s) return [];
  return [...s.blockers.map((b) => b.link), ...(s.active ?? []).map((a) => a.link), ...s.my_tasks.map((t) => t.link), ...(s.recent_updates ?? []).map((u) => u.link)];
}

/**
 * What's known about the project, built up by its refreshes: goal, channels, people, milestones,
 * links, decisions. A centered modal, portaled to <body>.
 */
/**
 * One context entry: click the text to reword it, × to remove it. Rewording or removing one of
 * Demian's makes the change yours, and refreshes keep to it.
 */
function ContextEntry({ entry, onSave, onRemove }: { entry: { text: string; by: "you" | "demian" }; onSave: (text: string) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(!entry.text);
  const [text, setText] = useState(entry.text);
  const save = () => {
    setEditing(false);
    const next = text.trim();
    if (!next) return onRemove();
    if (next !== entry.text) onSave(next);
  };
  return (
    <li className="small">
      <span className="lesson">
        <span className="lesson-scope">{entry.by === "you" ? "You" : "Demian"}</span>
        {editing ? (
          <input
            className="lesson-edit"
            value={text}
            autoFocus
            placeholder="Something true about this project"
            onChange={(e) => setText(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") {
                setText(entry.text);
                setEditing(false);
                if (!entry.text) onRemove();
              }
            }}
          />
        ) : (
          <span className="lesson-text" onClick={() => setEditing(true)} title="Click to reword">
            {entry.text}
          </span>
        )}
      </span>
      <button className="icon-button" aria-label="Remove this" title="Remove this" onClick={onRemove}>
        <CloseIcon />
      </button>
    </li>
  );
}

/** "Project context": how Demian reads the project (its focus, what isn't part of it), to read and correct. */
function UnderstandingModal({ project, onClose, onChange }: { project: Project; onClose: () => void; onChange: () => void }) {
  const entries = projectContext(project);
  const [adding, setAdding] = useState(false);
  const mine = project.focus?.context ?? [];
  const removed = project.focus?.removed ?? [];
  // Every change is recorded as a correction, so it's also learned from.
  const record = (before: string | null, after: string | null) =>
    logFeedback({
      kind: "project_focus",
      subject: "project",
      subject_id: project.channel_id,
      project_id: project.channel_id,
      before: { context: before, project: projectName(project) },
      after: { context: after },
    }).catch(() => {});
  /** Rewords (text) or removes (null) an entry. Changing one of Demian's makes the result yours. */
  const change = async (entry: { text: string; by: "you" | "demian" }, text: string | null) => {
    const ownIndex = entry.by === "you" ? mine.indexOf(entry.text) : -1;
    const nextMine = entry.by === "you" ? mine.flatMap((t, i) => (i === ownIndex ? (text ? [text] : []) : [t])) : text ? [...mine, text] : mine;
    const nextRemoved = entry.by === "demian" ? [...removed, entry.text] : removed;
    await saveFocus(project.channel_id, { context: nextMine, removed: nextRemoved });
    record(entry.text, text);
    onChange();
  };
  const add = async (text: string) => {
    setAdding(false);
    await saveFocus(project.channel_id, { context: [...mine, text] });
    record(null, text);
    onChange();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="modal-backdrop plan-modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="modal plan-modal understanding-modal" role="dialog" aria-label={`Project context for ${projectName(project)}`} onClick={(e) => e.stopPropagation()}>
        <header className="column-header">
          <h2>
            Project context <span className="understanding-project">{projectName(project)}</span>
          </h2>
          <button className="icon-button" title="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <p className="small muted understanding-intro">
          Demian writes this from the project's channels and keeps it current. Click an entry to reword it, remove what's wrong, or add your own; every refresh works from what's here.
        </p>
        <ul className="notes-list context-list">
          {entries.map((entry, i) => (
            <ContextEntry
              key={`${entry.by}:${entry.text}:${i}`}
              entry={entry}
              onSave={(text) => change(entry, text)}
              onRemove={() => change(entry, null)}
            />
          ))}
          {adding && <ContextEntry key="new" entry={{ text: "", by: "you" }} onSave={(text) => add(text)} onRemove={() => setAdding(false)} />}
        </ul>
        {!adding && (
          <button className="link-button small more-link context-add" onClick={() => setAdding(true)}>
            Add context
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Milestones, latest date first; ones without a date (or one that isn't a real date, like "Q4") last. */
function byDateNewestFirst<T extends { date?: string | null }>(items: T[]): T[] {
  const time = (d?: string | null) => {
    const t = d ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d).getTime() : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...items].sort((a, b) => time(b.date) - time(a.date));
}

/**
 * A project's details: what it's for, its context, channels, people, milestones, links, decisions and
 * what's being tracked. Shown in a window from the project card, or inline in the Detail view's
 * Projects area.
 */
/** A field of the details that folds: its label (with how many it holds) opens it, closing the one open before. */
function FoldField({ label, count, open, onToggle, children }: { label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <dt>
        <button className="fold-label" aria-expanded={open} onClick={onToggle}>
          {label}
          <span className="timestamp">{count}</span>
          <svg className="fold-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M3.5 2 6.5 5l-3 3" />
          </svg>
        </button>
      </dt>
      {open && <dd>{children}</dd>}
    </>
  );
}

export function ProjectDetail({ project, onChange, taskStates }: { project: Project; onChange: () => void; taskStates?: Map<string, TaskState> }) {
  const p = project.profile;
  const [contextOpen, setContextOpen] = useState(false);
  // The one folding field that's open (Channels, Also called, Milestones, Links, Decisions), if any;
  // none for another project. Everything above them always shows.
  const [field, setField] = useState<string | null>(null);
  useEffect(() => setField(null), [project.channel_id]);
  const toggleField = (name: string) => setField((open) => (open === name ? null : name));
  // Its context changes with each refresh (Demian's entries) and with your edits; the later one.
  const contextAt = [project.last_refreshed_at, project.focus?.updated_at].filter((t): t is string => !!t).sort().at(-1);
  // Its own channels, then ones it shares with other projects.
  const channels = readChannels(project);
  const permalinks = channelPermalinks(project);
  const isWorkstream = projectKind(project) === "workstream";
  return (
    <>
      {/* The record: what it's for, how it gets to shipping, who's involved. */}
      {/* Its requirements doc first (a workstream is ongoing, with nothing to ship: it has none), then
          who's involved and its purpose, all untitled: the start of the record. */}
      {!isWorkstream && (
        <section className="record-section" aria-label="Requirements">
          <Requirements project={project} onChange={onChange} inPlan={!!pathToShip(project)?.steps.length} />
        </section>
      )}
      <People project={project} />
      <section className="record-section" aria-label="Purpose">
        {(p?.goal || project.snapshot?.description) ? (
          <p className="profile-goal">{p?.goal || project.snapshot?.description}</p>
        ) : (
          <p className="muted small">The next refresh says what this project is for.</p>
        )}
      </section>
      <StatusBox project={project} />
      {isWorkstream ? <WorkstreamWork project={project} onChange={onChange} /> : <PathToShip project={project} onChange={onChange} taskStates={taskStates} />}
      <dl>
        {/* These fold, closed at first, one open at a time; everything above them always shows. */}
        {channels.length > 0 && (
          <FoldField label="Channels" count={channels.length} open={field === "channels"} onToggle={() => toggleField("channels")}>
            <LinkChips
              links={channels.map((c) => ({ url: slackChannelUrl(c.channel_id, permalinks), title: `${channelLabel(c)}${c.shared ? " (shared)" : ""}`, kind: "slack" as const }))}
            />
          </FoldField>
        )}
        {!!p?.aliases.length && (
          <FoldField label="Also called" count={p.aliases.length} open={field === "aliases"} onToggle={() => toggleField("aliases")}>
            {p.aliases.join(", ")}
          </FoldField>
        )}
        {!!p?.milestones.length && (
          <FoldField label="Milestones" count={dedupeStatements(p.milestones).length} open={field === "milestones"} onToggle={() => toggleField("milestones")}>
            <ul className="profile-list">
              {byDateNewestFirst(dedupeStatements(p.milestones)).map((m) => (
                // One line each: the date, then the milestone cut short with an ellipsis so its health
                // badge always fits after it; the whole milestone shows on hover.
                <li key={m.what} className={`milestone ${m.status}`} title={`${m.date ? formatWhen(m.date) : "No date"} · ${m.what}${m.status !== "planned" ? ` · ${MILESTONE_LABEL[m.status]}` : ""}`}>
                  <span className="muted milestone-date">{m.date ? formatWhen(m.date) : "No date"}</span>
                  <span className="milestone-what">{m.what}</span>
                  {m.status !== "planned" && <span className={`badge milestone-health ${m.status}`}>{MILESTONE_LABEL[m.status]}</span>}
                </li>
              ))}
            </ul>
          </FoldField>
        )}
        {!!p?.resources.length && (
          <FoldField label="Links" count={p.resources.length} open={field === "links"} onToggle={() => toggleField("links")}>
            <LinkChips links={p.resources.map((r) => ({ url: r.link, title: r.title, kind: linkKind(r.link) }))} />
          </FoldField>
        )}
        {!!p?.decisions.length && (
          <FoldField label="Decisions" count={Math.min(4, dedupeStatements(p.decisions).length)} open={field === "decisions"} onToggle={() => toggleField("decisions")}>
            <ul className="profile-list">
              {byDateNewestFirst(dedupeStatements(p.decisions)).slice(0, 4).map((d) => (
                // Like the milestones: the date, then the decision on one line, whole on hover.
                <li key={d.what} className="milestone" title={`${d.date ? formatWhen(d.date) : "No date"} · ${d.what}`}>
                  <span className="muted milestone-date">{d.date ? formatWhen(d.date) : "No date"}</span>
                  {d.link ? (
                    <ExternalLink href={d.link} className="milestone-what">
                      {d.what}
                    </ExternalLink>
                  ) : (
                    <span className="milestone-what">{d.what}</span>
                  )}
                </li>
              ))}
            </ul>
          </FoldField>
        )}
        </dl>
        {!p && <p className="muted small">The next refresh builds the project's profile.</p>}
        {/* Last: how Demian understands the project, to read and correct. */}
        <div className="understanding-row detail-foot">
          <button className="link-button small more-link understanding-link" onClick={() => setContextOpen(true)}>
            Project context
          </button>
          <span className="timestamp">
            How Demian understands this project.{contextAt && ` Updated ${updatedText(contextAt)}`}
          </span>
        </div>
        {contextOpen && <UnderstandingModal project={project} onClose={() => setContextOpen(false)} onChange={onChange} />}
    </>
  );
}

/**
 * A project in the list, on one line: its name, then its due date and status; its priority and your
 * part in it open before the name on hover, and the priority can be changed there. Its blockers,
 * active work, requirements and refresh live in its details beside the list.
 */
export function ProjectCard({
  project,
  busy,
  selected,
  onSelect,
  onChange,
  unread = false,
}: {
  project: Project;
  busy: boolean;
  /** Whether its details are the ones open beside the list. */
  selected: boolean;
  onSelect: () => void;
  onChange: () => void;
  /** Demian found something new about it since you last opened it: a green dot after its name. */
  unread?: boolean;
}) {
  const s = project.snapshot;
  const status = projectStatus(project);

  return (
    <article
      className={`card project ${status ?? "unknown"}${selected ? " selected" : ""}`}
      onClick={(e) => {
        // Links, buttons and inputs keep their own behavior.
        if (!(e.target as HTMLElement).closest("a, button, input, textarea, select")) onSelect();
      }}
    >
      <header className="card-header">
        {(s || project.priority_choice) && (
          <div className="project-badges-reveal">
            <div className="row project-badges">
              <PriorityBadge project={project} onChange={onChange} />
              {s?.raci && (
                <span className={`badge raci ${s.raci.role}`} title={`${RACI_LABEL[s.raci.role]}: ${s.raci.reason}`}>
                  {s.raci.role[0].toUpperCase()}
                </span>
              )}
            </div>
          </div>
        )}
        <h3 className="project-title">
          <span className="project-name">{projectName(project)}</span>
          {unread && <UnreadDot />}
        </h3>
        <div className="row project-header-right">
          <CardDue project={project} />
          {status && <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>}
        </div>
      </header>

      {project.last_error && <p className="error small">Last refresh failed: {project.last_error}</p>}
      {!s && !project.last_error && <p className="muted small">{busy ? "Reading its channels and epics…" : "Not refreshed yet."}</p>}
    </article>
  );
}

const PRIORITY_LEVELS: ProjectPriority[] = ["P0", "P1", "P2", "P3", "P4"];
const AUTO = "__auto";

/**
 * A project's priority on its card: click it to pick another, or Automatic to go back to the one
 * refreshes read. One you set has a thin outline, as on a task, and stays until you pick Automatic.
 */
function PriorityBadge({ project, onChange }: { project: Project; onChange: () => void }) {
  const focus = usePointerFocus();
  const priority = projectPriority(project);
  const read = project.snapshot?.priority ?? null;
  const name = projectName(project);
  return (
    <span
      className={`p-badge menu-badge ${priority?.level ?? "unset"}${priority?.byYou ? " manual" : ""}${focus.pointer ? " pointer-focus" : ""}`}
      title={priority?.byYou ? "You set this priority." : (priority?.reason ?? undefined)}
    >
      {priority?.level ?? "Priority"}
      <select
        value={project.priority_choice?.level ?? AUTO}
        aria-label={`Priority of ${name}`}
        {...focus.props}
        onChange={async (e) => {
          const to = e.target.value === AUTO ? null : (e.target.value as ProjectPriority);
          await setProjectPriority(project.channel_id, to);
          onChange();
          recordCorrection(
            {
              kind: "priority_change",
              subject: "project",
              subject_id: project.channel_id,
              project_id: project.channel_id,
              before: { name, priority: priority?.level ?? null, set_by: priority?.byYou ? "user" : "demian" },
              after: { priority: to ?? read?.level ?? null, set_by: to ? "user" : "demian" },
            },
            label.priority(name, to ?? "automatic"),
          );
        }}
      >
        {PRIORITY_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
        <option disabled>──────</option>
        <option value={AUTO}>Automatic{read ? ` (${read.level})` : ""}</option>
      </select>
    </span>
  );
}

/**
 * A project's refresh, in its details' header beside what kind it is: shown while the pointer is over
 * the details, and with its spinner while one runs. Hovering it shows when it was last refreshed.
 */
export function ProjectRefresh({ project, busy }: { project: Project; busy: boolean }) {
  const status = useJobStatus(`project:${project.channel_id}`);
  const at = project.last_refreshed_at;
  return (
    <RefreshButton
      busy={busy}
      status={status}
      title={`Refresh ${projectName(project)}`}
      tip={at ? `Updated ${updatedText(at)}` : "Not refreshed yet"}
      onClick={() => refreshProject(project.channel_id).catch(() => {})}
    />
  );
}
