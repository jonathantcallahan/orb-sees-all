import { getVersion } from "@tauri-apps/api/app";
import { setStandingNotes } from "../claude";
import { RELEASE_NOTES } from "../releaseNotes";
import { label, loadWhyLevel, recordCorrection, saveWhyLevel, type WhyLevel } from "../feedback";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as db from "../db";
import { discoverProjects } from "../jobs";
import { ORB_LOOK_NAMES, ORB_LOOKS } from "../orbLook";
import { activeChannels, channelLabel, projectName } from "../projects";
import { ago } from "../tasks";
import type { Theme } from "../theme";
import { CloseIcon, Reveal, Spinner } from "./common";
import type { OrbLook } from "./PressureBlob";

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** A small set of choices shown side by side, the picked one raised: for settings with two or three values. */
function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : undefined} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** An on/off switch: a checkbox drawn as a sliding toggle. */
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return <input type="checkbox" role="switch" className="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

/** One setting: its name and a line on what it does on the left, its control on the right. */
const SCOPE_LABEL: Record<string, string> = {
  global: "Everything",
  projects: "Projects",
  tasks: "Tasks",
  priority: "Priorities",
  plans: "Plans",
  writing: "Writing",
};

/** One learned lesson: where it applies, its text (click to reword, which makes it yours), and forget. */
function LessonRow({ lesson, projects, onChange }: { lesson: db.Lesson; projects: db.Project[]; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(lesson.text);
  const project = lesson.scope.startsWith("project:") ? projects.find((p) => `project:${p.channel_id}` === lesson.scope) : undefined;
  const scope = project ? projectName(project) : (SCOPE_LABEL[lesson.scope] ?? lesson.scope);
  const save = async () => {
    setEditing(false);
    if (text.trim() && text.trim() !== lesson.text) await db.saveLesson(lesson.id, text.trim());
    onChange();
  };
  return (
    <li className="small">
      <span className="lesson">
        <span className="lesson-scope">{scope}</span>
        {editing ? (
          <input
            className="lesson-edit"
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") {
                setText(lesson.text);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="lesson-text" onClick={() => setEditing(true)} title={lesson.origin === "user" ? "Yours" : `Learned from ${lesson.evidence.length} correction${lesson.evidence.length === 1 ? "" : "s"}`}>
            {lesson.text}
          </span>
        )}
      </span>
      <button
        className="icon-button"
        aria-label="Forget this"
        title="Forget this"
        onClick={async () => {
          await db.deleteLesson(lesson.id);
          onChange();
        }}
      >
        <CloseIcon />
      </button>
    </li>
  );
}

/** Settings > Release notes: the version you're on and what changed lately; older versions open on request. */
function ReleaseNotes() {
  const [version, setVersion] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);
  const date = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  // Notes for versions newer than this copy (written ahead of a release) wait until it's out.
  const newer = (a: string, b: string) => {
    const [x, y] = [a, b].map((v) => v.split(".").map(Number));
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    return false;
  };
  const released = version ? RELEASE_NOTES.filter((r) => !newer(r.version, version)) : RELEASE_NOTES;
  const recent = released.slice(0, 3);
  const rest = released.slice(3);
  const Version = ({ r }: { r: (typeof RELEASE_NOTES)[number] }) => (
    <div className="release">
      <div className="release-head">
        <span className="setting-label">{r.version}</span>
        <span className="timestamp">{date(r.date)}</span>
        {r.version === version && <span className="timestamp">· you're on this one</span>}
      </div>
      <ul className="release-notes">
        {r.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
  return (
    <section className="settings-section">
      <h4>Release notes</h4>
      <div className="settings-group">
        <div className="setting-row stacked">
          {recent.map((r) => (
            <Version key={r.version} r={r} />
          ))}
          {rest.length > 0 && (
            <>
              <Reveal open={older}>
                {rest.map((r) => (
                  <Version key={r.version} r={r} />
                ))}
              </Reveal>
              <button className="link-button small more-link release-more" onClick={() => setOlder(!older)}>
                {older ? "Show fewer" : "Earlier versions"}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/**
 * One project: shown or hidden, its channels, and (opened with Repos) the repos Orb reads for it
 * and a way to merge it into another project.
 */
function ProjectRow({ project, others, onSaved }: { project: db.Project; others: db.Project[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(project.local_repos.join("\n"));
  const [gh, setGh] = useState(project.gh_repos.join("\n"));
  const dirty = local !== project.local_repos.join("\n") || gh !== project.gh_repos.join("\n");
  const repoCount = project.local_repos.length + project.gh_repos.length;

  return (
    <div className={`settings-project${project.hidden ? " hidden" : ""}`}>
      <div className="settings-project-head">
        <div className="settings-project-name">
          <span>{projectName(project)}</span>
          {project.state === "suggested" && <span className="chip">Suggested</span>}
        </div>
        <button className={`filter-select${open ? " open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
          {repoCount ? `Repos · ${repoCount}` : "Repos"}
          <svg className="filter-chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden>
            <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <Switch
          label={`Show ${projectName(project)}`}
          checked={!project.hidden}
          onChange={async (on) => {
            await db.updateProjectConfig(project.channel_id, { hidden: !on, local_repos: project.local_repos, gh_repos: project.gh_repos });
            onSaved();
          }}
        />
      </div>
      <div className="settings-project-channels">
        {activeChannels(project).map((c) => (
          <span key={c.channel_id} className="chip">
            {channelLabel(c)}
            {c.role === "related" && (
              <button
                className="chip-remove"
                aria-label={`Unlink ${channelLabel(c)} from this project`}
                onClick={async () => {
                  await db.unlinkChannel(c.channel_id, project.channel_id);
                  onSaved();
                  recordCorrection(
                    { kind: "channel_unlink", subject: "project", subject_id: project.channel_id, project_id: project.channel_id, before: { channel: c.name, project: projectName(project) } },
                    label.unlink(c.name),
                  );
                }}
              >
                <CloseIcon size={7} />
              </button>
            )}
          </span>
        ))}
      </div>
      <Reveal open={open}>
        <div className="settings-project-body">
          <label className="field">
            <span className="field-label">Local repos</span>
            <textarea rows={2} value={local} onChange={(e) => setLocal(e.target.value)} placeholder="/Users/you/repo, one per line" />
          </label>
          <label className="field">
            <span className="field-label">GitHub repos</span>
            <textarea rows={2} value={gh} onChange={(e) => setGh(e.target.value)} placeholder="owner/repo, one per line" />
          </label>
          <div className="settings-project-actions">
            {others.length > 0 ? (
              <select
                className="filter-select"
                value=""
                aria-label="Merge into another project"
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
            ) : (
              <span />
            )}
            <button
              className="cta-primary"
              disabled={!dirty}
              onClick={async () => {
                await db.updateProjectConfig(project.channel_id, { hidden: project.hidden, local_repos: lines(local), gh_repos: lines(gh) });
                onSaved();
              }}
            >
              Save repos
            </button>
          </div>
        </div>
      </Reveal>
    </div>
  );
}

export function Settings({
  showLearnings = false,
  onOpenSetup,
  onSimulateOnboarding,
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
  /** Walks through onboarding's screens with made-up results, to see them; changes nothing. */
  onSimulateOnboarding: () => void;
  projects: db.Project[];
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  orbLook: OrbLook;
  onOrbLookChange: (look: OrbLook) => void;
  onClose: () => void;
  onSaved: () => void;
  /** Opened from the Demian chat's View learnings: scrolled to what Demian knows and has learned, unfolded. */
  showLearnings?: boolean;
}) {
  const [time, setTime] = useState("07:30");
  const [weekdaysOnly, setWeekdaysOnly] = useState(true);
  const [whyLevel, setWhyLevel] = useState<WhyLevel>(loadWhyLevel);
  const [model, setModel] = useState("opus");
  const [log, setLog] = useState<db.LogEntry[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [lessons, setLessons] = useState<db.Lesson[]>([]);
  const [lessonsOpen, setLessonsOpen] = useState(showLearnings);
  const learnings = useRef<HTMLDivElement>(null);
  // Once what Demian knows has loaded, bring it into view.
  useEffect(() => {
    if (showLearnings && (notes.length || lessons.length)) learnings.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [showLearnings, notes.length > 0 || lessons.length > 0]);
  const reloadLessons = () => db.listLessons().then(setLessons, () => {});

  useEffect(() => {
    (async () => {
      setTime((await db.getSetting("refresh_time")) ?? "07:30");
      setWeekdaysOnly(((await db.getSetting("weekdays_only")) ?? "1") === "1");
      setModel((await db.getSetting("model")) ?? "opus");
      setNotes(await db.getNotes());
      reloadLessons();
      setLog(await db.recentLog(30));
    })();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const weekCost = log
    .filter((l) => Date.now() - new Date(l.started_at).getTime() < 7 * 86_400_000)
    .reduce((sum, l) => sum + (l.cost_usd ?? 0), 0);

  const shown = projects.filter((p) => p.state !== "merged");
  // Rendered into <body> so nothing on the page can clip or offset it.
  return createPortal(
    <div className="modal-backdrop plan-modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>Settings</h2>
          <button className="icon-button" onClick={onClose} title="Close" aria-label="Close">
            <CloseIcon />
          </button>
        </header>

        <div className="settings-scroll">
          <section className="settings-section">
            <h4>Morning refresh</h4>
            <div className="settings-group">
              <SettingRow label="Refresh at" hint="Orb reads your channels, inbox and calendar then, and on launch if it missed it.">
                <input
                  type="time"
                  className="time-input"
                  value={time}
                  onChange={async (e) => {
                    setTime(e.target.value);
                    await db.setSetting("refresh_time", e.target.value);
                  }}
                />
              </SettingRow>
              <SettingRow label="Weekdays only" hint="Skip the morning refresh on Saturday and Sunday.">
                <Switch
                  label="Weekdays only"
                  checked={weekdaysOnly}
                  onChange={async (on) => {
                    setWeekdaysOnly(on);
                    await db.setSetting("weekdays_only", on ? "1" : "0");
                  }}
                />
              </SettingRow>
            </div>
          </section>

          <section className="settings-section">
            <h4>Look</h4>
            <div className="settings-group">
              <SettingRow label="Appearance">
                <Segmented
                  label="Appearance"
                  value={theme}
                  onChange={onThemeChange}
                  options={[
                    { value: "system", label: "Match macOS" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                />
              </SettingRow>
              <SettingRow label="Orb">
                <Segmented
                  label="Orb"
                  value={orbLook}
                  onChange={onOrbLookChange}
                  options={ORB_LOOKS.map((look) => ({ value: look, label: ORB_LOOK_NAMES[look] }))}
                />
              </SettingRow>
            </div>
          </section>

          <section className="settings-section">
            <h4>Claude</h4>
            <div className="settings-group">
              <SettingRow label="Model" hint={model === "opus" ? "Most accurate reads of your channels and tasks." : "Cheaper and faster, a little less careful."}>
                <Segmented
                  label="Model"
                  value={model}
                  onChange={async (m) => {
                    setModel(m);
                    await db.setSetting("model", m);
                  }}
                  options={[
                    { value: "opus", label: "Opus" },
                    { value: "sonnet", label: "Sonnet" },
                  ]}
                />
              </SettingRow>
              <SettingRow
                label="Ask why after a change"
                hint="After you change a task or project, Demian can ask why, so it learns the reason. Skipped ones it works out for itself."
              >
                <Segmented
                  label="Ask why after a change"
                  value={whyLevel}
                  onChange={(level) => {
                    setWhyLevel(level);
                    saveWhyLevel(level);
                  }}
                  options={[
                    { value: "always", label: "Always" },
                    { value: "less", label: "Less often" },
                    { value: "rarely", label: "Rarely" },
                    { value: "never", label: "Never" },
                  ]}
                />
              </SettingRow>
              <div ref={learnings} />
              {notes.length > 0 && (
                <div className="setting-row stacked">
                  <div className="setting-text">
                    <span className="setting-label">What Demian knows</span>
                    <span className="setting-hint">Corrections you gave in the chat. Every refresh takes them into account.</span>
                  </div>
                  <ul className="notes-list">
                    {notes.map((note, i) => (
                      <li key={i} className="small">
                        <span>{note}</span>
                        <button
                          className="icon-button"
                          aria-label="Forget this"
                          title="Forget this"
                          onClick={async () => {
                            const next = notes.filter((_, j) => j !== i);
                            setNotes(next);
                            setStandingNotes(next);
                            await db.saveNotes(next);
                          }}
                        >
                          <CloseIcon />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {lessons.length > 0 && (
                <div className="setting-row stacked">
                  <button className="setting-text setting-toggle" onClick={() => setLessonsOpen(!lessonsOpen)} aria-expanded={lessonsOpen}>
                    <span className="setting-label">
                      What Demian has learned <span className="timestamp">{lessons.length}</span>
                      <svg className={`disclosure${lessonsOpen ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                        <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span className="setting-hint">Lessons from your corrections, used in every refresh, plan and message. Click one to reword it.</span>
                  </button>
                  <Reveal open={lessonsOpen}>
                    <ul className="notes-list">
                      {lessons.map((l) => (
                        <LessonRow key={l.id} lesson={l} projects={projects} onChange={reloadLessons} />
                      ))}
                    </ul>
                  </Reveal>
                </div>
              )}
              <SettingRow label="Setup" hint="Check Claude Code and your connectors to Slack, Gmail, Calendar and Jira.">
                <button className="cta-ghost" onClick={onOpenSetup}>
                  Check setup
                </button>
              </SettingRow>
            </div>
          </section>

          <ReleaseNotes />

          <section className="settings-section">
            <div className="settings-section-head">
              <h4>Projects</h4>
              <button
                className="cta-ghost"
                disabled={discovering}
                onClick={async () => {
                  setDiscovering(true);
                  await discoverProjects().catch(() => {});
                  setDiscovering(false);
                  onSaved();
                }}
              >
                {discovering ? (
                  <span title="Finding channels…" aria-label="Finding channels">
                    <Spinner />
                  </span>
                ) : (
                  "Find project channels"
                )}
              </button>
            </div>
            <div className="settings-group">
              {shown.length === 0 && <div className="setting-row muted small">No projects yet. Find project channels to look for your #tmp channels.</div>}
              {shown.map((p) => (
                <ProjectRow
                  key={`${p.channel_id}:${p.hidden}:${p.local_repos}:${p.gh_repos}`}
                  project={p}
                  others={projects.filter((o) => o.channel_id !== p.channel_id && o.state === "tracked")}
                  onSaved={onSaved}
                />
              ))}
            </div>
          </section>

          <section className="settings-section">
            <button className="settings-section-head settings-toggle" onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>
              <h4>Recent refreshes</h4>
              <span className="timestamp small">${weekCost.toFixed(2)} in the last 7 days</span>
              <svg className={`filter-chevron${showLog ? " up" : ""}`} width="8" height="8" viewBox="0 0 8 8" aria-hidden>
                <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <Reveal open={showLog}>
              <div className="settings-group">
                {log.length === 0 && <div className="setting-row muted small">Nothing yet.</div>}
                {log.map((l) => (
                  <div key={l.id} className="log-row small">
                    <span className={`log-dot ${l.status}`} aria-label={l.status} />
                    <span className="log-job">
                      {l.job}
                      {l.scope && <span className="muted"> · {projects.find((p) => p.channel_id === l.scope)?.name ?? l.scope}</span>}
                      {l.error && <span className="log-error">{l.error}</span>}
                    </span>
                    <span className="timestamp">{l.cost_usd != null && `$${l.cost_usd.toFixed(2)}`}</span>
                    <span className="timestamp log-time">{ago(l.started_at)}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </section>

          <section className="settings-section">
            <div className="settings-group">
              <SettingRow label="Simulate onboarding" hint="Walk through the first-run screens as a new user sees them: each step missing in turn, then passing. Nothing is installed or changed.">
                <button className="cta-ghost" onClick={onSimulateOnboarding}>
                  Simulate
                </button>
              </SettingRow>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
