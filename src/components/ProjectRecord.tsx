import { Fragment, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { linkEpic, setShipChoice, unlinkEpic, type Project } from "../db";
import { runCli } from "../cli";
import { githubReposOf } from "../code";
import { keysIn } from "../plan";
import { refreshProject } from "../jobs";
import { activeEpics, epicKeyFrom, epicUrl, pathToShip, projectKind, projectName, requirementRows, shipTarget } from "../projects";
import { formatWhen } from "../scheduler";
import { CloseIcon, ExternalLink, HoverTip, Segmented } from "./common";
import { CodeLine, PlanView, useTrackedCode, useTracking } from "./PlanView";
import { RequirementsBar, StatusText } from "./ProjectRequirements";
import { CardBox } from "./TaskCard";
import { DependencyView, type PlanTask } from "./WorkMap";
import type { PathStep, ProjectEpic } from "../schema";
import { sinceWhen, stateOf, type TaskState, type TaskStatus } from "../tasks";

/**
 * A project's due date on its card in the list: "Due Dec 12" just before its status, as plain gray
 * text like the date in its details. None for a workstream, or while nothing names a date.
 */
export function CardDue({ project }: { project: Project }) {
  if (projectKind(project) === "workstream") return null;
  const ship = shipTarget(project);
  if (!ship?.date) return null;
  return <span className="due timestamp card-due">Due {formatWhen(ship.date)}</span>;
}

/**
 * A project's due date (when it ships) in its details' header, the way a task shows its own: click it
 * to pick another, and × hands the date back to what refreshes read. None for a workstream, which has
 * no end.
 */
export function ProjectDue({ project, onChange }: { project: Project; onChange: () => void }) {
  if (projectKind(project) === "workstream") return null;
  const ship = shipTarget(project);
  const set = async (date: string | null) => {
    await setShipChoice(project.channel_id, date);
    onChange();
  };
  return (
    <span className="due-date project-due">
      <span className="due-pick">
        <span className="due timestamp">{ship?.date ? `Due ${formatWhen(ship.date)}` : "Add due date"}</span>
        <input
          type="date"
          aria-label="Due date"
          value={ship?.date ?? ""}
          onClick={(e) => {
            try {
              e.currentTarget.showPicker();
            } catch {
              // Already open, or the picker isn't available: the field still takes typing.
            }
          }}
          onChange={(e) => set(e.target.value || null)}
        />
      </span>
      {project.ship_choice && (
        <button className="due-clear" aria-label="Use the date refreshes read instead" onClick={() => set(null)}>
          <CloseIcon />
        </button>
      )}
    </span>
  );
}

/**
 * How the project gets from where it is now to shipping: the ship date, where it stands, and its work,
 * as a plan of initiatives, epics and their stories and tasks (see PlanView). Full screen can also show
 * the same work by the order it has to happen in (see DependencyView).
 */
export function PathToShip({ project, onChange, taskStates }: { project: Project; onChange: () => void; taskStates?: Map<string, TaskState> }) {
  const path = pathToShip(project);
  const tasks = useMemo(() => openTasks(project, taskStates), [project, taskStates]);
  // The view full screen shows; the details always show the plan.
  const [view, setView] = useState<WorkView>("plan");
  const [full, setFull] = useState(false);
  return (
    <section className="record-section">
      <div className="record-heading-row">
        <h4 className="record-heading">Work</h4>
        <span className="path-tools">
          {path && (
            <button className="icon-button path-full-button" aria-label="Show work full screen" onClick={() => setFull(true)}>
              <FullScreenIcon />
            </button>
          )}
        </span>
      </div>
      <PathBody project={project} view="plan" tasks={tasks} />
      <CodeNote project={project} />
      {full && <PathFullScreen project={project} view={view} tasks={tasks} onView={setView} onChange={onChange} onClose={() => setFull(false)} />}
    </section>
  );
}

/** How a task's state shows on a block of the dependencies view. */
const TASK_STATUS: Record<TaskStatus, PathStep["status"]> = { todo: "next", in_progress: "in_progress", waiting: "blocked", blocked: "blocked", done: "done" };

/** The user's own open tasks on the project (the ones in the Tasks column), for the dependencies view. */
function openTasks(project: Project, states: Map<string, TaskState> | undefined): PlanTask[] {
  return (project.snapshot?.my_tasks ?? []).flatMap((t) => {
    const state = states ? stateOf(states, t.id) : null;
    if (state && (state.done || state.dismissed)) return [];
    return [{ id: t.id, title: t.title, status: TASK_STATUS[state?.status ?? "todo"], moves: t.moves ?? [], due: t.due ?? null }];
  });
}

/** The two ways to see the work: as a plan, or by the order it has to happen in. */
type WorkView = "plan" | "dependencies";

function ViewSwitch({ view, onChange }: { view: WorkView; onChange: (v: WorkView) => void }) {
  return (
    <Segmented
      label="How to show the work"
      value={view}
      options={[
        { value: "plan", label: "Plan" },
        { value: "dependencies", label: "Dependencies" },
      ]}
      onChange={onChange}
    />
  );
}

/** Four corners pointing out: show it full screen. */
function FullScreenIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M1.5 4.5v-3h3M7.5 1.5h3v3M10.5 7.5v3h-3M4.5 10.5h-3v-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Where it stands, and the work in the chosen view. */
/**
 * Where the project stands, under its purpose: the latest refresh's read and how far along its
 * requirements are, in a dotted box like a task's plan, when it was last read on hover. None until
 * there's either.
 */
export function StatusBox({ project }: { project: Project }) {
  const lead = pathToShip(project)?.now;
  if (!lead && !requirementRows(project).length) return null;
  const when = sinceWhen(project.last_refreshed_at);
  return (
    <CardBox heading="Status" alwaysOpen note={when ? <span className="automation-role timestamp hover-stamp">Updated {when}</span> : undefined}>
      <StatusText project={project} lead={lead} />
    </CardBox>
  );
}

function PathBody({ project, view, tasks, full = false }: { project: Project; view: WorkView; tasks: PlanTask[]; full?: boolean }) {
  const path = pathToShip(project);
  const ship = shipTarget(project);
  return (
    <>
      {!path ? (
        <p className="muted small">The next refresh lays out the work from here to shipping.</p>
      ) : (
        <>
          {path.steps.length > 0 && <RequirementsBar project={project} />}
          {path.steps.length > 0 && (view === "plan" ? <PlanView key={project.channel_id} project={project} path={path} shipDate={ship?.date} full={full} /> : <DependencyView path={path} tasks={tasks} projectId={project.channel_id} />)}
        </>
      )}
    </>
  );
}

/**
 * Path to ship over the open area's two columns, for room: the plan with its timeline at full width,
 * or the dependencies across both, switched in its header (the details show only the plan). It sits
 * inside the area's panel, so the calendar and the rail beside it stay in view. Escape or × closes it.
 */
function PathFullScreen({
  project,
  view,
  tasks,
  onView,
  onChange,
  onClose,
}: {
  project: Project;
  view: WorkView;
  tasks: PlanTask[];
  onView: (v: WorkView) => void;
  onChange: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not while a card over it (a change to review) is open: Escape closes that first.
      if (e.key === "Escape" && !document.querySelector(".plan-review")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // The area's panel; the whole window if it isn't there.
  const [panel] = useState(() => document.querySelector<HTMLElement>(".detail-panel") ?? document.body);
  return createPortal(
    <div className={`path-full ${view}`} role="dialog" aria-modal="true" aria-label={`Work for ${projectName(project)}`}>
      <header className="path-full-head">
        <div className="detail-title">
          <h2>
            Work <span className="understanding-project">{projectName(project)}</span>
          </h2>
          <ProjectDue project={project} onChange={onChange} />
        </div>
        <span className="path-tools">
          {!!pathToShip(project)?.steps.length && <ViewSwitch view={view} onChange={onView} />}
          <button className="icon-button" aria-label="Close full screen" onClick={onClose}>
            <CloseIcon />
          </button>
        </span>
      </header>
      <div className="path-full-body record-section">
        <PathBody project={project} view={view} tasks={tasks} full />
      </div>
    </div>,
    panel,
  );
}

/**
 * A workstream's Work: its epics, one per line, each with how far along its issues are and the pull
 * requests and branches for it.
 */
export function WorkstreamWork({ project, onChange }: { project: Project; onChange: () => void }) {
  return (
    <section className="record-section">
      <h4 className="record-heading">Work</h4>
      <EpicLinks project={project} onChange={onChange} />
      <CodeNote project={project} />
    </section>
  );
}

/**
 * Under Work when its pull requests and branches can't all show: GitHub isn't connected though the
 * project has repos, or a repo couldn't be read on the last refresh (and why). Whether GitHub is
 * connected is asked again after each refresh, so signing in clears the note.
 */
function CodeNote({ project }: { project: Project }) {
  const tracking = useTracking(project.channel_id);
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    runCli("gh", ["auth", "status"]).then(
      (out) => live && setConnected(out.code === 0),
      () => live && setConnected(false),
    );
    return () => {
      live = false;
    };
  }, [tracking?.checkedAt]);
  if (connected === false && [...project.local_repos, ...githubReposOf(project)].length)
    return (
      <p className="small muted">
        GitHub isn't connected, so pull requests and branches don't show under the work. Install the <ExternalLink href="https://cli.github.com">GitHub CLI</ExternalLink> and run{" "}
        <code>gh auth login</code>.
      </p>
    );
  if (connected && tracking?.errors.length) return <p className="small error">Couldn't read {tracking.errors.join("; ")}</p>;
  return null;
}

/** How far along an epic's issues are: a bar of done and not done, the counts on hover. */
function EpicBar({ epic }: { epic: ProjectEpic | undefined }) {
  // Not in the last refresh's read yet: the next one counts its issues.
  if (!epic) return <span className="timestamp small">Not counted yet</span>;
  if (!epic.total) return <span className="timestamp small">No issues yet</span>;
  const done = Math.min(epic.done, epic.total);
  const text = `${done} of ${epic.total} issues done`;
  return (
    <HoverTip text={text}>
      <span className="requirements-bar epic-bar" role="img" aria-label={text}>
        {done > 0 && <span className="requirements-bar-part done" style={{ flexGrow: done }} />}
        {epic.total > done && <span className="requirements-bar-part not_started" style={{ flexGrow: epic.total - done }} />}
      </span>
    </HoverTip>
  );
}

/**
 * A workstream's Jira epics, its plan of record, one per line: each links to Jira and can be unlinked
 * (refreshes then leave it alone), with a bar of how far along its issues are and the pull requests
 * and branches for it. Another can be linked by its key or link. Either starts a refresh.
 */
export function EpicLinks({ project, onChange }: { project: Project; onChange: () => void }) {
  const epics = activeEpics(project);
  const tracking = useTracking(project.channel_id);
  const tracked = useMemo(() => new Map<string, ProjectEpic>((tracking?.epics ?? []).map((e) => [e.key.trim().toUpperCase(), e])), [tracking]);
  // Its pull requests and branches, each under the epic it names, or one of the epic's issues (as the refresh read them). Ones naming neither aren't its work.
  const code = useTrackedCode(project.channel_id);
  const keysOf = (epicKey: string) => new Set([epicKey, ...(tracked.get(epicKey.trim().toUpperCase())?.issues ?? [])].map((k) => k.toUpperCase()));
  const epicOf = new Map(
    code.flatMap((c) => {
      const named = keysIn(`${c.title} ${c.detail ?? ""}`);
      const e = epics.find((x) => named.some((k) => keysOf(x.epic_key).has(k)));
      return e ? [[c.id, e.epic_key] as const] : [];
    }),
  );
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reread = () => refreshProject(project.channel_id).catch(() => {});
  const add = async () => {
    const key = epicKeyFrom(text);
    if (!key) return setError("Type an epic key like ABC-123, or paste its Jira link");
    setAdding(false);
    setText("");
    setError(null);
    await linkEpic(project.channel_id, { key }, "user");
    onChange();
    reread();
  };
  return (
    <div className="epic-links">
      {epics.map((e) => {
        const url = epicUrl(project, e.epic_key);
        const label = (
          <>
            <span className="epic-key">{e.epic_key}</span>
            {e.title && e.title !== e.epic_key && <span className="epic-title">{e.title}</span>}
          </>
        );
        return (
          <Fragment key={e.epic_key}>
            <span className="chip epic-chip" title={e.title}>
              {url ? (
                <ExternalLink href={url} className="epic-chip-link">
                  {label}
                </ExternalLink>
              ) : (
                label
              )}
              <button
                className="chip-remove"
                aria-label={`Unlink ${e.epic_key} from this project`}
                onClick={async () => {
                  await unlinkEpic(project.channel_id, e.epic_key);
                  onChange();
                  reread();
                }}
              >
                <CloseIcon size={7} />
              </button>
            </span>
            <EpicBar epic={tracked.get(e.epic_key.trim().toUpperCase())} />
            {code
              .filter((c) => epicOf.get(c.id) === e.epic_key)
              .map((c) => (
                <span key={c.id} className="epic-code">
                  <CodeLine code={c} />
                </span>
              ))}
          </Fragment>
        );
      })}
      {adding ? (
        <form
          className="doc-link-form"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            className="lesson-edit"
            autoFocus
            value={text}
            placeholder="Epic key or Jira link"
            aria-label="Epic to link"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setAdding(false);
                setError(null);
              }
            }}
          />
          <button type="submit" className="cta-primary">
            Link
          </button>
          <button
            type="button"
            className="cta-ghost"
            onClick={() => {
              setAdding(false);
              setError(null);
            }}
          >
            Cancel
          </button>
          {error && <span className="error small">{error}</span>}
        </form>
      ) : (
        <button className="link-button small" onClick={() => setAdding(true)}>
          {epics.length ? "Link another epic" : "Link an epic"}
        </button>
      )}
    </div>
  );
}
