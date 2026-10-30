import { setUserProfile } from "../prompts";
import { useEffect, useState } from "react";
import * as db from "../db";
import { discoverProjects } from "../jobs";
import { activeChannels, projectName } from "../projects";
import type { Theme } from "../theme";
import type { OrbLook } from "./PressureBlob";

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function ProjectRow({ project, others, onSaved }: { project: db.Project; others: db.Project[]; onSaved: () => void }) {
  const [hidden, setHidden] = useState(project.hidden);
  const [local, setLocal] = useState(project.local_repos.join("\n"));
  const [gh, setGh] = useState(project.gh_repos.join("\n"));
  const dirty =
    hidden !== project.hidden || local !== project.local_repos.join("\n") || gh !== project.gh_repos.join("\n");

  return (
    <tr className={hidden ? "muted" : undefined}>
      <td>
        <label className="row">
          <input type="checkbox" checked={!hidden} onChange={(e) => setHidden(!e.target.checked)} />
          {projectName(project)}
          {project.state === "suggested" && <span className="chip">Suggested</span>}
        </label>
        <div className="project-channel-list small">
          {activeChannels(project).map((c) => (
            <span key={c.channel_id} className="chip" title={c.reason ?? undefined}>
              #{c.name}
              {c.role === "related" && (
                <button
                  className="link-button muted"
                  title={`Unlink #${c.name} from this project`}
                  onClick={async () => {
                    await db.unlinkChannel(c.channel_id);
                    onSaved();
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {others.length > 0 && (
          <select
            className="small"
            value=""
            title="Fold this project into another one; its channels and tasks move there"
            onChange={async (e) => {
              if (!e.target.value) return;
              await db.mergeProject(project.channel_id, e.target.value);
              onSaved();
            }}
          >
            <option value="">Merge into…</option>
            {others.map((o) => (
              <option key={o.channel_id} value={o.channel_id}>
                {projectName(o)}
              </option>
            ))}
          </select>
        )}
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
  onOpenSetup,
  projects,
  theme,
  onThemeChange,
  orbLook,
  onOrbLookChange,
  onClose,
  onSaved,
}: {
  /** Opens the setup checklist, to check Claude Code and the connectors again. */
  onOpenSetup: () => void;
  projects: db.Project[];
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  orbLook: OrbLook;
  onOrbLookChange: (look: OrbLook) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [time, setTime] = useState("07:30");
  const [weekdaysOnly, setWeekdaysOnly] = useState(true);
  const [model, setModel] = useState("opus");
  const [about, setAbout] = useState("");
  const [log, setLog] = useState<db.LogEntry[]>([]);
  const [discovering, setDiscovering] = useState(false);

  useEffect(() => {
    (async () => {
      setTime((await db.getSetting("refresh_time")) ?? "07:30");
      setWeekdaysOnly(((await db.getSetting("weekdays_only")) ?? "1") === "1");
      setModel((await db.getSetting("model")) ?? "opus");
      setAbout((await db.getSetting("user_profile")) ?? "");
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
          <div className="row">
            <button className="cta-ghost" onClick={onOpenSetup} title="Check Claude Code and your connectors">
              Check setup
            </button>
            <button onClick={onClose}>Done</button>
          </div>
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
          <label className="about-you">
            About you
            <textarea
              rows={2}
              value={about}
              placeholder="e.g. a product manager on the payments team"
              onChange={(e) => setAbout(e.target.value)}
              onBlur={async () => {
                await db.setSetting("user_profile", about.trim());
                setUserProfile(about);
              }}
            />
            <span className="muted small">How Claude describes you when it reads your channels and plans your work.</span>
          </label>
          <label>
            Orb look
            <select value={orbLook} onChange={(e) => onOrbLookChange(e.target.value as OrbLook)}>
              <option value="classic">Classic</option>
              <option value="glass">Glass: molten metal in frosted glass</option>
              <option value="iridescent">Iridescent: a liquid holographic bubble</option>
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
            {discovering ? "Finding project channels…" : "Find project channels"}
          </button>
        </header>
        <table className="projects-table">
          <thead>
            <tr>
              <th>Project (shown) and channels</th>
              <th>Local repos</th>
              <th>GitHub repos</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {projects
              .filter((p) => p.state !== "merged")
              .map((p) => (
                <ProjectRow
                  key={`${p.channel_id}:${p.hidden}:${p.local_repos}:${p.gh_repos}`}
                  project={p}
                  others={projects.filter((o) => o.channel_id !== p.channel_id && o.state === "tracked")}
                  onSaved={onSaved}
                />
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
