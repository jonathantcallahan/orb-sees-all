import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { Kbd, RefreshButton, ScrambleText, Spinner } from "./components/common";
import { DailyReading } from "./components/DailyReading";
import { Mist } from "./components/Mist";
import { ProjectFilters, useProjectFilter } from "./components/TaskFilters";
import { SuggestedProjects } from "./components/SuggestedProjects";
import { UpdateButton } from "./components/UpdateButton";
import { WindowButtons } from "./components/WindowButtons";
import { SetupScreen } from "./components/SetupScreen";
import { Onboarding } from "./components/Onboarding";
import { GlobalChat } from "./components/GlobalChat";
import { WhyPrompt } from "./components/WhyPrompt";
import { isWindows, MOD } from "./platform";
import { ProjectCard, ProjectDetail } from "./components/ProjectCard";
import { revealTask } from "./components/TaskCard";
import { WatchedTopics } from "./components/WatchedTopics";
import { needsYou } from "./watched";
import { Inbox } from "./components/Inbox";
import { ChatDockProvider } from "./components/chatDock";
import { useDetailTab, type DetailTab } from "./viewMode";
import { Settings } from "./components/Settings";
import { TaskColumn } from "./components/TaskColumn";
import { TodayColumn } from "./components/TodayColumn";
import { getNotes, getSetting, markInterruptedJobs, saveSeen, setSetting } from "./db";
import { seenAfter, toRecord, unreadIds, updateFacts } from "./unread";
import { setStandingNotes } from "./claude";
import { assessPendingTasks, checkWatchedTopics, maybeDistill, maybeRunMorning, pollSelfDm, refreshAdhoc, refreshAll, refreshCalendar, refreshReading, scanClaudeSessions } from "./jobs";
import { localDate } from "./scheduler";
import { compareProjects, matchesProjectFilter, myBlockingIds, pressure, PRIORITY_RANK, stateOf, taskPriority, type PressureTask } from "./tasks";
import { canonicalId } from "./registry";
import { projectStatus, projectName } from "./projects";
import { useTheme } from "./theme";
import { useOrbLook } from "./orbLook";
import { setUserProfile } from "./prompts";
import { OrbGlow } from "./components/PressureBlob";
import { PressureBars } from "./components/PressureBars";
import { useAppData, useJobStatus, useRunningJobs, useStatusFeed } from "./useAppData";
import { isChatJob } from "./statusFeed";

const refreshAllSafely = () => refreshAll().catch(() => {});

function useScheduler() {
  useEffect(() => {
    // Each minute: the morning refresh when it's due, and learning from corrections once enough build up.
    const check = () => {
      maybeRunMorning().catch(() => {});
      maybeDistill().catch(() => {});
    };
    markInterruptedJobs().then(check, check);
    // The Rust side emits a tick every minute, which reaches the webview even
    // while the window is hidden; the interval and focus check are backups.
    const interval = setInterval(check, 60_000);
    // Your own Slack DM, for messages tagged #demian: checked every few minutes once turned on in Settings (see pollSelfDm).
    const pollDm = () => pollSelfDm().catch(() => {});
    pollDm();
    const dmInterval = setInterval(pollDm, 30_000);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    const unlisteners = [listen("scheduler-tick", check), listen("tray-refresh-all", refreshAllSafely)];
    const onKey = (e: KeyboardEvent) => {
      const mod = isWindows ? e.ctrlKey : e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "r" && !e.shiftKey) {
        e.preventDefault();
        refreshAllSafely();
        return;
      }
      // WebView2 keeps browser shortcuts the app doesn't want: reloading (which drops runs in
      // progress), printing, find, and zoom.
      if (isWindows && (key === "f5" || (mod && (key === "r" || key === "p" || key === "f" || key === "=" || key === "+" || key === "-" || key === "0")))) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    // Ctrl+wheel zooms in WebView2.
    const onWheel = (e: WheelEvent) => isWindows && e.ctrlKey && e.preventDefault();
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      clearInterval(interval);
      clearInterval(dmInterval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, []);
}

/** Marks a project seen while its details are shown: showing them is opening it. */
function SeenWhileShown({ id, unread, onSeen }: { id: string; unread: boolean; onSeen: (id: string) => void }) {
  useEffect(() => {
    if (unread) onSeen(id);
  }, [id, unread]);
  return null;
}

/** One entry per canonical task, keeping the most urgent priority and earliest due date among its ids. */
function onePerTask(tasks: PressureTask[], aliases: Map<string, string>): PressureTask[] {
  const byId = new Map<string, PressureTask>();
  for (const t of tasks) {
    const id = canonicalId(t.id, aliases);
    const seen = byId.get(id);
    const rank = (p: PressureTask["priority"]) => (p ? PRIORITY_RANK[p] : 5);
    if (!seen) byId.set(id, { ...t, id });
    else
      byId.set(id, {
        ...seen,
        priority: rank(t.priority) < rank(seen.priority) ? t.priority : seen.priority,
        due: [seen.due, t.due].filter(Boolean).sort()[0] ?? null,
        projectId: seen.projectId ?? t.projectId,
      });
  }
  return [...byId.values()];
}

export default function App() {
  const { data, reload } = useAppData();
  const running = useRunningJobs();
  const [showSettings, setShowSettings] = useState(false);
  /** Settings opened from the chat's View learnings, scrolled to them. */
  const [settingsLearnings, setSettingsLearnings] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  /** Settings' Simulate onboarding: the same screens, with made-up results, changing nothing. */
  const [simulateOnboarding, setSimulateOnboarding] = useState(false);
  const [showChat, setShowChat] = useState(false);
  // ⌘D (Ctrl+D on Windows) opens the Demian chat, or closes it if it's open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isWindows ? e.ctrlKey : e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setShowChat((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The menu bar's hidden "Replay onboarding".
  useEffect(() => {
    const unlisten = listen("tray-onboarding", () => setShowOnboarding(true));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  // First run: walk through setup until it's done. Anyone already using the app (it knows their
  // Slack user) counts as set up.
  useEffect(() => {
    Promise.all([getSetting("setup_done"), getSetting("slack_user_id")]).then(([done, user]) => {
      if (done || user) setSetting("setup_done", "1").catch(() => {});
      else setShowOnboarding(true);
    }, () => {});
  }, []);
  // The open area, the project the Projects area shows, and the chat open in the Updates area.
  const [tab, setTab] = useDetailTab();
  const [shownProject, setShownProject] = useState<string | null>(null);
  const [dockOwner, setDockOwner] = useState<string | null>(null);
  const [dockTarget, setDockTarget] = useState<HTMLElement | null>(null);
  const dock = useMemo(
    () => ({ owner: dockOwner, target: dockTarget, open: setDockOwner, close: (owner: string) => setDockOwner((cur) => (cur === owner ? null : cur)) }),
    [dockOwner, dockTarget],
  );
  const [theme, setTheme] = useTheme();
  const [orbLook, setOrbLook] = useOrbLook();
  // Who you are, for the prompts (learned in the background; see learnRole).
  useEffect(() => {
    getSetting("user_profile").then(setUserProfile, () => {});
    getNotes().then(setStandingNotes, () => {});
  }, []);
  const [projectFilter, setProjectFilter] = useProjectFilter();
  useScheduler();

  // Unread dots (see unread.ts): what Demian has found about each task, project and topic, against
  // what you've seen of it.
  const facts = useMemo(
    () =>
      data
        ? updateFacts({
            projects: data.projects.filter((p) => !p.hidden && p.state === "tracked"),
            adhoc: data.adhoc.tasks,
            manual: data.manual,
            watched: data.watched,
            taskAliases: data.taskAliases,
            refinedDescriptions: data.refinedDescriptions,
            taskChecks: data.taskChecks,
            taskStates: data.taskStates,
          })
        : null,
    [data],
  );
  const unread = useMemo(() => (data && facts ? unreadIds(facts.facts, facts.mine, data.seen, data.unreadStarted) : new Set<string>()), [data, facts]);
  // What you have when dots begin starts read; so does each task of your own when it first appears.
  useEffect(() => {
    if (!data || !facts) return;
    const ids = toRecord(facts.facts, facts.mine, data.seen, data.unreadStarted);
    if (!ids.length && data.unreadStarted) return;
    saveSeen(ids.map((id) => [id, facts.facts.get(id) ?? []]))
      .then(() => (data.unreadStarted ? undefined : setSetting("unread_started", new Date().toISOString())))
      .then(reload, () => {});
  }, [facts]);
  /** Opening an item marks what's new about it seen. */
  const markSeen = (id: string) => {
    const current = facts?.facts.get(id);
    if (!data || !current || !unread.has(id)) return;
    saveSeen([[id, seenAfter(data.seen[id], current)]]).then(reload, () => {});
  };

  // Pick up anything written to the database while the window was in the background.
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  if (!data) return <div className="loading">Loading…</div>;

  // Watched topics that need you (an action ready, or set to Human): a dot on their area's icon.
  const watchedNeedYou = data.watched.filter((t) => needsYou(t, stateOf(data.taskStates, t.id))).length;
  const projects = data.projects
    .filter((p) => !p.hidden)
    .sort((a, b) =>
      compareProjects(
        { name: a.name, status: projectStatus(a) ?? null, priority: a.snapshot?.priority?.level },
        { name: b.name, status: projectStatus(b) ?? null, priority: b.snapshot?.priority?.level },
      ),
    );
  const counts = {
    blocked: projects.filter((p) => projectStatus(p) === "blocked").length,
    at_risk: projects.filter((p) => projectStatus(p) === "at_risk").length,
  };
  const recommended = new Set(data.reading?.date === localDate(new Date()) ? (data.reading.recommended ?? []) : []);
  const shownProjects = projects.filter((p) =>
    matchesProjectFilter(
      { status: projectStatus(p) ?? null, priority: p.snapshot?.priority?.level, role: p.snapshot?.raci?.role },
      projectFilter,
    ),
  );
  // A due date you set wins over the one a refresh found.
  const dueFor = (id: string, found: string | null | undefined) => {
    const set = data.dueOverrides[canonicalId(id, data.taskAliases)] ?? data.dueOverrides[id];
    return set ? set.due : (found ?? null);
  };
  // Every open task the user owns, at the priority its card shows, so the orb weighs what you see.
  // The same work from several sources counts once, under its canonical id, at its highest priority.
  const load = pressure(
    onePerTask([
      ...projects.flatMap((p) => {
        const blocking = new Set(myBlockingIds(p.snapshot?.blockers, data.taskStates));
        return (p.snapshot?.my_tasks ?? []).map((t) => ({
          id: t.id,
          due: dueFor(t.id, t.due),
          projectId: p.channel_id,
          priority: taskPriority(t.assessment?.priority, p.snapshot?.priority?.level, blocking.has(t.id), data.priorityOverrides[t.id]),
        }));
      }),
      ...data.adhoc.tasks.map((t) => ({
        id: t.id,
        due: dueFor(t.id, t.due),
        priority: taskPriority(t.assessment?.priority, null, false, data.priorityOverrides[t.id]),
      })),
      ...data.manual.map((t) => ({
        id: t.id,
        due: dueFor(t.id, null),
        projectId: t.project_id,
        priority: taskPriority(data.assessments.get(t.id)?.priority, null, false, data.priorityOverrides[t.id]),
      })),
    ], data.taskAliases),
    data.taskStates,
  );

  return (
    <div className="app">
      {/* No top bar: Settings and Refresh all sit small in the top-left corner, with what's refreshing beside them. */}
      {/* The window has no title bar on macOS: this strip along the top drags the window (and zooms it on double-click). */}
      {!isWindows && <div className="window-drag" data-tauri-drag-region />}
      {!isWindows && <WindowButtons />}
      <nav className="app-tools" aria-label="App">
        <button className={`glass-button look-${orbLook}`} onClick={() => setShowSettings(true)}>
          Settings
        </button>
        <button className={`glass-button chat-button look-${orbLook}`} onClick={() => setShowChat(true)} title="Chat with Demian" aria-label={`Chat with Demian (${MOD}D)`}>
          Chat
          <Kbd keys={`${MOD}D`} />
        </button>
        <BottomStatus running={running} />
        <UpdateButton />
      </nav>

      {/* The orb and calendar, a rule, a rail of icons for the three areas, then the open area in a
          panel with rounded top corners, flush with the bottom of the window. */}
      <main className="detail-layout">
        <OrbGlow look={orbLook} level={load.level} />
        <TodayColumn pressure={load} orbLook={orbLook} working={running.length > 0} calendar={data.calendar} taskStates={data.taskStates} busy={running.includes("calendar")} onChange={reload} />
        <nav className="detail-rail" aria-label="Areas">
          {DETAIL_TABS.map(({ id, label, rects, paths }) => {
            // A watched topic that needs you puts a dot on its area's icon.
            const dot = id === "watched" && watchedNeedYou > 0;
            return (
              <button
                key={id}
                className={`detail-tab${tab === id ? " on" : ""}`}
                onClick={() => setTab(id)}
                title={label}
                aria-label={dot ? `${label}, ${watchedNeedYou} need you` : label}
                aria-current={tab === id ? "page" : undefined}
              >
                {viewIcon(rects, tab !== id, 18, paths)}
                {dot && <span className="tab-dot" aria-hidden />}
              </button>
            );
          })}
        </nav>
        <div className="detail-panel">
          {tab === "updates" && (
            <ChatDockProvider value={dock}>
              <div className="detail-split">
                <section className="column detail-pane">
                  <DailyReading
                    alwaysOpen
                    reading={data.reading}
                    projects={data.projects}
                    news={data.adhoc.news}
                    states={data.taskStates}
                    inbox={new Set(data.adhoc.replies.map((r) => r.id))}
                    busy={running.includes("reading")}
                    updatesBusy={running.some((k) => k.startsWith("project:") || k === "adhoc")}
                    onChange={reload}
                  />
                  <Inbox replies={data.adhoc.replies} states={data.taskStates} taskIds={new Set(data.adhoc.tasks.map((t) => t.id))} busy={running.includes("adhoc")} onChange={reload} />
                </section>
                <section className="detail-pane chat-dock" ref={setDockTarget}>
                  {!dockOwner && <p className="muted small chat-dock-empty">Click Explain on an Update or Draft on an Inbox item to open a chat here</p>}
                </section>
              </div>
            </ChatDockProvider>
          )}
          {tab === "watched" && (
            <WatchedTopics
              topics={data.watched}
              unread={unread}
              onSeen={markSeen}
              projects={projects.map((p) => ({ id: p.channel_id, name: projectName(p) }))}
              states={data.taskStates}
              running={running}
              onViewTask={(id) => {
                revealTask(id);
                setTab("tasks");
              }}
              onChange={reload}
            />
          )}
          {tab === "tasks" && (
            <TaskColumn
          adhoc={data.adhoc}
          manual={data.manual}
          calendar={data.calendar?.day ?? null}
          projects={projects}
          filterProject={null}
          onClearFilter={() => {}}
          taskStates={data.taskStates}
          plans={data.plans}
          assessments={data.assessments}
          recommended={recommended}
          descriptionOverrides={data.descriptionOverrides}
          taskChecks={data.taskChecks}
          sessionLinks={data.sessionLinks}
          priorityOverrides={data.priorityOverrides}
          dueOverrides={data.dueOverrides}
          unread={unread}
          onSeen={markSeen}
          projectOverrides={data.projectOverrides}
          taskAliases={data.taskAliases}
          refinedDescriptions={data.refinedDescriptions}
          taskBriefs={data.taskBriefs}
          notDuplicates={data.notDuplicates}
          mergedFrom={data.mergedFrom}
          running={running}
          sideBySide
          headerExtra={<PressureBars pressure={load} />}
          onChange={reload}
        />
          )}
          {tab === "projects" && (
            <div className="detail-split">
              <section className="column detail-pane">
          <header className="column-header">
            <div className="row">
              <h2>Projects</h2>
              {counts.blocked > 0 && <span className="pill blocked">{counts.blocked} blocked</span>}
            </div>
            <ProjectFilters filter={projectFilter} onChange={setProjectFilter} />
          </header>
          <div className="project-list">
          {projects.length === 0 && (
            <p className="muted small">
              {running.includes("discover") ? "Finding your project channels…" : "No projects yet. Refresh all to find your project channels."}
            </p>
          )}
          {projects.length > 0 && shownProjects.length === 0 && <p className="muted small">No projects match the filters.</p>}
          {shownProjects.map((p) => (
            <ProjectCard
              key={p.channel_id}
              project={p}
              busy={running.includes(`project:${p.channel_id}`)}
              taskStates={data.taskStates}
              selected={(shownProject ?? shownProjects[0]?.channel_id) === p.channel_id}
              unread={unread.has(p.channel_id)}
              reminders={data.reminders}
              blockerChecks={data.blockerChecks}
              onSelect={() => setShownProject(p.channel_id)}
              inlineDetails
              onViewTask={(id) => {
                revealTask(id);
                setTab("tasks");
              }}
              onChange={reload}
            />
          ))}
          <SuggestedProjects projects={data.projects.filter((p) => p.state === "suggested")} onChange={reload} />
          </div>
              </section>
              <section className="column detail-pane project-detail-pane">
                {(() => {
                  const project = shownProjects.find((p) => p.channel_id === shownProject) ?? shownProjects[0];
                  return project ? (
                    <>
                      <SeenWhileShown id={project.channel_id} unread={unread.has(project.channel_id)} onSeen={markSeen} />
                      <header className="column-header">
                        <h2>{projectName(project)}</h2>
                      </header>
                      <ProjectDetail project={project} onChange={reload} />
                    </>
                  ) : (
                    <p className="muted small">Pick a project to see its details.</p>
                  );
                })()}
              </section>
            </div>
          )}
        </div>
      </main>

      <Mist level={load.level} look={orbLook} />

      <WhyPrompt />
      {showChat && (
        <GlobalChat
          projects={data.projects}
          onClose={() => setShowChat(false)}
          onApplied={reload}
          onViewLearnings={() => {
            setShowChat(false);
            setSettingsLearnings(true);
            setShowSettings(true);
          }}
        />
      )}
      {simulateOnboarding && <Onboarding simulate onDone={() => setSimulateOnboarding(false)} />}
      {showOnboarding && (
        <Onboarding
          onDone={() => {
            setShowOnboarding(false);
            reload();
            refreshAll().catch(() => {});
          }}
        />
      )}
      {showSetup && (
        <SetupScreen
          onClose={() => setShowSetup(false)}
          onDone={() => {
            setShowSetup(false);
            reload();
            refreshAll().catch(() => {});
          }}
        />
      )}
      {showSettings && <Settings showLearnings={settingsLearnings} onOpenSetup={() => { setShowSettings(false); setShowSetup(true); }} onSimulateOnboarding={() => { setShowSettings(false); setSimulateOnboarding(true); }} projects={data.projects} theme={theme} onThemeChange={setTheme} orbLook={orbLook} onOrbLookChange={setOrbLook} onClose={() => { setShowSettings(false); setSettingsLearnings(false); }} onSaved={reload} />}
    </div>
  );
}

/**
 * The Detail view's areas, in the rail's order, each drawn like the layout icons (filled for the area
 * you're in, outlined for the others): Updates, one square split into three bands; Tasks, four small
 * squares making a larger one; Projects, a single square; Watched topics, a square split along its
 * diagonal. An area with something waiting on you has a dot at its top right.
 */
const DETAIL_TABS: { id: DetailTab; label: string; rects: Rect[]; paths?: string[] }[] = [
  {
    id: "updates",
    label: "Updates",
    rects: [
      [1, 1, 12, 3.6, 0.9],
      [1, 5.2, 12, 3.6, 0.9],
      [1, 9.4, 12, 3.6, 0.9],
    ],
  },
  {
    id: "tasks",
    label: "Tasks",
    rects: [
      [1, 1, 5.4, 5.4, 1],
      [7.6, 1, 5.4, 5.4, 1],
      [1, 7.6, 5.4, 5.4, 1],
      [7.6, 7.6, 5.4, 5.4, 1],
    ],
  },
  { id: "projects", label: "Projects", rects: [[1, 1, 12, 12, 1.6]] },
  {
    id: "watched",
    label: "Watched topics",
    rects: [],
    // A square with its top right corner cut off, the corner sitting apart as a small triangle.
    // A square split along its diagonal into two halves, every corner rounded, the cut's too.
    paths: ["M3 1H11.4Q13 1 13 2.6V11Q13 11.9 12.36 11.26L2.74 1.64Q2.1 1 3 1Z", "M1 3V11.4Q1 13 2.6 13H11Q11.9 13 11.26 12.36L1.64 2.74Q1 2.1 1 3Z"],
  },
];

type Rect = [x: number, y: number, w: number, h: number, r: number];

/**
 * A rail icon: filled for the area you're in; for the others, outlines drawn inside each block's
 * edge (inset by half the stroke), so neighboring blocks keep their gaps.
 */
function viewIcon(rects: Rect[], outlined: boolean, size = 14, paths: string[] = []) {
  // The outline is 1 screen pixel whatever size the icon is drawn at.
  const stroke = 14 / size;
  const inset = outlined ? stroke / 2 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      {rects.map(([x, y, w, h, r], i) => (
        <rect
          key={i}
          x={x + inset}
          y={y + inset}
          width={w - inset * 2}
          height={h - inset * 2}
          rx={r}
          fill={outlined ? "none" : "currentColor"}
          stroke={outlined ? "currentColor" : "none"}
          strokeWidth={stroke}
        />
      ))}
      {paths.map((d, i) => (
        // An outlined path is drawn a little smaller about the center, so its stroke stays inside like a rect's.
        <path
          key={`p${i}`}
          d={d}
          transform={outlined ? `translate(7 7) scale(${(12 - stroke) / 12}) translate(-7 -7)` : undefined}
          fill={outlined ? "none" : "currentColor"}
          stroke={outlined ? "currentColor" : "none"}
          strokeWidth={outlined ? stroke / ((12 - stroke) / 12) : 0}
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

/**
 * What can be refreshed on its own, from the bottom bar's menu: each area that used to have its own
 * refresh button. `jobs` are the keys of the jobs that refresh it (a prefix ending in ":" stands for
 * all of a kind), so it shows a spinner while they run.
 */
const REFRESH_AREAS: { label: string; jobs: string[]; run: () => Promise<unknown> }[] = [
  { label: "Calendar", jobs: ["calendar"], run: refreshCalendar },
  // Then your Claude Code sessions, matched against the tasks those found (whether or not Slack and
  // email could be read); any it adds are assessed.
  {
    label: "Tasks",
    jobs: ["adhoc", "assess", "sessions"],
    run: () =>
      Promise.allSettled([refreshAdhoc(), assessPendingTasks()])
        .then(() => scanClaudeSessions())
        .then((added) => (added.length ? assessPendingTasks() : undefined)),
  },
  { label: "Daily briefing", jobs: ["reading"], run: refreshReading },
  { label: "Watched topics", jobs: ["watch:"], run: checkWatchedTopics },
];

/**
 * The bottom bar's Refresh everything, or while anything loads, its line of text in its place. Its
 * own component, so the status streaming in re-renders this line alone, not the whole app. Pointing
 * at either opens a small menu above it: Everything, or one area on its own (see REFRESH_AREAS).
 */
function BottomStatus({ running }: { running: string[] }) {
  const allStatus = useJobStatus("all");
  /** What's loading: the running jobs' steps, taking turns. */
  const loadingStatus = useStatusFeed();
  // What's running in the background: chats show their own progress.
  const loading = running.filter((k) => !isChatJob(k));
  const isRunning = (job: string) => running.some((k) => (job.endsWith(":") ? k.startsWith(job) : k === job));
  return (
    <span className="refresh-menu-anchor">
      {loading.length === 0 ? (
        <RefreshButton busy={running.includes("all")} status={allStatus} title={`Refresh everything (${MOD}R)`} onClick={refreshAllSafely} />
      ) : (
        <span className="bottom-status small" title={loadingStatus}>
          <ScrambleText text={loadingStatus ? `${loadingStatus}…` : `${loading.filter((k) => k !== "all").length || 1} refreshing…`} />
        </span>
      )}
      <span className="card menu-card refresh-menu small" role="menu" aria-label="Refresh">
        <button role="menuitem" className="link-button small" disabled={running.includes("all")} onClick={refreshAllSafely}>
          {running.includes("all") && <Spinner />}
          Everything
          <Kbd keys={`${MOD}R`} />
        </button>
        {REFRESH_AREAS.map((area) => {
          const busy = area.jobs.some(isRunning);
          return (
            <button key={area.label} role="menuitem" className="link-button small" disabled={busy} onClick={() => area.run().catch(() => {})}>
              {busy && <Spinner />}
              {area.label}
            </button>
          );
        })}
      </span>
    </span>
  );
}
