import { useEffect, useState } from "react";
import * as db from "../db";
import { discoverProjects } from "../jobs";
import type { Theme } from "../theme";

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function ProjectRow({ project, onSaved }: { project: db.Project; onSaved: () => void }) {
  const [hidden, setHidden] = useState(project.hidden);
  const [local, setLocal] = useState(project.local_repos.join("\n"));
  const [gh, setGh] = useState(project.gh_repos.join("\n"));
  const dirty =
    hidden !== project.hidden || local !== project.local_repos.join("\n") || gh !== project.gh_repos.join("\n");

  return (
    <tr className={hidden ? "muted" : undefined}>
      <td>
        <label className="row">
          <input type="checkbox" checked={!hidden} onChange={(e) => setHidden(!e.target.checked)} />#{project.name}
        </label>
      </td>
      <td>
        <textarea rows={2} value={local} onChange={(e) => setLocal(e.target.value)} placeholder="/Users/you/repo (one per line)" />
      </td>
      <td>
        <textarea rows={2} value={gh} onChange={(e) => setGh(e.target.value)} placeholder="owner/repo (one per line)" />
      </td>
      <td>
        <button
          disabled={!dirty}
          onClick={async () => {
            await db.updateProjectConfig(project.channel_id, { hidden, local_repos: lines(local), gh_repos: lines(gh) });
            onSaved();
          }}
        >
          Save
        </button>
      </td>
    </tr>
  );
}

export function Settings({
  projects,
  theme,
  onThemeChange,
  onClose,
  onSaved,
}: {
  projects: db.Project[];
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [time, setTime] = useState("07:30");
  const [weekdaysOnly, setWeekdaysOnly] = useState(true);
  const [model, setModel] = useState("opus");
  const [log, setLog] = useState<db.LogEntry[]>([]);
  const [discovering, setDiscovering] = useState(false);

  useEffect(() => {
    (async () => {
      setTime((await db.getSetting("refresh_time")) ?? "07:30");
      setWeekdaysOnly(((await db.getSetting("weekdays_only")) ?? "1") === "1");
      setModel((await db.getSetting("model")) ?? "opus");
      setLog(await db.recentLog(30));
    })();
  }, []);

  const weekCost = log
    .filter((l) => Date.now() - new Date(l.started_at).getTime() < 7 * 86_400_000)
    .reduce((sum, l) => sum + (l.cost_usd ?? 0), 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="column-header">
          <h2>Settings</h2>
          <button onClick={onClose}>Done</button>
        </header>

        <section className="settings-grid">
          <label>
            Morning refresh
            <input
              type="time"
              value={time}
              onChange={async (e) => {
                setTime(e.target.value);
                await db.setSetting("refresh_time", e.target.value);
              }}
            />
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={weekdaysOnly}
              onChange={async (e) => {
                setWeekdaysOnly(e.target.checked);
                await db.setSetting("weekdays_only", e.target.checked ? "1" : "0");
              }}
            />
            Weekdays only
          </label>
          <label>
            Appearance
            <select value={theme} onChange={(e) => onThemeChange(e.target.value as Theme)}>
              <option value="system">Match macOS</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Model
            <select
              value={model}
              onChange={async (e) => {
                setModel(e.target.value);
                await db.setSetting("model", e.target.value);
              }}
            >
              <option value="opus">Opus (most accurate)</option>
              <option value="sonnet">Sonnet (cheaper, faster)</option>
            </select>
          </label>
        </section>

        <header className="column-header">
          <h3>Projects</h3>
          <button
            disabled={discovering}
            onClick={async () => {
              setDiscovering(true);
              await discoverProjects().catch(() => {});
              setDiscovering(false);
              onSaved();
            }}
          >
            {discovering ? "Finding channels…" : "Find #tmp- channels"}
          </button>
        </header>
        <table className="projects-table">
          <thead>
            <tr>
              <th>Channel (shown)</th>
              <th>Local repos</th>
              <th>GitHub repos</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <ProjectRow key={`${p.channel_id}:${p.hidden}:${p.local_repos}:${p.gh_repos}`} project={p} onSaved={onSaved} />
            ))}
          </tbody>
        </table>

        <h3>Recent refreshes · ${weekCost.toFixed(2)} in the last 7 days</h3>
        <table className="log-table small">
          <tbody>
            {log.map((l) => (
              <tr key={l.id} className={l.status === "error" ? "error" : undefined}>
                <td>{new Date(l.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                <td>
                  {l.job}
                  {l.scope && ` ${projects.find((p) => p.channel_id === l.scope)?.name ?? l.scope}`}
                </td>
                <td>{l.status}</td>
                <td>{l.cost_usd != null && `$${l.cost_usd.toFixed(2)}`}</td>
                <td className="log-error">{l.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
