import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { setProjectKind, type Project } from "../db";
import { draftProjectTdd, linkProjectDoc, readRequirements, tddDraftError } from "../jobs";
import { useChatDock } from "./chatDock";
import { TddChat, tddChatOwner } from "./TddChat";
import { linkKind } from "../links";
import { bySection, docKindLabel, guideTitle, projectKind, requirementCounts, requirementRows, type RequirementRow } from "../projects";
import type { ProjectKind, RequirementStatus } from "../schema";
import { useJobStatus, useRunningJobs } from "../useAppData";
import { LinkChips } from "./LinkChips";
import { RefreshButton, Spinner, updatedText } from "./common";

export const STATUS_LABEL: Record<RequirementStatus | "pending", string> = {
  done: "Done",
  in_progress: "In progress",
  at_risk: "At risk",
  not_started: "Not started",
  descoped: "Descoped",
  unclear: "Unclear",
  pending: "Not checked",
};

/** The order statuses show in, in the summary and its bar: done first, then what's moving, then the rest. */
const ORDER: (RequirementStatus | "pending")[] = ["done", "in_progress", "at_risk", "not_started", "unclear", "descoped", "pending"];

/** A name for a doc linked by its address alone, until it's read: "Google Doc", "Confluence page". */
function linkedTitle(url: string): string {
  const kind = linkKind(url);
  if (kind === "docs") return "Google Doc";
  if (kind === "drive") return "Google Drive file";
  if (kind === "confluence") return "Confluence page";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Requirements doc";
  }
}

const KIND_LABEL: Record<ProjectKind, string> = { project: "Project", workstream: "Workstream" };

/**
 * Project or workstream, as a badge at the top right of the project's details. Clicking it opens a
 * small menu to choose.
 */
export function KindBadge({ project, onChange }: { project: Project; onChange: () => void }) {
  const kind = projectKind(project);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const set = async (next: ProjectKind) => {
    setOpen(false);
    await setProjectKind(project.channel_id, next);
    onChange();
  };
  return (
    <div className="multi-filter kind-badge-wrap" ref={ref}>
      <button
        className={`badge kind-badge ${kind ?? "unknown"}${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${kind ? KIND_LABEL[kind] : "Not decided yet"}: change whether it's a project or a workstream`}
        onClick={() => setOpen(!open)}
      >
        {kind ? KIND_LABEL[kind] : "Project or workstream?"}
      </button>
      {open && (
        <div className="multi-filter-menu kind-menu" role="listbox" aria-label="Project or workstream">
          {(["project", "workstream"] as const).map((k) => (
            <button key={k} role="option" aria-selected={kind === k} className={`multi-filter-option${kind === k ? " on" : ""}`} onClick={() => set(k)}>
              <span className="multi-filter-check round" aria-hidden>
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M2.2 5.2 4.2 7.2 7.8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="kind-option">
                {KIND_LABEL[k]}
                <span className="muted small">{k === "project" ? "Has an end" : "Ongoing"}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Linking a project's guiding doc, the Requirements section's line while it has none: a field to paste
 * its link, or Draft a TDD to have Demian write one with you. Demian doesn't pick one itself.
 */
export function DocLinker({
  project,
  onChange,
  missing = true,
  startEditing = false,
}: {
  project: Project;
  onChange: () => void;
  /** Say it's missing: a project's (a workstream's is optional). */
  missing?: boolean;
  /** Open with the field showing (changing a linked doc). */
  startEditing?: boolean;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const url = link.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return setError("Paste the doc's link, starting with https://");
    setEditing(false);
    setLink("");
    setError(null);
    await linkProjectDoc(project.channel_id, { link: url, title: linkedTitle(url), kind: null });
    onChange();
  };
  return (
    <div className={`doc-linker${missing ? " missing" : ""}`}>
      {missing && (
        <span className="doc-missing-chip">
          <WarningIcon />
          No requirements doc
        </span>
      )}
      {editing ? (
        <form
          className="doc-link-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            className="lesson-edit"
            autoFocus
            value={link}
            placeholder="Paste the TDD or PRD link"
            aria-label="Requirements doc link"
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditing(false);
                setError(null);
              }
            }}
          />
          <button type="submit" className="cta-primary">
            Save
          </button>
          <button
            type="button"
            className="cta-ghost"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </button>
          {error && <span className="error small">{error}</span>}
        </form>
      ) : (
        <>
          <button className="link-button small" onClick={() => setEditing(true)}>
            Link a doc
          </button>
          <TddDraftAction project={project} onChange={onChange} />
        </>
      )}
    </div>
  );
}

/** A triangle with an exclamation mark, the size of a link chip's icon: something's missing. */
function WarningIcon() {
  return (
    <svg className="doc-missing-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M7 1.9 12.7 11.8H1.3Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M7 5.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="7" cy="10.1" r="0.8" fill="currentColor" />
    </svg>
  );
}

/**
 * Beside Link a doc: have Demian draft a TDD from what's known about the project, then work on it
 * with Demian in its chat, which takes the place of the project's details (see TddChat), and create it
 * in Google Drive, where it becomes the project's requirements doc. Elsewhere it opens as a window.
 */
function TddDraftAction({ project, onChange }: { project: Project; onChange: () => void }) {
  const id = project.channel_id;
  const drafting = useRunningJobs().includes(`tdd:${id}`);
  const status = useJobStatus(`tdd:${id}`);
  const error = useJobStatus(tddDraftError(id));
  const dock = useChatDock();
  const owner = tddChatOwner(id);
  const [windowOpen, setWindowOpen] = useState(false);
  const open = () => (dock ? dock.open(owner) : setWindowOpen(true));
  const start = () => {
    open();
    draftProjectTdd(id).then(onChange, onChange);
  };
  return (
    <>
      {drafting ? (
        <button className="link-button small tdd-drafting" onClick={open} title="Open the draft's chat">
          <Spinner /> {status && status !== "Working" ? status : "Drafting a TDD"}
        </button>
      ) : project.doc_draft ? (
        <button className="link-button small tdd-review" onClick={open}>
          Review the TDD draft
        </button>
      ) : (
        <button className="link-button small" title="Demian drafts a TDD from the project's tickets, channels and meetings, then works on it with you" onClick={start}>
          Draft a TDD
        </button>
      )}
      {error && !drafting && !project.doc_draft && <span className="error small">Couldn't draft it: {error}</span>}
      {!dock && windowOpen && <TddChat project={project} onClose={() => setWindowOpen(false)} onChange={onChange} />}
    </>
  );
}

function RequirementItem({ row }: { row: RequirementRow }) {
  const [open, setOpen] = useState(false);
  const { requirement: r, progress } = row;
  const status = progress?.status ?? "pending";
  return (
    <li className={`requirement ${status}`}>
      <button className="requirement-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`badge requirement-status ${status}`}>{STATUS_LABEL[status]}</span>
        <span className="requirement-text">{r.text}</span>
        {r.priority === "must" && (
          <span className="badge requirement-must" title="The doc marks this as a must">
            Must
          </span>
        )}
      </button>
      {open && <RequirementDetail row={row} />}
    </li>
  );
}

/** How far along a requirement is: what's done and left, the links that show it, and when it was checked. */
export function RequirementDetail({ row }: { row: RequirementRow }) {
  const { progress } = row;
  return (
    <div className="requirement-detail small">
      {progress ? (
        <>
          {progress.note && <p>{progress.note}</p>}
          {!!progress.evidence.length && <LinkChips links={progress.evidence.map((e) => ({ url: e.link, title: e.title, kind: linkKind(e.link) }))} />}
          <span className="timestamp">Checked {updatedText(progress.at)}</span>
        </>
      ) : (
        <span className="muted">Checked on the next refresh.</span>
      )}
    </div>
  );
}

/**
 * Where the project stands, for its Status box: the `lead` sentence (the latest refresh's read), then
 * "6 of 14 requirements done" once its doc is read. Null when there's neither.
 */
export function StatusText({ project, lead }: { project: Project; lead?: string | null }) {
  const rows = requirementRows(project);
  const counts = rows.length ? requirementCounts(rows) : null;
  if (!lead && !counts) return null;
  return (
    <p className="status-text">
      {lead && <>{lead} </>}
      {counts && (
        <strong>
          {counts.done} of {counts.total} requirements done
        </strong>
      )}
    </p>
  );
}

/** How far along a project's requirements are, as a bar split by status, right above its plan in Work. */
export function RequirementsBar({ project }: { project: Project }) {
  const rows = requirementRows(project);
  return rows.length ? <ProgressBar counts={requirementCounts(rows)} /> : null;
}

/** "6 of 14 done" and a bar split by status, for the requirements list. */
function Summary({ rows }: { rows: RequirementRow[] }) {
  const counts = requirementCounts(rows);
  return (
    <div className="requirements-summary">
      <div className="small">
        <strong>
          {counts.done} of {counts.total} done
        </strong>
      </div>
      <ProgressBar counts={counts} />
    </div>
  );
}

/** A bar split by status; hovering a part shows its count in a card (the webview shows no native tooltips). */
function ProgressBar({ counts }: { counts: ReturnType<typeof requirementCounts> }) {
  const [tip, setTip] = useState<{ text: string; at: DOMRect } | null>(null);
  const parts = ORDER.filter((s) => counts[s] > 0);
  return (
    <>
      <div
        className="requirements-bar-hit"
        onMouseMove={(e) => {
          // The part under the pointer, by where it is across the bar.
          const part = [...(e.currentTarget.firstElementChild?.children ?? [])].find((el) => {
            const r = el.getBoundingClientRect();
            return e.clientX >= r.left - 1 && e.clientX <= r.right + 1;
          }) as HTMLElement | undefined;
          const s = part?.dataset.status as keyof typeof STATUS_LABEL | undefined;
          setTip(part && s ? { text: `${STATUS_LABEL[s]}: ${counts[s]}`, at: part.getBoundingClientRect() } : null);
        }}
        onMouseLeave={() => setTip(null)}
      >
        <div
          className="requirements-bar"
          role="img"
          aria-label={`${counts.done} of ${counts.total} requirements done${parts.filter((s) => s !== "done").map((s) => `, ${counts[s]} ${STATUS_LABEL[s].toLowerCase()}`).join("")}`}
        >
          {parts.map((s) => (
            <span key={s} data-status={s} className={`requirements-bar-part ${s}`} style={{ flexGrow: counts[s] }} />
          ))}
        </div>
      </div>
      {tip &&
        createPortal(
          <div className="card meeting-card hover-tip small" role="tooltip" style={{ left: tip.at.left + tip.at.width / 2, top: tip.at.bottom + 6, transform: "translateX(-50%)" }}>
            {tip.text}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * A project's guiding doc and its requirements, each with how far along it is, grouped by the doc's
 * sections. Read again on demand; progress comes from the project's refreshes. `inPlan`: the plan in
 * Work shows each requirement under the epic or story that delivers it, with the bar above it and the
 * count in Status, so neither is here too.
 */
export function Requirements({ project, onChange, inPlan = false }: { project: Project; onChange: () => void; inPlan?: boolean }) {
  const doc = project.docs?.doc;
  const reading = useJobStatus(`requirements:${project.channel_id}`);
  const [changing, setChanging] = useState(false);
  const isProject = projectKind(project) === "project";
  if (!doc || changing)
    return (
      <div className="requirements">
        <DocLinker
          project={project}
          onChange={() => {
            setChanging(false);
            onChange();
          }}
          missing={!doc && isProject}
          startEditing={changing}
        />
        {changing && (
          <button className="link-button small muted" onClick={() => setChanging(false)}>
            Keep {guideTitle(project)}
          </button>
        )}
      </div>
    );
  const stored = project.requirements?.link === doc.link ? project.requirements : null;
  const rows = requirementRows(project);
  const kind = docKindLabel(stored?.kind ?? doc.kind);
  return (
    <div className="requirements">
      <div className="requirements-doc">
        <LinkChips links={[{ url: doc.link, title: guideTitle(project) ?? doc.title, kind: linkKind(doc.link) }]} />
        {kind && <span className="badge doc-kind">{kind}</span>}
        <RefreshButton busy={!!reading} status={reading} title="Read the doc again" onClick={() => readRequirements(project.channel_id).catch(() => {})} />
        <span className="requirements-doc-actions">
          <button className="link-button small" onClick={() => setChanging(true)}>
            Change
          </button>
          <button
            className="link-button small muted"
            onClick={async () => {
              await linkProjectDoc(project.channel_id, null);
              onChange();
            }}
          >
            Remove
          </button>
        </span>
      </div>
      {stored?.unreadable ? (
        <p className="error small">Demian can't read this doc: {stored.unreadable}</p>
      ) : stored?.error && !rows.length ? (
        <p className="error small">Reading it failed: {stored.error}</p>
      ) : !stored || (!stored.readAt && !rows.length) ? (
        <p className="muted small">{reading ? <>Reading its requirements <Spinner /></> : "Its requirements are read on the next refresh."}</p>
      ) : !rows.length ? (
        <p className="muted small">No requirements found in this doc.</p>
      ) : (
        <>
          {!inPlan && <Summary rows={rows} />}
          {!inPlan && bySection(rows).map((group) => (
            <div key={group.section ?? ""} className="requirements-group">
              {group.section && <h4 className="requirements-section">{group.section}</h4>}
              <ul className="profile-list requirements-list">
                {group.rows.map((row) => (
                  <RequirementItem key={row.requirement.id} row={row} />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
