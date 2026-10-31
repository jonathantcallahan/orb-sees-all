import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { RefreshButton } from "./components/common";
import { DailyReading } from "./components/DailyReading";
import { Mist } from "./components/Mist";
import { ProjectFilters, useProjectFilter } from "./components/TaskFilters";
import { SuggestedProjects } from "./components/SuggestedProjects";
import { UpdateButton } from "./components/UpdateButton";
import { WindowButtons } from "./components/WindowButtons";
import { SetupScreen } from "./components/SetupScreen";
import { isWindows, MOD } from "./platform";
import { ProjectCard } from "./components/ProjectCard";
import { Settings } from "./components/Settings";
import { TaskColumn } from "./components/TaskColumn";
import { TodayColumn } from "./components/TodayColumn";
import { getSetting, markInterruptedJobs, setSetting } from "./db";
import { maybeRunMorning, refreshAll } from "./jobs";
import { localDate } from "./scheduler";
import { compareProjects, matchesProjectFilter, myBlockingIds, pressure, PRIORITY_RANK, taskPriority, type PressureTask } from "./tasks";
import { canonicalId } from "./registry";
import { useTheme } from "./theme";
import { useOrbLook } from "./orbLook";
import { setUserProfile } from "./prompts";
import { OrbGlow } from "./components/PressureBlob";
import { useAppData, useJobStatus, useRunningJobs } from "./useAppData";

const refreshAllSafely = () => refreshAll().catch(() => {});

function useScheduler() {
  useEffect(() => {
    const check = () => maybeRunMorning().catch(() => {});
    markInterruptedJobs().then(check, check);
    // The Rust side emits a tick every minute, which reaches the webview even
    // while the window is hidden; the interval and focus check are backups.
    const interval = setInterval(check, 60_000);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    const unlisteners = [listen("scheduler-tick", check), listen("tray-refresh-all", refreshAllSafely)];
    const onKey = (e: KeyboardEvent) => {
      if ((isWindows ? e.ctrlKey : e.metaKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        refreshAllSafely();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("keydown", onKey);
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, []);
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
  const [showSetup, setShowSetup] = useState(false);
  // First run: walk through setup until it's done. Anyone already using the app (it knows their
  // Slack user) counts as set up.
  useEffect(() => {
    Promise.all([getSetting("setup_done"), getSetting("slack_user_id")]).then(([done, user]) => {
      if (done || user) setSetting("setup_done", "1").catch(() => {});
      else setShowSetup(true);
    }, () => {});
  }, []);
  const [filterProject, setFilterProject] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  const [orbLook, setOrbLook] = useOrbLook();
  // Who you are, for the prompts (Settings > About you).
  useEffect(() => {
    getSetting("user_profile").then(setUserProfile, () => {});
  }, []);
  const allStatus = useJobStatus("all");
  const [projectFilter, setProjectFilter] = useProjectFilter();
  useScheduler();

  // Pick up anything written to the database while the window was in the background.
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  if (!data) return <div className="loading">Loading…</div>;

  const projects = data.projects
    .filter((p) => !p.hidden)
    .sort((a, b) =>
      compareProjects(
        { name: a.name, status: a.snapshot?.status ?? null, priority: a.snapshot?.priority?.level },
        { name: b.name, status: b.snapshot?.status ?? null, priority: b.snapshot?.priority?.level },
      ),
    );
  const counts = {
    blocked: projects.filter((p) => p.snapshot?.status === "blocked").length,
    at_risk: projects.filter((p) => p.snapshot?.status === "at_risk").length,
  };
  const refreshingAll = running.includes("all");
  const recommended = new Set(data.reading?.date === localDate(new Date()) ? (data.reading.recommended ?? []) : []);
  const shownProjects = projects.filter((p) =>
    matchesProjectFilter(
      { status: p.snapshot?.status ?? null, priority: p.snapshot?.priority?.level, role: p.snapshot?.raci?.role },
      projectFilter,
    ),
  );
  // Every open task the user owns, at the priority its card shows, so the orb weighs what you see.
  // The same work from several sources counts once, under its canonical id, at its highest priority.
  const load = pressure(
    onePerTask([
      ...projects.flatMap((p) => {
        const blocking = new Set(myBlockingIds(p.snapshot?.blockers, data.taskStates));
        return (p.snapshot?.my_tasks ?? []).map((t) => ({
          id: t.id,
          due: t.due,
          projectId: p.channel_id,
          priority: taskPriority(t.assessment?.priority, p.snapshot?.priority?.level, blocking.has(t.id), data.priorityOverrides[t.id]),
        }));
      }),
      ...data.adhoc.tasks.map((t) => ({
        id: t.id,
        due: t.due,
        priority: taskPriority(t.assessment?.priority, null, false, data.priorityOverrides[t.id]),
      })),
      ...data.manual.map((t) => ({
        id: t.id,
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
        <RefreshButton busy={refreshingAll} status={allStatus} title={`Refresh everything (${MOD}R)`} onClick={refreshAllSafely} />
        {!allStatus && running.length > 0 && <span className="timestamp small">{running.filter((k) => k !== "all").length} refreshing…</span>}
        <UpdateButton />
      </nav>

      <main className="columns">
        <OrbGlow look={orbLook} level={load.level} />
        <TodayColumn pressure={load} orbLook={orbLook} working={running.length > 0} calendar={data.calendar} taskStates={data.taskStates} busy={running.includes("calendar")} onChange={reload} />

        <section className="column projects-column">
          <DailyReading
            reading={data.reading}
            projects={data.projects}
            news={data.adhoc.news}
            states={data.taskStates}
            busy={running.includes("reading")}
            onChange={reload}
          />
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
              selected={filterProject === p.channel_id}
              reminders={data.reminders}
              blockerChecks={data.blockerChecks}
              onSelect={() => setFilterProject((cur) => (cur === p.channel_id ? null : p.channel_id))}
              onChange={reload}
            />
          ))}
          <SuggestedProjects projects={data.projects.filter((p) => p.state === "suggested")} onChange={reload} />
          </div>
        </section>

        <TaskColumn
          adhoc={data.adhoc}
          manual={data.manual}
          projects={projects}
          filterProject={projects.find((p) => p.channel_id === filterProject) ?? null}
          onClearFilter={() => setFilterProject(null)}
          taskStates={data.taskStates}
          plans={data.plans}
          assessments={data.assessments}
          drafts={data.drafts}
          recommended={recommended}
          descriptionOverrides={data.descriptionOverrides}
          taskChecks={data.taskChecks}
          sessionLinks={data.sessionLinks}
          priorityOverrides={data.priorityOverrides}
          taskAliases={data.taskAliases}
          refinedDescriptions={data.refinedDescriptions}
          notDuplicates={data.notDuplicates}
          running={running}
          onChange={reload}
        />
      </main>

      <Mist level={load.level} look={orbLook} />

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
      {showSettings && <Settings onOpenSetup={() => { setShowSettings(false); setShowSetup(true); }} projects={data.projects} theme={theme} onThemeChange={setTheme} orbLook={orbLook} onOrbLookChange={setOrbLook} onClose={() => setShowSettings(false)} onSaved={reload} />}
    </div>
  );
}
