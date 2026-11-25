import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as db from "../db";
import { dataVersion, loadEpicChildren, loadIssuesByKey, loadSprintEpics } from "../jobs";
import { useJobStatus } from "../useAppData";
import type { SprintChoice } from "../schema";
import { jiraConnection, useJiraDirect } from "../jira";
import { burndown, type BurndownUnit, DIRECT_STALE_MS, dueText, epicBurndown, EPICS_PROJECT_SETTING, PERSON, type Chart, epicProgress, isGathered, isStale, leftAt, listStoreKey, oldRead, orderEpics, personEpic, personKey, projectKeyFrom, splitIssues, sprintDates, sprintKey, sprintNumber, sprintPeople, STALE_MS, UNAFFILIATED, unaffiliatedEpic, type SprintEpic } from "../sprintEpics";
import { CloseIcon, Disclosure, FoldLabel, HoverTip, RefreshButton, Reveal, Segmented, updatedText } from "./common";
import { Avatar } from "./People";
import { InDock } from "./chatDock";
import { JiraKey } from "./JiraIcons";
import { epicPoints, OVERLOAD_POINTS, pointsOf, pointsTally, sizeOf } from "../sizes";
import { SprintChat, type SprintChatAbout } from "./SprintChat";
import { epicChatKey, personChatKey, sprintsChatKey } from "../sprintChat";

/** Which sprint is shown, which epic is open, and whether the Team is folded away, remembered between launches. */
const CHOICE_KEY = "epics:sprint";
const OPEN_KEY = "epics:open";
const TEAM_KEY = "epics:team-open";
/** What the burndown counts: "tickets" or "points". */
const UNIT_KEY = "epics:burndown-unit";
/** Whether an epic's issues in the sprint, and the rest of them, are folded away: "0" when they are. */
const GROUP_KEY = { sprint: "epics:issues-sprint-open", rest: "epics:issues-rest-open" } as const;

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage refused: it's forgotten at the next launch.
  }
}

const SPRINT_CHOICES: { value: SprintChoice; label: string }[] = [
  { value: "current", label: "Current sprint" },
  { value: "upcoming", label: "Upcoming sprint" },
];

/**
 * The Epics area: one Jira project's current or upcoming sprint, by epic. The sprint's burndown at the
 * top of the left column, then the epics with work in the sprint, the most open work first, and last
 * Unaffiliated, the sprint's issues that aren't in an epic; clicking one shows all of its issues on the
 * right, those in the sprint first, with who each is assigned to. An epic isn't in a sprint itself: its
 * issues are.
 *
 * What it reads is kept, and read again when it's an hour old as you open it (and with Refresh
 * everything, or Epics in Refresh's menu). The project is set here, by its key.
 */
export function EpicsArea({ running }: { running: string[] }) {
  const version = useSyncExternalStore(dataVersion.subscribe, dataVersion.get);
  // Undefined until the setting is read.
  const [project, setProject] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [which, setWhich] = useState<SprintChoice>(() => (remembered(CHOICE_KEY) === "upcoming" ? "upcoming" : "current"));
  const [open, setOpen] = useState<string | null>(() => remembered(OPEN_KEY));
  const [stored, setStored] = useState<{ sprints: Record<string, db.StoredSprintEpics>; children: Record<string, db.StoredEpicChildren> } | null>(null);
  // Why a read failed, by job key, until it's tried again.
  const [failed, setFailed] = useState<Record<string, string>>({});
  // Reads started since the area opened, so a failed one isn't started over and over.
  const tried = useRef(new Set<string>());

  useEffect(() => {
    db.getSetting(EPICS_PROJECT_SETTING).then((p) => setProject(p || null), () => setProject(null));
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([db.getSprintEpics(), db.getEpicChildren()]).then(([sprints, children]) => live && setStored({ sprints, children }));
    return () => {
      live = false;
    };
  }, [version]);

  const choose = (c: SprintChoice) => {
    setWhich(c);
    remember(CHOICE_KEY, c);
  };
  const openEpic = (key: string | null) => {
    setOpen(key);
    remember(OPEN_KEY, key);
  };
  // The area's own chat, about the project's sprints, filling the right column while it's open.
  const [areaChat, setAreaChat] = useState(false);
  /** Shows an epic's (or a person's) issues on the right, in the area chat's place. */
  const select = (key: string) => {
    openEpic(key);
    setAreaChat(false);
  };
  const setProjectKey = async (key: string) => {
    await db.setSetting(EPICS_PROJECT_SETTING, key);
    if (key !== project) {
      openEpic(null);
      setAreaChat(false);
    }
    setProject(key);
    setEditing(false);
  };

  /** Starts a read (job is its key), noting why it failed. */
  const read = (job: string, run: () => Promise<void>) => {
    tried.current.add(job);
    setFailed((f) => {
      const next = { ...f };
      delete next[job];
      return next;
    });
    run().catch((e: Error) => setFailed((f) => ({ ...f, [job]: e.message })));
  };

  const key = project ? sprintKey(project, which) : null;
  const sprintJob = key ? `sprint:${key}` : "";
  const sprint = key ? stored?.sprints[key] : undefined;
  const readingSprint = !!key && running.includes(sprintJob);
  const epics = orderEpics(sprint?.epics ?? []);
  const stray = unaffiliatedEpic(sprint);
  const listed = stray ? [...epics, stray] : epics;
  // An epic, Unaffiliated, or a person's issues (clicked under the burndown).
  const shown = listed.find((e) => e.key === open) ?? (open ? personEpic(sprint, open) : null);
  const shownKey = shown && project ? listStoreKey(project, which, shown.key) : null;
  const epicJob = shownKey ? `epic:${shownKey}` : "";
  const children = shownKey ? stored?.children[shownKey] : undefined;
  // Its chat, under its issues: an epic's, or a person's (not Unaffiliated's).
  const [chatOpen, setChatOpen] = useState(false);
  const chatAbout: SprintChatAbout | null =
    !shown || !project
      ? null
      : shown.key.startsWith(PERSON)
        ? { kind: "person", name: shown.key.slice(PERSON.length) || null, project }
        : isGathered(shown.key)
          ? null
          : { kind: "epic", epic: shown.key, title: shown.title };
  const chatKey = chatAbout ? (chatAbout.kind === "epic" ? epicChatKey(chatAbout.epic) : personChatKey(chatAbout.project, chatAbout.name)) : null;
  const chatting = chatOpen && !!chatKey;
  const readShown = () => {
    if (!shown || !shownKey || !project) return;
    read(epicJob, () => (isGathered(shown.key) ? loadIssuesByKey(shownKey, shown.issues.map((i) => i.key), project) : loadEpicChildren(shown.key, project)));
  };

  // Whether Demian reads Jira itself: then what's shown is read again after minutes, not an hour.
  const direct = useJiraDirect();
  useEffect(() => {
    jiraConnection().catch(() => {});
  }, []);
  const stale = (at: string | undefined) => isStale(at, Date.now(), direct ? DIRECT_STALE_MS : STALE_MS);

  // The sprint shown is read when it hasn't been, or is an hour old (minutes, read directly); the open epic's issues too.
  useEffect(() => {
    if (!stored || !project || !key || tried.current.has(sprintJob) || readingSprint) return;
    if (stale(sprint?.at) || oldRead(sprint)) read(sprintJob, () => loadSprintEpics(project, which));
  }, [stored, project, which, direct]);
  useEffect(() => {
    if (!stored || !shown || tried.current.has(epicJob) || running.includes(epicJob)) return;
    // Unaffiliated's and a person's are read again, too, when the sprint has one their last read didn't.
    const missing = isGathered(shown.key) && !!children && shown.issues.some((i) => !children.issues.some((c) => c.key === i.key));
    // And an epic's read before each issue's dates were kept, for its burndown.
    const undated = !!children && !children.error && children.issues.some((i) => i.created === undefined);
    // Or before each issue's type, due date and size were kept, for its card.
    const untyped = !!children && !children.error && children.issues.some((i) => i.type === undefined || i.due === undefined || i.size === undefined);
    // Or with sizes from another field than the sprint's (read before it was found, or a wrong one).
    const resized = !!sprint?.size_field && !!children && !children.error && children.size_field !== sprint.size_field;
    if (stale(children?.at) || missing || undated || untyped || resized) readShown();
  }, [stored, shownKey, direct]);

  if (project === undefined) return null;
  // The burndown, in tickets and in points: the selected epic's over its life (once its issues are read
  // with their dates), or the selected person's or Unaffiliated's issues in the sprint, or else the whole
  // sprint's. Both from the same issues, so switching between them keeps what's charted.
  const epicIssues = shown && !isGathered(shown.key) ? (children?.error ? [] : (children?.issues ?? [])) : null;
  const epicChart = epicIssues && shown ? epicBurndown(epicIssues, shown.due) : null;
  const only = shown?.issues.length ? shown.issues : undefined;
  const charts = {
    tickets: epicChart ?? burndown(sprint, undefined, only),
    points: epicChart ? epicBurndown(epicIssues!, shown!.due, undefined, "points") : burndown(sprint, undefined, only, "points"),
  };
  // Each sprint's number in its choice, in gray ("Current sprint 24"), once it's been read.
  const choices = SPRINT_CHOICES.map((c) => {
    const n = project ? sprintNumber(stored?.sprints[sprintKey(project, c.value)]?.sprint?.name) : null;
    return { value: c.value, label: n ? <>{c.label} <span className="segmented-note">{n}</span></> : c.label };
  });
  // Under it, only what the burndown doesn't say: the dates of a sprint without one (the upcoming), or that there's no such sprint.
  const sprintLine = !sprint
    ? null
    : sprint.sprint
      ? burndown(sprint)
        ? null
        : sprintDates(sprint.sprint.start, sprint.sprint.end)
      : which === "current"
        ? "No sprint under way"
        : "No upcoming sprint planned yet";
  return (
    <div className="detail-split epics-split">
      <section className="column detail-pane epics-pane">
        <header className="column-header epics-head">
          <div className="title-line">
            <h2>Epics</h2>
            {project && !editing && (
              <button className="link-button small epics-project" title="Change the Jira project" onClick={() => setEditing(true)}>
                {project}
              </button>
            )}
            {project && !editing && (
              <button
                className={`project-chat-button epics-chat-button${areaChat ? " on" : ""}`}
                aria-pressed={areaChat}
                aria-label={areaChat ? "Close the Epics chat" : "Chat about the sprints"}
                onClick={() => setAreaChat(!areaChat)}
              >
                Chat
              </button>
            )}
          </div>
          {project && !editing && <Segmented label="Sprint" value={which} options={choices} onChange={choose} />}
        </header>
        {!project || editing ? (
          <ProjectForm initial={project} onSave={setProjectKey} onCancel={project ? () => setEditing(false) : undefined} />
        ) : (
          <>
            {/* What's being read shows in the bar along the bottom, as everywhere but the chat. */}
            {sprintLine && <p className="small muted epics-sprint-line">{sprintLine}</p>}
            {(failed[sprintJob] || sprint?.error) && !readingSprint && (
              <p className="error small">
                Couldn't read the sprint: {failed[sprintJob] ?? sprint?.error}{" "}
                <button className="link-button small" onClick={() => read(sprintJob, () => loadSprintEpics(project, which))}>
                  Try again
                </button>
              </p>
            )}
            <Burndown tickets={charts.tickets} points={charts.points} />
            <SprintPeople sprint={sprint} open={open} onSelect={select} />
            <div className="project-list epics-list">
              {sprint?.sprint && listed.length === 0 && !sprint.error && <p className="muted small">No epics have work in this sprint.</p>}
              {listed.map((e) => (
                <EpicRow
                  key={e.key}
                  epic={e}
                  issues={e.key === UNAFFILIATED ? undefined : stored?.children[e.key]}
                  sizes={!!sprint?.size_field}
                  selected={e.key === shown?.key}
                  onSelect={() => select(e.key)}
                />
              ))}
            </div>
          </>
        )}
      </section>
      {/* The area's chat, filling the column while it's open (as a project's TDD chat does). Else the
          shown epic's issues, and while its chat is open, that chat in the column's bottom two fifths. */}
      {areaChat && project && !editing ? (
        <section className="detail-pane chat-dock">
          <InDock>
            <SprintChat key={sprintsChatKey(project)} chatKey={sprintsChatKey(project)} about={{ kind: "sprints", project }} onClose={() => setAreaChat(false)} />
          </InDock>
        </section>
      ) : (
        <div className={`project-pane epic-pane${chatting ? " with-chat" : ""}`}>
          <section className="column detail-pane epic-issues-pane">
            {shown ? (
              <EpicIssues
                epic={shown}
                epics={sprint?.epics ?? []}
                job={epicJob}
                sprintName={sprint?.sprint?.name ?? null}
                read={children}
                reading={running.includes(epicJob)}
                failed={failed[epicJob]}
                onRead={readShown}
                chat={chatKey ? { on: chatting, toggle: () => setChatOpen(!chatting) } : null}
                onClose={() => openEpic(null)}
              />
            ) : (
              <p className="muted small chat-dock-empty">{listed.length ? "Click an epic to see its issues" : ""}</p>
            )}
          </section>
          {chatting && chatAbout && chatKey && (
            <section className="detail-pane chat-dock project-chat-pane">
              <InDock>
                <SprintChat key={chatKey} chatKey={chatKey} about={chatAbout} onClose={() => setChatOpen(false)} />
              </InDock>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** A date as "Nov 22", with its year when it isn't this one (an epic's chart can run across years). */
const shortDay = (t: number) =>
  new Date(t).toLocaleDateString(undefined, new Date(t).getFullYear() === new Date().getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });

/** The sprint's times to read the burndown at: its start, the end of each of its days, and now. */
function burndownDays(start: number, end: number, now: number): number[] {
  const at = [start];
  const day = new Date(start);
  day.setHours(24, 0, 0, 0);
  for (; day.getTime() < end; day.setDate(day.getDate() + 1)) {
    if (now > at[at.length - 1] && now < day.getTime()) at.push(now);
    at.push(day.getTime());
  }
  if (now > at[at.length - 1] && now < end) at.push(now);
  at.push(end);
  return at;
}

/**
 * The burndown at the top of the epic list (see Chart): the sprint's (under way only; see burndown),
 * or a selected person's or Unaffiliated's part of it, or a selected epic's over its whole life (see
 * epicBurndown). How many of its issues are left over its days, one step down as each went done, then dashed in the same
 * blue to its end at our pace so far, against an even pace from all of them at its start to none at its
 * end, dashed in gray, and today marked by a line across it, in a card. Under the card, its dates at either end (lined up with the chart's)
 * and how many of its issues are done between. Hovering it (or
 * arrowing through it, focused) reads a day: how many were left then (or would be, at our pace), and
 * how many the even pace would have left.
 */
export function Burndown({ tickets, points }: { tickets: Chart | null; points: Chart | null }) {
  const [at, setAt] = useState<number | null>(null);
  const [unit, setUnit] = useState<BurndownUnit>(() => (remembered(UNIT_KEY) === "points" ? "points" : "tickets"));
  const b = unit === "points" && points ? points : tickets;
  if (!b) return null;
  const choose = (u: BurndownUnit) => {
    setUnit(u);
    remember(UNIT_KEY, u);
  };
  // What it counts, in words: issues, or points.
  const word = b.unit === "points" ? "points" : "issues";
  const unsized = b.unit === "points" && b.unsized > 0 ? `${b.unsized} ${b.unsized === 1 ? "issue has" : "issues have"} no size` : null;
  // The toggle sits where the lines aren't: top right while now is in the chart's first half, bottom left after.
  const late = (b.now - b.start) / (b.end - b.start) >= 0.5;
  const span = b.end - b.start;
  const x = (t: number) => ((t - b.start) / span) * 100;
  const y = (left: number) => (1 - left / b.total) * 100;
  // The even pace: all of them at the start to none at its end (a sprint's) or due date (an epic's), then none.
  const paceTo = b.paceTo;
  const pace = (t: number) => (paceTo === null ? null : Math.max(0, b.total * (1 - (t - b.start) / (paceTo - b.start))));
  const days = burndownDays(b.start, b.end, b.now);
  let line = `M${x(b.steps[0].at)} ${y(b.steps[0].left)}`;
  for (const s of b.steps.slice(1)) line += `H${x(s.at)}V${y(s.left)}`;
  const hovered = at === null ? null : days[Math.min(at, days.length - 1)];
  const ahead = hovered !== null && hovered > b.now;
  const nowAt = days.indexOf(b.now);
  const nearest = (clientX: number, rect: DOMRect) => {
    const t = b.start + ((clientX - rect.left) / rect.width) * span;
    let best = 0;
    days.forEach((d, i) => Math.abs(d - t) < Math.abs(days[best] - t) && (best = i));
    return best;
  };
  const tipX = hovered === null ? 0 : x(hovered);
  return (
    <section className="burndown" aria-label="Burndown">
      <div className="burndown-card">
      <div
        className="burndown-plot"
        tabIndex={0}
        role="img"
        aria-label={`${Math.round(b.left)} of ${b.total} ${word} left${b.estimate ? `, done by ${shortDay(b.estimate)} at this pace` : b.projection ? `, ${Math.round(b.projection.left)} at the end at this pace` : ""}${hovered === null ? "" : `; on ${shortDay(hovered)}, ${Math.round(leftAt(b, hovered))} ${ahead ? "at this pace" : "left"}`}`}
        onPointerMove={(e) => setAt(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
        onPointerLeave={() => setAt(null)}
        onFocus={() => setAt(nowAt < 0 ? days.length - 1 : nowAt)}
        onBlur={() => setAt(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setAt((i) => Math.max(0, (i ?? days.length - 1) - 1));
          else if (e.key === "ArrowRight") setAt((i) => Math.min(days.length - 1, (i ?? 0) + 1));
          else return;
          e.preventDefault();
        }}
      >
        {/* The lines, side border to side border, their top and bottom inside the card's corners. */}
        <div className="burndown-area">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            {paceTo !== null && <path className="burndown-pace" d={`M0 0L${x(paceTo)} 100`} />}
            <path className="burndown-actual" d={line} />
            {b.projection && <path className="burndown-projection" d={`M${x(b.now)} ${y(b.left)}L${x(b.projection.at)} ${y(b.projection.left)}`} />}
          </svg>
          {hovered !== null && <span className="burndown-dot" style={{ left: `${tipX}%`, top: `${y(leftAt(b, hovered))}%` }} aria-hidden />}
        </div>
        {/* Today, while there's chart after it: a line from the card's top border to its bottom. */}
        {b.now < b.end && <span className="burndown-today" style={{ left: `${x(b.now)}%` }} aria-hidden />}
        {hovered !== null && (
          <>
            <span className="burndown-cross" style={{ left: `${tipX}%` }} aria-hidden />
            <div
              className="card meeting-card hover-tip small burndown-tip"
              role="tooltip"
              style={tipX > 60 ? { right: `${100 - tipX}%` } : { left: `${tipX}%` }}
            >
              <div>
                <strong>
                  {Math.round(leftAt(b, hovered))}
                  {b.unit === "points" ? " points" : ""} {ahead ? "at this pace" : "left"}
                </strong>{" "}
                <span className="muted">· {hovered === b.now && b.now < b.end ? "Now" : shortDay(hovered)}</span>
              </div>
              {pace(hovered) !== null && (
                <div className="muted">
                  <span className="burndown-pace-key" aria-hidden /> Even pace {Math.round(pace(hovered)!)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {/* Tickets or points: shown only when there are points to show. */}
      {points && (
        <div className={`burndown-unit ${late ? "bottom-left" : "top-right"}`}>
          <Segmented
            label="Count"
            value={b.unit}
            options={[
              { value: "tickets", label: "Tickets" },
              { value: "points", label: "Points" },
            ]}
            onChange={choose}
          />
        </div>
      )}
      </div>
      <div className="burndown-axis">
        <span>{shortDay(b.start)}</span>
        <span className="burndown-done" title={`${b.total - b.left} of ${b.total} ${word} completed${b.estimate ? `, estimated done ${shortDay(b.estimate)}` : ""}${unsized ? `; ${unsized} and counts for none` : ""}`}>
          {b.total - b.left} of {b.total} {word} completed
          {unsized && ` · ${b.unsized} unsized`}
          {/* The estimate, unless the chart ends at it (its end date says it, "~"). */}
          {b.estimate && !b.endEstimated && ` · est. ${shortDay(b.estimate)}`}
        </span>
        {/* Its end: a date set (the sprint's, the epic's due date), or "~" an estimate. */}
        <span>
          {b.endEstimated ? "~" : ""}
          {shortDay(b.end)}
        </span>
      </div>
    </section>
  );
}

/**
 * Under the burndown, the Team: who has the sprint's issues, the most first, each with their avatar, a
 * bar for how many of theirs are done, and how many they have (and how many of those are done, on
 * hover); the unassigned last. The names share a column, so the bars line up and fill the room to the
 * counts. Clicking one shows their issues on the right, as an epic's are. It folds away (remembered),
 * and a rule across the whole column sets it off from the epics under it.
 */
export function SprintPeople({ sprint, open, onSelect }: { sprint: db.StoredSprintEpics | undefined; open: string | null; onSelect: (key: string) => void }) {
  // In points once the sprint's sizes are read (a project with no size field: in tickets).
  const sizes = !!sprint?.size_field;
  const [shown, setShown] = useState(() => remembered(TEAM_KEY) !== "0");
  const people = sprintPeople(sprint);
  if (!people.length) return null;
  const toggle = () => {
    setShown(!shown);
    remember(TEAM_KEY, shown ? "0" : "1");
  };
  return (
    <>
      <section className="team">
        <header className="column-header team-head">
          <h4 className="section-title">Team</h4>
          <Disclosure open={shown} what="the team" onToggle={toggle} />
        </header>
        <Reveal open={shown}>
          <ul className="sprint-people" aria-label="Who has the sprint's issues">
            {people.map((p) => {
              const key = personKey(p.name);
              const selected = key === open;
              // Too much for one sprint (the unassigned have no one to be overloaded).
              const over = sizes && !!p.name && p.points.total > OVERLOAD_POINTS;
              return (
                <li key={key}>
                  <button
                    className={`sprint-person${p.name ? "" : " unassigned"}${selected ? " selected" : ""}`}
                    aria-current={selected ? "true" : undefined}
                    title={
                      sizes
                        ? `${p.points.done} of ${p.points.total} points done${p.points.started ? `, ${p.points.started} in progress` : ""}${p.points.unsized ? `; ${p.points.unsized} of their ${p.total} issues have no size` : ""}${over ? `. More than ${OVERLOAD_POINTS} points this sprint` : ""}`
                        : `${p.done} of ${p.total} done${p.started ? `, ${p.started} in progress` : ""}`
                    }
                    onClick={() => onSelect(key)}
                  >
                    {p.name ? <Avatar name={p.name} src={p.avatar} size={18} /> : <span className="sprint-person-none" aria-hidden />}
                    <span className="sprint-person-who">
                      <span className="sprint-person-name">{p.name ?? "Unassigned"}</span>
                      {over && <WarningIcon label={`More than ${OVERLOAD_POINTS} points this sprint`} />}
                    </span>
                    {sizes ? (
                      <ProgressBar done={p.points.done} started={p.points.started} total={p.points.total} />
                    ) : (
                      <ProgressBar done={p.done} started={p.started} total={p.total} />
                    )}
                    <span className="sprint-person-count">{sizes ? p.points.total : p.total}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Reveal>
      </section>
      <hr className="epics-rule" />
    </>
  );
}

/** Asks for the Jira project to follow: its key, or a link into it. Return saves it, Escape cancels. */
function ProjectForm({ initial, onSave, onCancel }: { initial: string | null; onSave: (key: string) => void; onCancel?: () => void }) {
  const [text, setText] = useState(initial ?? "");
  const key = projectKeyFrom(text);
  return (
    <form
      className="add-task epics-project-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (key) onSave(key);
      }}
    >
      <p className="small muted">Which Jira project's sprints should show here? Its key, like ABC, or a link to its board.</p>
      <input
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel?.()}
        placeholder="Jira project key"
        aria-label="Jira project key"
      />
      {text.trim() && !key && <p className="muted small">That isn't a project key or a link into a project.</p>}
    </form>
  );
}

/**
 * How far along some issues are, as a bar: done in green, then in progress in blue, the rest of the
 * track to do. Its counts say it in words on hover.
 */
/** How much is done and in progress, as a bar: tickets or points alike. */
function ProgressBar({ done, started, total }: { done: number; started: number; total: number }) {
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <span className="epic-bar" title={`${done} done, ${started} in progress, ${total - done - started} to do`} aria-hidden>
      {done > 0 && <span className="done" style={{ width: pct(done) }} />}
      {started > 0 && <span className="started" style={{ width: pct(started) }} />}
    </span>
  );
}

/** An epic's status lozenge, colored by its category as the Plan view's are. */
const EPIC_STATUS: Record<SprintEpic["category"], string> = { done: "done", in_progress: "in_progress", todo: "next" };
const CATEGORY_TEXT: Record<SprintEpic["category"], string> = { done: "Done", in_progress: "In progress", todo: "To do" };

/**
 * An epic in the sprint's list: its title on one line (cut short, whole on hover, when it's long), its
 * status at the right (Jira's, in the Plan view's lozenge); how much of its work in the sprint is done
 * (outlined, "2 of 3"), then how much of the whole epic is ("7 of 12", then its bar); its key (a link to
 * it in Jira) after what it's under, on a line of its own; and who it's assigned to and its due date (red
 * once it's past and the epic isn't done). Clicking the card (or Return or Space, on it) shows its
 * issues; clicking a key opens it in Jira instead. Unaffiliated says it's no epic in its key's place,
 * and has no status, owner or date.
 */
export function EpicRow({
  epic,
  issues,
  sizes,
  selected,
  onSelect,
}: {
  epic: SprintEpic;
  issues: db.StoredEpicChildren | undefined;
  /** Whether the sprint's read has T-shirt sizes, for the points. */
  sizes: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { done, started, total } = epicProgress(epic, issues) ?? { done: 0, started: 0, total: 0 };
  const gathered = isGathered(epic.key);
  const due = gathered ? null : dueText(epic.due, epic.category);
  const inSprintDone = epic.issues.filter((i) => i.category === "done").length;
  // Points: of its issues in the sprint, and of all of them (the sprint read's sized list, else its issues as read).
  const sprintPoints = sizes ? pointsTally(epic.issues) : null;
  const allPoints = !sizes
    ? null
    : gathered
      ? sprintPoints
      : (epicPoints(epic.sized, epic.progress?.total) ?? (issues && !issues.error && issues.issues.some((i) => i.size !== undefined) ? pointsTally(issues.issues) : null));
  return (
    <div
      className={`card project epic-row${selected ? " selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      onClick={(e) => {
        // Its key's link keeps its own click.
        if (!(e.target as HTMLElement).closest("a")) onSelect();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onSelect();
      }}
    >
      <span className="epic-row-top">
        <HoverTip text={epic.title} whenClipped>
          <span className="epic-row-title clip-text">{epic.title}</span>
        </HoverTip>
        {!gathered && <span className={`badge plan-status epic-row-status ${EPIC_STATUS[epic.category]}`}>{epic.status || CATEGORY_TEXT[epic.category]}</span>}
      </span>
      <span className="epic-row-mid small muted">
        {/* Tickets, then points under them, in columns so their counts line up (an empty cell keeps a column). */}
        <span className="epic-row-set">
          <span className="epic-row-set-label">Tickets</span>
          {!gathered && epic.issues.length > 0 ? (
            <span className="epic-row-in-sprint" title={`${inSprintDone} of its ${epic.issues.length} issues in this sprint done`}>
              {inSprintDone} of {epic.issues.length}
            </span>
          ) : (
            <span />
          )}
          {total > 0 ? (
            <>
              <span className="epic-row-count" title={`${done} of its ${total} issues done`}>
                {done} of {total}
              </span>
              <ProgressBar done={done} started={started} total={total} />
            </>
          ) : (
            <>
              <span />
              <span />
            </>
          )}
        </span>
        {allPoints && (
          <span className="epic-row-set points">
            <span className="epic-row-set-label">Points</span>
            {allPoints.total > 0 ? (
              <>
                {!gathered && sprintPoints && sprintPoints.total > 0 ? (
                  <span
                    className="epic-row-in-sprint"
                    title={`${sprintPoints.done} of its ${sprintPoints.total} points in this sprint done${sprintPoints.unsized ? `; ${sprintPoints.unsized} of its issues here have no size` : ""}`}
                  >
                    {sprintPoints.done} of {sprintPoints.total}
                  </span>
                ) : (
                  <span />
                )}
                <span className="epic-row-count" title={`${allPoints.done} of its ${allPoints.total} points done${allPoints.unsized ? `; ${allPoints.unsized} of its issues have no size` : ""}`}>
                  {allPoints.done} of {allPoints.total}
                </span>
                <ProgressBar done={allPoints.done} started={allPoints.started} total={allPoints.total} />
              </>
            ) : (
              <span className="epic-row-unsized">No sizes yet</span>
            )}
          </span>
        )}
      </span>
      {/* Its key after what it's under, on a line of its own; then who has it and when it's due. */}
      {!gathered && (
        <span className="epic-row-meta epic-row-path small muted">
          <IssuePath parents={epic.parents ?? []} issue={{ key: epic.key, type: "Epic", link: epic.link }} />
        </span>
      )}
      {(gathered || epic.assignee || due) && (
        <span className="epic-row-meta small muted">
          {gathered && <span className="epic-key">Not in an epic</span>}
          {!gathered && epic.assignee && <Owner name={epic.assignee} avatar={epic.avatar} />}
          {due && <span className={`epic-row-due${due.late ? " late" : ""}`}>{due.text}</span>}
        </span>
      )}
    </div>
  );
}

/** An issue in an issue's breadcrumb: its key, its type, its title and its link. */
type Crumb = { key: string; type?: string | null; title?: string | null; link?: string | null };

/** An epic as the last of its issues' breadcrumb: after the issues it's under, from the top down. */
const epicCrumbs = (e: SprintEpic): Crumb[] => [...(e.parents ?? []), { key: e.key, type: "Epic", title: e.title, link: e.link }];

/**
 * An issue's key after the issues it's under, from the top down: each a key after its type's mark, with
 * a light gray "/" between them. Hovering one it's under shows its title.
 */
function IssuePath({ parents, issue }: { parents: Crumb[]; issue: Crumb }) {
  return (
    <span className="issue-path">
      {[...parents, issue].map((c, i) => (
        <Fragment key={c.key}>
          {i > 0 && (
            <span className="issue-path-sep" aria-hidden>
              /
            </span>
          )}
          <HoverTip text={c === issue ? null : c.title}>
            <JiraKey type={c.type} href={c.link} className="epic-key" label={`Open ${c.key} in Jira`} size={12}>
              {c.key}
            </JiraKey>
          </HoverTip>
        </Fragment>
      ))}
    </span>
  );
}

/** A T-shirt, for an issue's size: drawn to fill its box as an issue type's mark does, at the same size. */
function TshirtIcon() {
  return (
    <svg className="tshirt-icon" width="12" height="12" viewBox="0 0 14 14" aria-hidden>
      <path d="M4.65 1.25 1 3.21l1.17 2.74 1.7-.66v7.44h6.26V5.29l1.69.66L13 3.21 9.35 1.25c-.39 1.04-1.3 1.7-2.35 1.7s-1.96-.66-2.35-1.7Z" />
    </svg>
  );
}

/** A warning: a triangle with "!", drawn in lines in the text's color (white in dark mode), its words on hover and for screen readers. */
function WarningIcon({ label }: { label: string }) {
  return (
    <svg className="warning-icon" width="13" height="13" viewBox="0 0 13 13" role="img" aria-label={label}>
      <title>{label}</title>
      <path d="M5.6 2.1a1 1 0 0 1 1.8 0l4.3 7.9a1 1 0 0 1-.9 1.5H2.2a1 1 0 0 1-.9-1.5z" />
      <path d="M6.5 5.2v2.6M6.5 9.4v.05" />
    </svg>
  );
}

/** Who an epic or issue is assigned to, on its card: a small face, then their name, cut short before the rest is. */
function Owner({ name, avatar }: { name: string; avatar: string | null | undefined }) {
  return (
    <span className="epic-row-owner" title={`Assigned to ${name}`}>
      <Avatar name={name} src={avatar ?? null} size={13} />
      <span className="epic-row-owner-name">{name}</span>
    </span>
  );
}

/** An epic's issues: those in the sprint shown, then the rest of the epic, each with its status and who it's assigned to. */
export function EpicIssues({
  epic,
  epics,
  job,
  chat,
  onClose,
  sprintName,
  read,
  reading,
  failed,
  onRead,
}: {
  epic: SprintEpic;
  /** The sprint's epics: the ones a person's issues (or Unaffiliated's) are under, for their breadcrumbs. */
  epics: SprintEpic[];
  /** Its read's job key. */
  job: string;
  /** Its chat's button: whether the chat is open, and opening or closing it. None for Unaffiliated. */
  chat: { on: boolean; toggle: () => void } | null;
  /** Closes the column: nothing selected, and the burndown back to the whole sprint. */
  onClose: () => void;
  sprintName: string | null;
  /** Its issues as last read, if they have been. */
  read: db.StoredEpicChildren | undefined;
  reading: boolean;
  failed: string | undefined;
  onRead: () => void;
}) {
  const status = useJobStatus(job);
  const gathered = isGathered(epic.key);
  const { sprint, rest } = splitIssues(read?.issues ?? [], new Set(epic.issues.map((i) => i.key)));
  // What each issue is under: this epic, or (a person's, Unaffiliated's) the sprint's epic that has it.
  const parents = (key: string): Crumb[] => {
    const under = gathered ? epics.find((e) => e.issues.some((i) => i.key === key)) : epic;
    return under ? epicCrumbs(under) : [];
  };
  return (
    <>
      <header className="column-header epic-issues-head">
        <div className="title-line">
          <h2 className="epic-issues-title">{epic.title}</h2>
          {chat && (
            <button
              className={`project-chat-button${chat.on ? " on" : ""}`}
              aria-pressed={chat.on}
              aria-label={chat.on ? "Close its chat" : epic.key.startsWith(PERSON) ? `Chat about ${epic.title}'s work` : "Chat about this epic"}
              onClick={chat.toggle}
            >
              Chat
            </button>
          )}
        </div>
        <span className="row epic-issues-tools">
          <RefreshButton busy={reading} onClick={onRead} title="Read its issues again" status={status} tip={read ? `Updated ${updatedText(read.at)}` : undefined} />
          <button className="icon-button" title="Close" aria-label={`Close ${epic.title}`} onClick={onClose}>
            <CloseIcon />
          </button>
        </span>
      </header>
      {gathered && (
        <p className="small muted epic-issues-sub">
          {epic.key === UNAFFILIATED ? "The sprint's issues that aren't in an epic" : epic.title === "Unassigned" ? "The sprint's issues no one has" : "Their issues in the sprint"}
        </p>
      )}
      {(failed || read?.error) && !reading && <p className="error small">Couldn't read its issues: {failed ?? read?.error}</p>}
      {read && !read.error && read.issues.length === 0 && <p className="muted small">It has no issues.</p>}
      {sprint.length > 0 && <IssueGroup fold="sprint" title={sprintName ? `In ${sprintName}` : "In this sprint"} issues={sprint} parents={parents} />}
      {rest.length > 0 && <IssueGroup fold="rest" title={sprint.length ? "Rest of the epic" : "Its issues"} issues={rest} parents={parents} />}
    </>
  );
}

/**
 * Issues under a heading that folds them away (remembered, for the sprint's and for the rest), each a
 * card as an epic's is: its title on one line, its status at the right (Jira's, in its lozenge); then its key after
 * the issues it's under (see IssuePath), on a line of its own; then who has it, its size and its due
 * date (red once it's past and it isn't done).
 */
function IssueGroup({
  fold,
  title,
  issues,
  parents,
}: {
  fold: keyof typeof GROUP_KEY;
  title: string;
  issues: db.StoredEpicChildren["issues"];
  /** The issues each is under, for its breadcrumb. */
  parents: (key: string) => Crumb[];
}) {
  const [open, setOpen] = useState(() => remembered(GROUP_KEY[fold]) !== "0");
  const toggle = () => {
    setOpen(!open);
    remember(GROUP_KEY[fold], open ? "0" : "1");
  };
  return (
    <section className="epic-issue-group">
      <h4 className="epic-issue-group-head">
        <FoldLabel label={title} count={issues.length} open={open} onToggle={toggle} />
      </h4>
      <Reveal open={open}>
        <div className="epic-issue-list">
          {issues.map((i) => {
            const due = dueText(i.due, i.category);
            return (
              <div key={i.key} className="card project epic-row issue-card">
                <span className="epic-row-top">
                  <HoverTip text={i.title} whenClipped>
                    <span className="epic-row-title clip-text">{i.title}</span>
                  </HoverTip>
                  <span className={`badge plan-status epic-row-status ${EPIC_STATUS[i.category]}`}>{i.status || CATEGORY_TEXT[i.category]}</span>
                </span>
                <span className="epic-row-meta epic-row-path small muted">
                  <IssuePath parents={parents(i.key)} issue={{ key: i.key, type: i.type, link: i.link }} />
                </span>
                {(i.assignee || sizeOf(i.size) || due) && (
                  <span className="epic-row-meta small muted">
                    {i.assignee && <Owner name={i.assignee} avatar={i.avatar} />}
                    {sizeOf(i.size) && (
                      <span className="badge size-badge" title={`T-shirt size ${sizeOf(i.size)}: ${pointsOf(i.size)} ${pointsOf(i.size) === 1 ? "point" : "points"}`}>
                        <TshirtIcon />
                        {sizeOf(i.size)}
                      </span>
                    )}
                    {due && <span className={`epic-row-due${due.late ? " late" : ""}`}>{due.text}</span>}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Reveal>
    </section>
  );
}
