import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TaskChatDockProvider, type TaskChatDock } from "./chatDock";
import { isWindows, MOD } from "../platform";
import { addManualTask, type AdhocStore, type ManualTask, type MergedTask, type Project, type StoredPlan } from "../db";
import { assessPendingTasks } from "../jobs";
import type { CalendarDay, ManualAssessment, Priority } from "../schema";
import { applyOrder, applyTaskState, formatMinutes, isFiltering, taskEstimate, matchesFilter, myBlockingIds, reorder, splitToday, taskPriority, type TaskState, PRIORITY_RANK, type TaskFilter, type TaskSource } from "../tasks";
import { localDate } from "../scheduler";
import { projectName } from "../projects";
import { CloseIcon, Kbd, Spinner, Updated } from "./common";
import { getSetting, setSetting, setTaskState, type StoredTaskCheck } from "../db";
import type { SessionLink } from "../sessions";
import { canonicalId, foldTasks, type Aliases, type Folded } from "../registry";
import { findDuplicates, type DuplicateCandidate } from "../duplicates";
import { Inbox } from "./Inbox";
import { SortSelect, TaskFilters, useTaskFilter } from "./TaskFilters";
import { createdAt, sortTasks, type TaskSort } from "../taskDates";
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
  mergedFrom,
  running,
  filtered = false,
  controls,
  titleControls,
  keepOrder = false,
  dateOf,
  createdOf,
  unread,
  onSeen,
  onChange,
}: {
  /** Tasks with something new you haven't opened, and how opening one marks it seen (see unread.ts). */
  unread?: Set<string>;
  onSeen?: (id: string) => void;
  /** When each task was created, shown in its open card beside the due date. */
  createdOf?: (t: CardTask) => string | null;
  /** Each task's date to show as a badge (the list is sorted by it). */
  dateOf?: (t: CardTask) => { kind: "due" | "created"; date: string | null };
  title: string;
  /** Shown at the right of the heading, e.g. filters. */
  controls?: ReactNode;
  /** Shown right after the title, e.g. how it's sorted. */
  titleControls?: ReactNode;
  /** Keep the tasks exactly in the order given (a sort other than priority), not recommended first. */
  keepOrder?: boolean;
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
  mergedFrom: Record<string, MergedTask[]>;
  running: string[];
  onChange: () => void;
}) {
  // Recommended tasks first, keeping the group's order otherwise.
  const tasks = keepOrder ? unsorted : [...unsorted].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
  return (
    <>
      <div className="group-header">
        <div className="group-title">
          <h4 className="section-title">{title}</h4>
          {titleControls}
        </div>
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
          mergedIn={mergedFrom[t.id]}
          compact
          dateBadge={dateOf?.(t)}
          created={createdOf?.(t)}
          unread={unread?.has(t.id)}
          onSeen={onSeen && (() => onSeen(t.id))}
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
  calendar,
  projects,
  filterProject,
  onClearFilter,
  taskStates,
  plans,
  assessments,
  recommended,
  descriptionOverrides,
  taskChecks,
  sessionLinks,
  priorityOverrides,
  dueOverrides = {},
  unread,
  onSeen,
  projectOverrides = {},
  taskAliases,
  refinedDescriptions,
  taskBriefs = {},
  notDuplicates,
  mergedFrom = {},
  running,
  sideBySide = false,
  headerExtra,
  onChange,
}: {
  /** Shown at the right of the Tasks header, e.g. the orb's stats in the Detail view. */
  headerExtra?: ReactNode;
  /**
   * The Detail view's Tasks area: Today's tasks on the left and All tasks on the right, side by side
   * (dragging between them still plans and unplans), with the inbox shown in Updates instead.
   */
  sideBySide?: boolean;
  adhoc: AdhocStore;
  manual: ManualTask[];
  /** Today's meetings; their prep items are tasks too. */
  calendar: CalendarDay | null;
  /** Visible projects; their open tasks for the user show here with a project badge. */
  projects: Project[];
  /** When set, only this project's tasks are shown. */
  filterProject: Project | null;
  onClearFilter: () => void;
  taskStates: Map<string, TaskState>;
  plans: Map<string, StoredPlan>;
  assessments: Map<string, ManualAssessment>;
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
  /** Due dates the user set by hand, by task id: they win over the ones refreshes found. */
  dueOverrides?: Record<string, { due: string | null }>;
  /** Tasks with something new you haven't opened (see unread.ts), and how opening one marks it seen. */
  unread?: Set<string>;
  onSeen?: (id: string) => void;
  /** Projects the user moved tasks to, by task id: shown under that project instead of where they were found. */
  projectOverrides?: Record<string, string>;
  /** Other ids for the same tasks, mapped to their canonical ids. */
  taskAliases: Aliases;
  /** Descriptions refreshes brought up to date, by canonical id; the user's own edits win. */
  refinedDescriptions: Record<string, string>;
  /** Your own notes on tasks you added, as typed, when a short title replaced them (see retitleManualTask). */
  taskBriefs?: Record<string, string>;
  /** Pairs you said aren't duplicates. */
  notDuplicates: Set<string>;
  /** What was merged into each task, by the kept task's id. */
  mergedFrom?: Record<string, MergedTask[]>;
  running: string[];
  onChange: () => void;
}) {
  const [draft, setDraft] = useState("");
  // ⌘N (Ctrl+N on Windows) jumps to Add a task from anywhere.
  const addTask = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isWindows ? e.ctrlKey : e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        addTask.current?.focus();
        addTask.current?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const tasksStatus = useJobStatus("adhoc", "assess", "sessions");
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
  const sourceOf = (t: CardTask): TaskSource => (t.source === "manual" ? "own" : t.source === "project" ? "project" : t.source === "meeting" ? "meeting" : "request");
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
  // A due date you set (or took off) wins over the one a refresh found.
  const dueFor = (id: string, found: string | null | undefined) => {
    const set = dueOverrides[canonicalId(id, taskAliases)] ?? dueOverrides[id];
    return set ? set.due : (found ?? null);
  };

  // The project a task was moved to (see setTaskProject), if it's still on the board.
  const movedTo = (id: string) => {
    const to = projectOverrides[canonicalId(id, taskAliases)] ?? projectOverrides[id];
    return to ? projects.find((p) => p.channel_id === to) : undefined;
  };
  const projectFields = (p: Project) => ({ project: { id: p.channel_id, name: projectName(p) }, projectPriority: p.snapshot?.priority?.level, repoFolder: p.local_repos[0] ?? null });

  // Slack and email items share one inbox; dated items first, soonest first. One you filed under a
  // project shows its badge.
  const rawInbox = adhoc.tasks
    .map((t) => {
      const to = movedTo(t.id);
      return { ...t, ...(to ? projectFields(to) : {}), due: dueFor(t.id, t.due), description: editedDescription(t.id) ?? t.description, recommended: isRecommended(t.id) };
    })
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));

  // The user's tasks from project snapshots, under the project you moved one to if you did: blockers
  // first, then by due date.
  const rawProjects = projects
    .flatMap((p) => {
      const blocking = new Set(myBlockingIds(p.snapshot?.blockers, taskStates));
      return (p.snapshot?.my_tasks ?? []).map((t) => ({
        ...t,
        source: "project" as const,
        ...projectFields(movedTo(t.id) ?? p),
        due: dueFor(t.id, t.due),
        description: editedDescription(t.id) ?? t.description,
        blocking: blocking.has(t.id),
        recommended: isRecommended(t.id),
      }));
    })
    .filter((t) => !filterProject || t.project.id === filterProject.channel_id);
  rawProjects.sort((a, b) => Number(b.blocking) - Number(a.blocking) || (a.due ?? "9999").localeCompare(b.due ?? "9999"));

  const rawMine = manual
    .filter((t) => !filterProject || t.project_id === filterProject.channel_id)
    // Your own words stay; a refresh's update only fills in a task you left without a description.
    .map((t) => ({
      ...t,
      description: t.description || refinedDescriptions[canonicalId(t.id, taskAliases)] || null,
      brief: taskBriefs[t.id] ?? null,
      due: dueFor(t.id, null),
      source: "manual" as const,
      recommended: isRecommended(t.id),
    }));

  // Meeting prep: each item of today's meetings you haven't declined is a task, planned for today
  // until you move it. It shares its id with the meeting card's prep checklist, so ticking either
  // ticks both.
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const rawPrep = filterProject
    ? []
    : (calendar?.events ?? [])
        .filter((ev) => ev.my_response !== "declined")
        // Prep for a meeting that's over is moot: it goes, unless you're in the middle of it.
        .flatMap((ev) =>
          ev.prep.filter((p) => new Date(ev.end) > new Date() || taskStates.get(p.id)?.status === "in_progress").map((p) => ({
            id: p.id,
            title: p.title,
            link: p.link ?? null,
            description: `To prepare for "${ev.title}" at ${time(ev.start)}${ev.summary ? `: ${ev.summary}` : "."}`,
            due: dueFor(p.id, calendar!.date),
            source: "meeting" as const,
            recommended: isRecommended(p.id),
          })),
        );

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
  // Prep you haven't touched counts as planned for today.
  const withPrepPlanned = applyTaskState(rawPrep, taskStates).map((t) => (taskStates.has(t.id) ? t : { ...t, todayOn: today }));
  const prep = split(withPrepPlanned);
  const inbox = split(applyTaskState(foldedInbox, taskStates));
  const projectTasks = split(applyTaskState(foldedProjects, taskStates));
  const mine = split(applyTaskState(foldedMine, taskStates));

  // Every open task's title, so a double check can spot duplicates.
  const openList = [...mine.planned, ...mine.rest, ...projectTasks.planned, ...projectTasks.rest, ...inbox.planned, ...inbox.rest, ...prep.planned, ...prep.rest].filter(
    (t) => !t.done,
  );
  const openTasks = openList.map((t) => ({ id: t.id, title: t.title }));
  // Likely duplicates among open tasks, for each card to offer a merge.
  const duplicates = findDuplicates(openList, notDuplicates);
  const [firstSeen, setFirstSeen] = useState<Record<string, string>>({});
  // When each task was created.
  const createdOf = (t: CardTask) => createdAt(t as CardTask & { created_at?: string | null }, firstSeen);
  const shared = { plans, assessments, checks: taskChecks, sessionLinks, priorityOverrides, openTasks, duplicates, mergedFrom, running, createdOf, unread, onSeen, onChange };

  // Today's plan pulls from every group, in the order you arranged it, open tasks first (a task
  // just dropped among the finished ones waits there a moment before moving up).
  const doneish = (t: { id: string; done: boolean }) => t.done || t.id === heldAmongDone;
  const planned = applyOrder([...prep.planned, ...mine.planned, ...projectTasks.planned, ...inbox.planned], order.today).sort(
    (a, b) => Number(doneish(a)) - Number(doneish(b)),
  );
  const estimate = (t: (typeof planned)[number]) =>
    taskEstimate(plans.get(t.id)?.plan, t.source === "manual" ? assessments.get(t.id) : "assessment" in t ? t.assessment : null) ?? 0;
  const remaining = planned.filter((t) => !t.done).reduce((sum, t) => sum + estimate(t), 0);
  const todayGroup = (
    <DropZone zone="today" className={`today-plan${planned.length ? "" : " empty"}`}>
      <h4 className="section-title today-heading">
        Today's tasks
        {/* The time the open tasks still need. */}
        {remaining > 0 && <span className="today-total">{formatMinutes(remaining)}</span>}
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
            mergedIn={mergedFrom[t.id]}
            // Finished tasks shrink to a one-line row (click to see the card again).
            compact={t.done}
            created={createdOf(t)}
            unread={unread?.has(t.id)}
            onSeen={onSeen && (() => onSeen(t.id))}
            onChange={onChange}
          />
        ))
      )}
    </DropZone>
  );

  // How All tasks is sorted (remembered), and when tasks without a date of their own were first seen.
  const [sort, setSortState] = useState<TaskSort>(() => {
    const v = localStorage.getItem("all-tasks-sort");
    return v === "due" || v === "newest" || v === "oldest" ? v : "priority";
  });
  const setSort = (v: TaskSort) => {
    localStorage.setItem("all-tasks-sort", v);
    setSortState(v);
  };
  const sortControl = <SortSelect value={sort} onChange={setSort} />;
  // Sorted by a date, each card shows it.
  const dateOf =
    sort === "due"
      ? (t: CardTask) => ({ kind: "due" as const, date: t.due ?? null })
      : sort === "newest" || sort === "oldest"
        ? (t: CardTask) => ({ kind: "created" as const, date: createdAt(t as CardTask & { created_at?: string | null }, firstSeen) })
        : undefined;
  useEffect(() => {
    getSetting("task_first_seen").then((v) => setFirstSeen(v ? JSON.parse(v) : {}), () => {});
  }, []);
  // A task with no date of its own (from a project or email) is dated from when it first turns up.
  const undated = [...projectTasks.rest, ...projectTasks.planned, ...inbox.rest, ...inbox.planned]
    .filter((t) => !createdAt(t, firstSeen))
    .map((t) => t.id);
  useEffect(() => {
    if (!undated.length) return;
    const now = new Date().toISOString();
    getSetting("task_first_seen").then((v) => {
      const seen: Record<string, string> = v ? JSON.parse(v) : {};
      let added = false;
      for (const id of undated) if (!seen[id]) (seen[id] = now), (added = true);
      if (!added) return;
      setSetting("task_first_seen", JSON.stringify(seen)).then(() => setFirstSeen(seen));
    }, () => {});
  }, [undated.join("|")]);

  // All tasks, by priority, most urgent first; within a priority, in the order you arranged them
  // (dragging moves a task among those of its own priority).
  const allTasks = sortTasks(
    byPriority(applyOrder(filterProject ? [...projectTasks.rest, ...mine.rest] : [...projectTasks.rest, ...mine.rest, ...inbox.rest, ...prep.rest], order.all)),
    sort,
    firstSeen,
  );

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
  // The Detail view's chat dock: one task's chat in place of All tasks. Opening it brings the task
  // into Today, where you're working on it.
  const [chatOwner, setChatOwner] = useState<TaskChatDock["owner"]>(null);
  const [chatTarget, setChatTarget] = useState<HTMLElement | null>(null);
  const chatDock = useMemo<TaskChatDock>(
    () => ({
      owner: chatOwner,
      target: chatTarget,
      open: (id, kind) => {
        setChatOwner({ id, kind });
        if (!planned.some((t) => t.id === id)) {
          setPendingZone((cur) => ({ ...cur, [id]: "today" }));
          setTaskState(id, { todayOn: today }).then(onChange, () => {});
        }
      },
      close: (id) => setChatOwner((cur) => (cur?.id === id ? null : cur)),
    }),
    [chatOwner, chatTarget, planned],
  );
  // A chat whose task has left the board (dismissed, merged, done elsewhere) has no card to show it,
  // so the dock gives All tasks back rather than staying blank.
  // What's actually shown: All tasks hides some (done ones, by the filters), and a hidden card draws no chat.
  const ownerShown = !chatOwner || planned.some((t) => t.id === chatOwner.id) || keep(allTasks).some((t) => t.id === chatOwner.id);
  useEffect(() => {
    if (!ownerShown) setChatOwner(null);
  }, [ownerShown]);
  // Drop the instant-move override once the saved state agrees.
  useEffect(() => {
    const settled = Object.keys(pendingZone).filter((id) => {
      const on = taskStates.get(id)?.todayOn ?? null;
      return (pendingZone[id] === "today") === (on === today);
    });
    if (settled.length) setPendingZone((cur) => Object.fromEntries(Object.entries(cur).filter(([id]) => !settled.includes(id))));
  }, [taskStates]);

  const header = (
      <header className="column-header">
        <div className="title-line">
          <h2>Tasks</h2>
          <Updated at={adhoc.refreshed_at} />
        </div>
        {/* Refreshed from the bottom bar's Refresh menu; a spinner here while it runs. */}
        {(running.includes("adhoc") || running.includes("assess") || running.includes("sessions")) && (
          <span className="section-spinner" aria-label={tasksStatus ?? "Refreshing tasks"}>
            <Spinner />
          </span>
        )}
        {headerExtra && <div className="header-extra">{headerExtra}</div>}
      </header>
  );
  const addBox = (
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
        <input ref={addTask} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a task…" aria-label={`Add a task (${MOD}N)`} />
        {!draft && <Kbd keys={`${MOD}N`} />}
      </form>
  );

  if (sideBySide)
    return (
      <TaskChatDockProvider value={chatDock}>
      <TaskDragProvider onDrop={moveTask}>
        <div className="detail-split">
          <section className="column detail-pane">
            {header}
            {addBox}
            <div className="task-list">{todayGroup}</div>
          </section>
          {/* A task's chat, when one is open, takes the place of All tasks (see TaskChatDock). */}
          {chatOwner ? (
            <section className="detail-pane chat-dock" ref={setChatTarget} />
          ) : (
          <DropZone zone="rest" className="column detail-pane">
            <div className="task-list">
              <Group
                title="All tasks"
                titleControls={sortControl}
                keepOrder={sort !== "priority"}
                dateOf={dateOf}
                tasks={keep(allTasks)}
                empty="No tasks yet. Add one, or refresh to find them in your projects, Slack and email."
                filtered={filtering}
                controls={filters}
                {...shared}
              />
            </div>
          </DropZone>
          )}
        </div>
      </TaskDragProvider>
      </TaskChatDockProvider>
    );

  return (
    <TaskDragProvider onDrop={moveTask}>
    <DropZone zone="rest" className="column tasks-column">
      <Inbox replies={adhoc.replies} states={taskStates} taskIds={new Set(adhoc.tasks.map((t) => t.id))} onChange={onChange} />
      {header}
      {addBox}

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
            titleControls={sortControl}
            keepOrder={sort !== "priority"}
            dateOf={dateOf}
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
