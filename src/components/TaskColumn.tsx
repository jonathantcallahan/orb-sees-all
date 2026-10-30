import { useEffect, useState, type ReactNode } from "react";
import { addManualTask, type AdhocStore, type ManualTask, type Project, type StoredPlan } from "../db";
import { assessPendingTasks, refreshAdhoc } from "../jobs";
import type { ManualAssessment, Priority } from "../schema";
import { applyOrder, applyTaskState, formatMinutes, isFiltering, matchesFilter, myBlockingIds, reorder, splitToday, taskPriority, type TaskState, PRIORITY_RANK, type TaskFilter, type TaskSource } from "../tasks";
import { localDate } from "../scheduler";
import { projectName } from "../projects";
import { CloseIcon, RefreshButton, Updated } from "./common";
import { setTaskState, type StoredTaskCheck } from "../db";
import type { SessionLink } from "../sessions";
import { canonicalId, foldTasks, type Aliases, type Folded } from "../registry";
import { findDuplicates, type DuplicateCandidate } from "../duplicates";
import { Inbox } from "./Inbox";
import { TaskFilters, useTaskFilter } from "./TaskFilters";
import { useJobStatus } from "../useAppData";
import { TaskCard, type CardTask } from "./TaskCard";
import { DropZone, TaskDragProvider, type DropZoneId, type Flip } from "./taskDrag";

function Group({
  title,
  tasks: unsorted,
  empty,
  plans,
  assessments,
  checks,
  sessionLinks,
  priorityOverrides,
  openTasks,
  duplicates,
  running,
  filtered = false,
  controls,
  onChange,
}: {
  title: string;
  /** Shown at the right of the heading, e.g. filters. */
  controls?: ReactNode;
  tasks: CardTask[];
  empty: string;
  /** A filter is on, so say so when nothing is left. */
  filtered?: boolean;
  plans: Map<string, StoredPlan>;
  assessments: Map<string, ManualAssessment>;
  checks: Record<string, StoredTaskCheck>;
  sessionLinks: Record<string, SessionLink>;
  priorityOverrides: Record<string, Priority>;
  openTasks: { id: string; title: string }[];
  duplicates: Map<string, DuplicateCandidate>;
  running: string[];
  onChange: () => void;
}) {
  // Recommended tasks first, keeping the group's order otherwise.
  const tasks = [...unsorted].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
  return (
    <>
      <div className="group-header">
        <h4 className="section-title">{title}</h4>
        {controls}
      </div>
      {tasks.length === 0 && <p className="muted small">{filtered ? "Nothing matches the filters." : empty}</p>}
      {tasks.map((t) => (
        <TaskCard
          key={t.id}
          task={t}
          plan={plans.get(t.id)}
          planning={running.includes(`plan:${t.id}`)}
          manualAssessment={assessments.get(t.id)}
          assessing={running.includes("assess")}
          check={checks[t.id]}
          sessionLink={sessionLinks[t.id]}
          manualPriority={priorityOverrides[t.id]}
          openTasks={openTasks}
          duplicateOf={duplicates.get(t.id)}
          compact
          onChange={onChange}
        />
      ))}
    </>
  );
}

/** The order you've arranged each list in, by task id. Kept in localStorage like the filters. */
interface TaskOrder {
  today: string[];
  all: string[];
}
const ORDER_KEY = "task-order";
function useTaskOrder(): [TaskOrder, (list: keyof TaskOrder, ids: string[]) => void] {
  const [order, setOrder] = useState<TaskOrder>(() => {
    try {
      return { today: [], all: [], ...JSON.parse(localStorage.getItem(ORDER_KEY) ?? "{}") };
    } catch {
      return { today: [], all: [] };
    }
  });
  const save = (list: keyof TaskOrder, ids: string[]) =>
    setOrder((cur) => {
      const next = { ...cur, [list]: ids };
      localStorage.setItem(ORDER_KEY, JSON.stringify(next));
      return next;
    });
  return [order, save];
}

/** How long a task dropped among finished ones stays put before it moves up to the open ones. */
const SETTLE_BEFORE_SORT_MS = 450;

export function TaskColumn({
  adhoc,
  manual,
  projects,
  filterProject,
  onClearFilter,
  taskStates,
  plans,
  assessments,
  drafts,
  recommended,
  descriptionOverrides,
  taskChecks,
  sessionLinks,
  priorityOverrides,
  taskAliases,
  refinedDescriptions,
  notDuplicates,
  running,
  onChange,
}: {
  adhoc: AdhocStore;
  manual: ManualTask[];
  /** Visible projects; their open tasks for the user show here with a project badge. */
  projects: Project[];
  /** When set, only this project's tasks are shown. */
  filterProject: Project | null;
  onClearFilter: () => void;
  taskStates: Map<string, TaskState>;
  plans: Map<string, StoredPlan>;
  assessments: Map<string, ManualAssessment>;
  drafts: Map<string, { text: string }>;
  /** Task ids today's reading recommends. */
  recommended: Set<string>;
  /** Descriptions the user edited on refreshed tasks. */
  descriptionOverrides: Record<string, string>;
  /** Double checks of tasks, by task id. */
  taskChecks: Record<string, StoredTaskCheck>;
  /** Claude Code sessions opened for tasks, by task id. */
  sessionLinks: Record<string, SessionLink>;
  /** Priorities the user set by hand, by task id. */
  priorityOverrides: Record<string, Priority>;
  /** Other ids for the same tasks, mapped to their canonical ids. */
  taskAliases: Aliases;
  /** Descriptions refreshes brought up to date, by canonical id; the user's own edits win. */
  refinedDescriptions: Record<string, string>;
  /** Pairs you said aren't duplicates. */
  notDuplicates: Set<string>;
  running: string[];
  onChange: () => void;
}) {
  const [draft, setDraft] = useState("");
  const tasksStatus = useJobStatus("adhoc", "assess");
  const [filter, setFilter] = useTaskFilter();
  const filtering = isFiltering(filter);
  /** Effective priority, matching the card's badge: tasks in P0 projects are critical. */
  const priorityOf = (t: CardTask) =>
    taskPriority(
      (t.source === "manual" ? assessments.get(t.id) : t.assessment)?.priority,
      t.projectPriority,
      t.blocking,
      priorityOverrides[t.id],
    );
  const filters = <TaskFilters filter={filter} onChange={setFilter} showSource={!filterProject} />;
  /** What Orb can do on the task, from its assessment (null until assessed). */
  const automationOf = (t: CardTask) => (t.source === "manual" ? assessments.get(t.id) : t.assessment)?.automation ?? null;
  const sourceOf = (t: CardTask): TaskSource => (t.source === "manual" ? "own" : t.source === "project" ? "project" : "request");
  /** Applies the filters; in a single project's view, where everything comes from that project, the source filter doesn't apply. */
  const keep = <T extends CardTask>(list: T[], f: TaskFilter = filter) =>
    isFiltering(f)
      ? list.filter((t) => matchesFilter({ status: t.status, priority: priorityOf(t), recommended: t.recommended, source: sourceOf(t), automation: automationOf(t), due: t.due }, f))
      : list;
  /** One list from every source: most urgent first, then in each source's own order. */
  const byPriority = <T extends CardTask>(list: T[]) => {
    const rank = (t: T) => {
      const p = priorityOf(t);
      return p ? PRIORITY_RANK[p] : 5;
    };
    return list.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map(({ t }) => t);
  };
  const today = localDate(new Date());
  const [order, saveOrder] = useTaskOrder();
  /** Where a just-dropped task now belongs, until its saved state catches up (so it moves at once). */
  const [pendingZone, setPendingZone] = useState<Record<string, DropZoneId>>({});
  /** An open task just dropped among finished ones in Today: it stays there a moment before moving up. */
  const [heldAmongDone, setHeldAmongDone] = useState<string | null>(null);

  // Edits and Recommended may be keyed by any of a task's ids; the canonical one wins. A description
  // you edited beats one a refresh brought up to date with new information.
  const editedDescription = (id: string) => {
    const cid = canonicalId(id, taskAliases);
    return descriptionOverrides[cid] ?? descriptionOverrides[id] ?? refinedDescriptions[cid];
  };
  const isRecommended = (id: string) => recommended.has(id) || recommended.has(canonicalId(id, taskAliases));

  // Slack and email items share one inbox; dated items first, soonest first.
  const rawInbox = [...adhoc.tasks]
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
    .map((t) => ({ ...t, description: editedDescription(t.id) ?? t.description, recommended: isRecommended(t.id) }));

  // The user's tasks from project snapshots: blockers first, then by due date.
  const rawProjects = (filterProject ? [filterProject] : projects).flatMap((p) => {
    const blocking = new Set(myBlockingIds(p.snapshot?.blockers, taskStates));
    return (p.snapshot?.my_tasks ?? []).map((t) => ({
      ...t,
      source: "project" as const,
      project: { id: p.channel_id, name: projectName(p) },
      description: editedDescription(t.id) ?? t.description,
      blocking: blocking.has(t.id),
      recommended: isRecommended(t.id),
      projectPriority: p.snapshot?.priority?.level,
      repoFolder: p.local_repos[0] ?? null,
    }));
  });
  rawProjects.sort((a, b) => Number(b.blocking) - Number(a.blocking) || (a.due ?? "9999").localeCompare(b.due ?? "9999"));

  const rawMine = manual
    .filter((t) => !filterProject || t.project_id === filterProject.channel_id)
    // Your own words stay; a refresh's update only fills in a task you left without a description.
    .map((t) => ({
      ...t,
      description: t.description || refinedDescriptions[canonicalId(t.id, taskAliases)] || null,
      source: "manual" as const,
      recommended: isRecommended(t.id),
    }));

  // The same work from several sources (or merged by hand) shows once, under its canonical id.
  type Raw = (typeof rawMine)[number] | (typeof rawProjects)[number] | (typeof rawInbox)[number];
  const folded = foldTasks<Raw>([rawMine, rawProjects, rawInbox], taskAliases);
  const foldedMine = folded[0] as Folded<(typeof rawMine)[number]>[];
  const foldedProjects = folded[1] as Folded<(typeof rawProjects)[number]>[];
  const foldedInbox = folded[2] as Folded<(typeof rawInbox)[number]>[];
  // A task just dragged into or out of Today shows in its new place right away.
  const split = <T extends { id: string; todayOn: string | null; done: boolean }>(list: T[]) => {
    const { planned, rest } = splitToday(list, today);
    const movedIn = rest.filter((t) => pendingZone[t.id] === "today").map((t) => ({ ...t, carriedFrom: null }));
    return {
      planned: [...planned.filter((t) => pendingZone[t.id] !== "rest"), ...movedIn],
      rest: [...rest.filter((t) => pendingZone[t.id] !== "today"), ...planned.filter((t) => pendingZone[t.id] === "rest")],
    };
  };
  const inbox = split(applyTaskState(foldedInbox, taskStates));
  const projectTasks = split(applyTaskState(foldedProjects, taskStates));
  const mine = split(applyTaskState(foldedMine, taskStates));

  // Every open task's title, so a double check can spot duplicates.
  const openList = [...mine.planned, ...mine.rest, ...projectTasks.planned, ...projectTasks.rest, ...inbox.planned, ...inbox.rest].filter((t) => !t.done);
  const openTasks = openList.map((t) => ({ id: t.id, title: t.title }));
  // Likely duplicates among open tasks, for each card to offer a merge.
  const duplicates = findDuplicates(openList, notDuplicates);
  const shared = { plans, assessments, checks: taskChecks, sessionLinks, priorityOverrides, openTasks, duplicates, running, onChange };

  // Today's plan pulls from every group, in the order you arranged it, open tasks first (a task
  // just dropped among the finished ones waits there a moment before moving up).
  const doneish = (t: { id: string; done: boolean }) => t.done || t.id === heldAmongDone;
  const planned = applyOrder([...mine.planned, ...projectTasks.planned, ...inbox.planned], order.today).sort(
    (a, b) => Number(doneish(a)) - Number(doneish(b)),
  );
  const estimate = (t: (typeof planned)[number]) =>
    (t.source === "manual" ? assessments.get(t.id) : "assessment" in t ? t.assessment : null)?.estimate_minutes ?? 0;
  const remaining = planned.filter((t) => !t.done).reduce((sum, t) => sum + estimate(t), 0);
  const todayGroup = (
    <DropZone zone="today" className={`today-plan${planned.length ? "" : " empty"}`}>
      <h4 className="section-title today-heading">
        Today's tasks
        {planned.length > 0 && (
          <span className="today-total">
            {planned.filter((t) => !t.done).length} open{remaining > 0 && ` · ~${formatMinutes(remaining)}`}
          </span>
        )}
      </h4>
      {planned.length === 0 ? (
        <p className="muted small">Drag tasks here to plan your day.</p>
      ) : (
        planned.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            plan={plans.get(t.id)}
            planning={running.includes(`plan:${t.id}`)}
            manualAssessment={assessments.get(t.id)}
            assessing={running.includes("assess")}
            check={taskChecks[t.id]}
            sessionLink={sessionLinks[t.id]}
            manualPriority={priorityOverrides[t.id]}
            openTasks={openTasks}
            duplicateOf={duplicates.get(t.id)}
            // Finished tasks shrink to a one-line row (click to see the card again).
            compact={t.done}
            onChange={onChange}
          />
        ))
      )}
    </DropZone>
  );

  // All tasks, in your order (priority order for anything you haven't arranged).
  const allTasks = applyOrder(byPriority(filterProject ? [...projectTasks.rest, ...mine.rest] : [...projectTasks.rest, ...mine.rest, ...inbox.rest]), order.all);

  // Dropping a task puts it where you let go: in Today or All tasks, before the card it landed above.
  // Dropping on Today plans it; dropping it in All tasks unplans it.
  const moveTask = async (id: string, to: DropZoneId, before: string | null, flip: Flip) => {
    const list = to === "today" ? "today" : "all";
    const ids = (to === "today" ? planned : allTasks).map((t) => t.id);
    const next = reorder(ids, id, before);
    saveOrder(list, next);
    // An open task dropped among finished ones in Today lands there, then glides up to the open ones.
    const task = [...planned, ...allTasks].find((t) => t.id === id);
    if (to === "today" && task && !task.done) {
      const doneAt = next.findIndex((x) => x !== id && planned.find((t) => t.id === x)?.done);
      if (doneAt >= 0 && next.indexOf(id) > doneAt) {
        setHeldAmongDone(id);
        setTimeout(() => flip(() => setHeldAmongDone(null)), SETTLE_BEFORE_SORT_MS);
      }
    }
    const inToday = planned.some((t) => t.id === id);
    if ((to === "today") === inToday) return;
    setPendingZone((cur) => ({ ...cur, [id]: to }));
    await setTaskState(id, { todayOn: to === "today" ? today : null });
    onChange();
  };
  // Drop the instant-move override once the saved state agrees.
  useEffect(() => {
    const settled = Object.keys(pendingZone).filter((id) => {
      const on = taskStates.get(id)?.todayOn ?? null;
      return (pendingZone[id] === "today") === (on === today);
    });
    if (settled.length) setPendingZone((cur) => Object.fromEntries(Object.entries(cur).filter(([id]) => !settled.includes(id))));
  }, [taskStates]);

  return (
    <TaskDragProvider onDrop={moveTask}>
    <DropZone zone="rest" className="column tasks-column">
      <Inbox replies={adhoc.replies} states={taskStates} drafts={drafts} running={running} onChange={onChange} />
      <header className="column-header">
        <div className="title-line">
          <h2>Tasks</h2>
          <Updated at={adhoc.refreshed_at} />
        </div>
        <RefreshButton busy={running.includes("adhoc") || running.includes("assess")} status={tasksStatus} title="Refresh tasks" onClick={() => {
            refreshAdhoc().catch(() => {});
            assessPendingTasks().catch(() => {});
          }} />
      </header>

      <form
        className="add-task"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          await addManualTask(draft.trim());
          setDraft("");
          onChange();
          assessPendingTasks().catch(() => {});
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a task…" />
      </form>

      {/* The inbox, header and add box stay put; only the tasks below them scroll. */}
      <div className="task-list">
      {filterProject ? (
        <>
          <div className="filter-chip">
            <span>
              Tasks for <strong>{projectName(filterProject)}</strong>
            </span>
            <button className="icon-button" onClick={onClearFilter} title="Show all tasks" aria-label="Show all tasks">
              <CloseIcon />
            </button>
          </div>
          {todayGroup}
          <Group
            title="All tasks"
            tasks={keep(applyOrder(byPriority([...projectTasks.rest, ...mine.rest]), order.all), { ...filter, sources: [] })}
            empty={filterProject.snapshot ? "Nothing on you for this project." : "Refresh this project to find your tasks."}
            filtered={isFiltering({ ...filter, sources: [] })}
            controls={filters}
            {...shared}
          />
        </>
      ) : (
        <>
          {todayGroup}
          <Group
            title="All tasks"
            tasks={keep(allTasks)}
            empty="No tasks yet. Add one above, or refresh to find them in your projects, Slack and email."
            filtered={filtering}
            controls={filters}
            {...shared}
          />
        </>
      )}
      </div>
    </DropZone>
    </TaskDragProvider>
  );
}
