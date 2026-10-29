import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { DailyReading } from "./components/DailyReading";
import { Mist } from "./components/Mist";
import { ProjectFilters, useProjectFilter } from "./components/TaskFilters";
import { ProjectCard } from "./components/ProjectCard";
import { Settings } from "./components/Settings";
import { TaskColumn } from "./components/TaskColumn";
import { TodayColumn } from "./components/TodayColumn";
import { markInterruptedJobs } from "./db";
import { maybeRunMorning, refreshAll } from "./jobs";
import { localDate } from "./scheduler";
import { compareProjects, matchesProjectFilter, myBlockingIds, pressure } from "./tasks";
import { isDark, useTheme } from "./theme";
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
      if (e.metaKey && e.key.toLowerCase() === "r") {
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

export default function App() {
  const { data, reload } = useAppData();
  const running = useRunningJobs();
  const [showSettings, setShowSettings] = useState(false);
  const [filterProject, setFilterProject] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
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
      { status: p.snapshot?.status ?? null, priority: p.snapshot?.priority?.level, taskIds: (p.snapshot?.my_tasks ?? []).map((t) => t.id) },
      projectFilter,
      recommended,
    ),
  );
  const load = pressure(
    projects.map((p) => ({
      status: p.snapshot?.status ?? null,
      priority: p.snapshot?.priority?.level,
      blockingIds: myBlockingIds(p.snapshot?.blockers, data.taskStates),
      tasks: p.snapshot?.my_tasks ?? [],
    })),
    data.adhoc.tasks,
    data.taskStates,
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="row">
          <h1>{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</h1>
          <span className="motto">Remember dear worker the orb sees all.</span>
        </div>
        <div className="row">
          {allStatus ? (
            <span className="muted small refresh-status">{allStatus}…</span>
          ) : (
            running.length > 0 && <span className="muted small">{running.filter((k) => k !== "all").length} refreshing…</span>
          )}
          <button className="primary" onClick={refreshAllSafely} disabled={refreshingAll} title="Refresh everything (⌘R)">
            {refreshingAll ? "Refreshing…" : "Refresh all"}
          </button>
          <button
            className="icon-button theme-toggle"
            onClick={() => setTheme(isDark(theme) ? "light" : "dark")}
            title={isDark(theme) ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={isDark(theme) ? "Switch to light mode" : "Switch to dark mode"}
          >
            {isDark(theme) ? "☀" : "☾"}
          </button>
          <button onClick={() => setShowSettings(true)}>Settings</button>
        </div>
      </header>

      <main className="columns">
        <TodayColumn pressure={load} calendar={data.calendar} taskStates={data.taskStates} busy={running.includes("calendar")} onChange={reload} />

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
              {counts.at_risk > 0 && <span className="pill at_risk">{counts.at_risk} at risk</span>}
            </div>
            <ProjectFilters filter={projectFilter} onChange={setProjectFilter} />
          </header>
          {projects.length === 0 && (
            <p className="muted small">
              {running.includes("discover") ? "Finding your #tmp- channels…" : "No projects yet. Refresh all to find your #tmp- channels."}
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
          running={running}
          onChange={reload}
        />
      </main>

      <Mist level={load.level} />

      {showSettings && <Settings projects={data.projects} theme={theme} onThemeChange={setTheme} onClose={() => setShowSettings(false)} onSaved={reload} />}
    </div>
  );
}
