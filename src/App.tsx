import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Mist } from "./components/Mist";
import { ProjectCard } from "./components/ProjectCard";
import { Settings } from "./components/Settings";
import { TaskColumn } from "./components/TaskColumn";
import { TodayColumn } from "./components/TodayColumn";
import { markInterruptedJobs } from "./db";
import { maybeRunMorning, refreshAll } from "./jobs";
import { compareProjects, pressure } from "./tasks";
import { useAppData, useRunningJobs } from "./useAppData";

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
  useScheduler();

  // Pick up anything written to the database while the window was in the background.
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  if (!data) return <div className="loading">Loading…</div>;

  const projects = data.projects
    .filter((p) => !p.hidden)
    .sort((a, b) => compareProjects({ name: a.name, status: a.snapshot?.status ?? null }, { name: b.name, status: b.snapshot?.status ?? null }));
  const counts = {
    blocked: projects.filter((p) => p.snapshot?.status === "blocked").length,
    at_risk: projects.filter((p) => p.snapshot?.status === "at_risk").length,
  };
  const refreshingAll = running.includes("all");
  const load = pressure(
    projects.map((p) => ({ status: p.snapshot?.status ?? null, tasks: p.snapshot?.my_tasks ?? [] })),
    data.adhoc.tasks,
    data.taskStates,
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="row">
          <h1>{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</h1>
          {counts.blocked > 0 && <span className="pill blocked">{counts.blocked} blocked</span>}
          {counts.at_risk > 0 && <span className="pill at_risk">{counts.at_risk} at risk</span>}
        </div>
        <div className="row">
          {running.length > 0 && <span className="muted small">{running.filter((k) => k !== "all").length} refreshing…</span>}
          <button className="primary" onClick={refreshAllSafely} disabled={refreshingAll} title="Refresh everything (⌘R)">
            {refreshingAll ? "Refreshing…" : "Refresh all"}
          </button>
          <button onClick={() => setShowSettings(true)}>Settings</button>
        </div>
      </header>

      <main className="columns">
        <TodayColumn pressure={load} calendar={data.calendar} taskStates={data.taskStates} busy={running.includes("calendar")} onChange={reload} />

        <section className="column projects-column">
          <header className="column-header">
            <h2>Projects</h2>
          </header>
          {projects.length === 0 && (
            <p className="muted small">
              {running.includes("discover") ? "Finding your #tmp- channels…" : "No projects yet. Refresh all to find your #tmp- channels."}
            </p>
          )}
          {projects.map((p) => (
            <ProjectCard
              key={p.channel_id}
              project={p}
              busy={running.includes(`project:${p.channel_id}`)}
              taskStates={data.taskStates}
              selected={filterProject === p.channel_id}
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
          running={running}
          onChange={reload}
        />
      </main>

      <Mist />

      {showSettings && <Settings projects={data.projects} onClose={() => setShowSettings(false)} onSaved={reload} />}
    </div>
  );
}
