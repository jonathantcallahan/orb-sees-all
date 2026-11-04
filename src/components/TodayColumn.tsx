import { revealTask } from "./TaskCard";
import { showDetailTab } from "../viewMode";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { setTaskState } from "../db";
import { dayRange, layoutDay, nowOffset } from "../calendar";
import { refreshCalendar } from "../jobs";
import type { CalendarDay, CalendarEvent } from "../schema";
import { stateOf, type Pressure, type TaskState } from "../tasks";
import { RefreshButton, Updated } from "./common";
import { PressureBlob, type OrbLook } from "./PressureBlob";
import { useJobStatus } from "../useAppData";

/** Pixels per minute on the day grid (72px an hour). */
/**
 * Pixels per minute on the day grid (174px an hour): tall enough that even a 15-minute meeting
 * shows both its lines, the title and then its time with the prep count, with room around them.
 */
const PX_PER_MIN = 2.9;
/** Space kept clear above and below each event, so blocks don't touch hour lines or each other. */
const EVENT_INSET_BOTTOM = 2;
/** The hour line is a 1px rule drawn below its mark, so the top gap counts it to match the bottom. */
const EVENT_INSET_TOP = EVENT_INSET_BOTTOM + 1;

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** "meet.google.com" from a call link, tolerating a malformed URL from the model. */
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
/** How close (px) an hour label can sit to the now line before the line's time would overlap it. */
const NOW_LABEL_CLEARANCE = 13;
/**
 * A time split into its number and its AM/PM, so the Detail view's rail can drop the AM/PM (see
 * .time-period); 24-hour locales have none to drop.
 */
function TimeParts({ date, minutes }: { date: Date; minutes: boolean }) {
  const parts = new Intl.DateTimeFormat([], { hour: "numeric", ...(minutes ? { minute: "2-digit" } : {}) }).formatToParts(date);
  const period = parts.filter((p) => p.type === "dayPeriod").map((p) => p.value).join("");
  const number = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
  return (
    <>
      {number}
      {period && <span className="time-period"> {period}</span>}
    </>
  );
}
const hourLabel = (h: number) => <TimeParts date={new Date(2000, 0, 1, h)} minutes={false} />;

/** The current time, refreshed every minute so the now line moves. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function VideoIcon() {
  return (
    <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden>
      <rect x="0.5" y="1" width="9" height="8" rx="2" fill="currentColor" />
      <path d="M10 4 L13.5 1.8 V8.2 L10 6 Z" fill="currentColor" />
    </svg>
  );
}

/** How long a meeting's card stays up after the pointer leaves, so it can travel over to the card. */
const CARD_LINGER_MS = 250;

/** A meeting's prep items not dismissed, and how many are done. */
function prepOf(ev: CalendarEvent, states: Map<string, TaskState>) {
  const items = ev.prep.filter((p) => !stateOf(states, p.id).dismissed);
  return { items, done: items.filter((p) => stateOf(states, p.id).done).length };
}

/**
 * Details shown while hovering a meeting: what it's about, and its prep as a checklist you can tick
 * off right there, each item's link as a chip. The pointer can move from the meeting onto the card.
 */
function MeetingCard({
  ev,
  anchor,
  states,
  onChange,
  onEnter,
  onLeave,
}: {
  ev: CalendarEvent;
  anchor: DOMRect;
  states: Map<string, TaskState>;
  onChange: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const width = 280;
  // Beside the block, kept inside the window. In the lower half of the window it
  // grows upward from the block's bottom edge so it isn't cut off.
  const left = Math.min(anchor.right + 6, window.innerWidth - width - 8);
  const prep = prepOf(ev, states);
  const vertical = anchor.top > window.innerHeight / 2 ? { bottom: Math.max(8, window.innerHeight - anchor.bottom) } : { top: anchor.top };
  // Rendered into <body>: inside the column it would sit under the next column's layer.
  return createPortal(
    <div className="card meeting-card" style={{ left, width, ...vertical }} role="dialog" aria-label={ev.title} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="meeting-card-title">{ev.title}</div>
      <div className="timestamp small">
        {time(ev.start)} – {time(ev.end)}
        {ev.video_link && ` · ${hostOf(ev.video_link)}`}
      </div>
      {ev.summary && <p className="small">{ev.summary}</p>}
      {ev.attendees.length > 0 && <div className="muted small">With {ev.attendees.join(", ")}</div>}
      {prep.items.length > 0 && (
        <>
          <h4>
            Prep <span className="timestamp">{prep.done}/{prep.items.length}</span>
          </h4>
          <ul className="checklist small meeting-prep">
            {prep.items.map((p) => {
              const done = stateOf(states, p.id).done;
              return (
                <li key={p.id} className={done ? "done" : undefined}>
                  <input
                    type="checkbox"
                    checked={done}
                    aria-label={p.title}
                    onChange={async (e) => {
                      await setTaskState(p.id, { status: e.target.checked ? "done" : "todo" });
                      onChange();
                    }}
                  />
                  <div className="task-body">
                    <span className="task-title">{p.title}</span>
                    {/* Each prep item is a task too: open its card in Tasks. */}
                    <button
                      className="link-button small more-link prep-view-task"
                      onClick={() => {
                        revealTask(p.id);
                        showDetailTab("tasks");
                      }}
                    >
                      View in tasks
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>,
    document.body,
  );
}

function DayGrid({
  events: all,
  now,
  states,
  onChange,
}: {
  events: CalendarEvent[];
  now: Date;
  states: Map<string, TaskState>;
  onChange: () => void;
}) {
  // Meetings you declined don't take up space on your day.
  const events = all.filter((ev) => ev.my_response !== "declined");
  // The grid is the whole day, midnight to midnight, in its own scroll box under the header. It rests
  // an hour before now (see dayRange), so only the last hour of the past shows, and can be scrolled
  // up to earlier in the day or down to midnight; see useRestingScroll.
  const range = { startHour: 0, endHour: 24 };
  const restPx = dayRange(events, now).startHour * 60 * PX_PER_MIN;
  // Every whole hour from the start on, midnight at the bottom included.
  const firstHour = Math.ceil(range.startHour);
  const hours = Array.from({ length: range.endHour - firstHour + 1 }, (_, i) => firstHour + i);
  const placed = layoutDay(events, range);
  const nowTop = nowOffset(now, range);
  const [hover, setHover] = useState<{ ev: CalendarEvent; anchor: DOMRect } | null>(null);
  // Leaving a meeting closes its card a moment later, unless the pointer arrives on the card.
  const linger = useRef<number>(0);
  const keep = () => window.clearTimeout(linger.current);
  const release = () => {
    keep();
    linger.current = window.setTimeout(() => setHover(null), CARD_LINGER_MS);
  };
  useEffect(() => keep, []);
  const minutes = (range.endHour - range.startHour) * 60;
  // Where the now line sits, in px, and which hour labels its time would sit on top of: those step
  // aside (the Detail view shows the time beside the line; see .now-label).
  const nowPx = nowTop != null ? nowTop * PX_PER_MIN : null;
  const nearNow = (h: number) => nowPx != null && Math.abs((h - range.startHour) * 60 * PX_PER_MIN - nowPx) < NOW_LABEL_CLEARANCE;

  const scroll = useRestingScroll(restPx, () => setHover(null));

  return (
    <div className="day-scroll" {...scroll}>
    <div className="day-grid" style={{ height: minutes * PX_PER_MIN + 8 }}>
      {hours.map((h) => (
        <div key={h} className={`hour${nearNow(h) ? " near-now" : ""}`} style={{ top: (h - range.startHour) * 60 * PX_PER_MIN }}>
          <span className="hour-label">{hourLabel(h)}</span>
        </div>
      ))}
      <div className="events">
        {placed.map(({ event: ev, top, height, column, columns }) => {
          const past = new Date(ev.end) < now;
          const current = !past && new Date(ev.start) <= now;
          // The call is worth surfacing from 10 minutes before until the meeting ends.
          const joinSoon = !past && new Date(ev.start).getTime() - now.getTime() <= 10 * 60_000;
          // Drawn height decides what fits: the name always, then the time with the prep count beside it.
          const px = Math.max(height * PX_PER_MIN - EVENT_INSET_TOP - EVENT_INSET_BOTTOM, 18);
          const prep = prepOf(ev, states);
          return (
            <div
              key={ev.id}
              role="link"
              tabIndex={0}
              className={`event-block rsvp-${ev.my_response ?? "accepted"}${past ? " past" : ""}${current ? " current" : ""}`}
              title={ev.my_response === "tentative" ? "You said maybe" : ev.my_response === "needs_action" ? "You haven't responded" : undefined}
              style={{
                top: top * PX_PER_MIN + EVENT_INSET_TOP,
                height: px,
                left: `${(column / columns) * 100}%`,
                width: `calc(${100 / columns}% - 2px)`,
              }}
              onClick={() => ev.link && openUrl(ev.link)}
              onKeyDown={(e) => e.key === "Enter" && ev.link && openUrl(ev.link)}
              onMouseEnter={(e) => {
                keep();
                setHover({ ev, anchor: e.currentTarget.getBoundingClientRect() });
              }}
              onMouseLeave={release}
            >
              <span className="event-name">{ev.title}</span>
              {px >= 34 && (
                <span className="event-when">
                  {time(ev.start)}
                  {prep.items.length > 0 && (
                    // One small circle per prep item, filled once it's done, the size of the orb's stat dots.
                    <span className={`event-prep${prep.done === prep.items.length ? " complete" : ""}`} aria-label={`${prep.done} of ${prep.items.length} prep done`}>
                      {prep.items.map((item, i) => (
                        <span key={item.id ?? i} className={`prep-dot${stateOf(states, item.id).done ? " done" : ""}`} />
                      ))}
                    </span>
                  )}
                </span>
              )}
              {ev.video_link && !past && (
                <button
                  className={`join${joinSoon ? " soon" : ""}`}
                  title={`Join the call (${hostOf(ev.video_link)})`}
                  aria-label="Join the call"
                  onClick={(e) => {
                    e.stopPropagation();
                    openUrl(ev.video_link!);
                  }}
                >
                  <VideoIcon />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {nowPx != null && (
        <div className="now-line" style={{ top: nowPx }}>
          <span className="now-label">
            <TimeParts date={now} minutes />
          </span>
        </div>
      )}
      {hover && <MeetingCard ev={hover.ev} anchor={hover.anchor} states={states} onChange={onChange} onEnter={keep} onLeave={release} />}
    </div>
    </div>
  );
}

/** How long the calendar takes to ease back to where it rests, after you've scrolled it and left. */
const RETURN_MS = 1500;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The calendar's scroll box: it sits at `restPx` (an hour before now), following it as the day goes
 * on. Scroll it yourself and it stays where you put it while the pointer is over it; leave, and it
 * eases back over a second and a half. Only your own scrolling (wheel, touch, keys) moves it off.
 */
function useRestingScroll(restPx: number, onUserScroll: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const restPxRef = useRef(restPx);
  restPxRef.current = restPx;
  /** Scrolled away by the user, and not yet sent back. */
  const away = useRef(false);
  const frame = useRef(0);
  const stopReturn = () => cancelAnimationFrame(frame.current);
  // At rest it follows the resting point, minute by minute.
  useLayoutEffect(() => {
    if (!away.current && !frame.current && ref.current) ref.current.scrollTop = restPx;
  }, [restPx]);
  useEffect(() => stopReturn, []);
  const leftAlone = () => {
    stopReturn();
    frame.current = 0;
    away.current = true;
    onUserScroll();
  };
  return {
    ref,
    onWheel: leftAlone,
    onTouchMove: leftAlone,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) leftAlone();
    },
    onMouseLeave: () => {
      const el = ref.current;
      if (!away.current || !el) return;
      const from = el.scrollTop;
      const begin = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - begin) / RETURN_MS);
        el.scrollTop = from + (restPxRef.current - from) * easeInOut(t);
        if (t < 1) frame.current = requestAnimationFrame(step);
        else {
          frame.current = 0;
          away.current = false;
        }
      };
      stopReturn();
      frame.current = requestAnimationFrame(step);
    },
  };
}

export function TodayColumn({
  pressure,
  orbLook,
  working,
  calendar,
  taskStates,
  busy,
  onChange,
}: {
  pressure: Pressure;
  orbLook: OrbLook;
  /** Orb is busy (a refresh or task session): the orb gives off motes. */
  working: boolean;
  calendar: { day: CalendarDay; refreshed_at: string } | null;
  taskStates: Map<string, TaskState>;
  busy: boolean;
  onChange: () => void;
}) {
  const now = useNow();
  const calendarStatus = useJobStatus("calendar");
  const events = calendar?.day.events ?? [];

  return (
    <section className="column today-column">
      <PressureBlob pressure={pressure} look={orbLook} working={working} />
      <header className="column-header">
        <div>
          <h2>
            Today <span className="timestamp today-date">{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</span>
          </h2>
          <Updated at={calendar?.refreshed_at} />
        </div>
        <RefreshButton busy={busy} status={calendarStatus} title="Refresh calendar" onClick={() => refreshCalendar().catch(() => {})} />
      </header>

      {!calendar && <p className="muted small">{busy ? "Reading your calendar…" : "No calendar loaded for today yet."}</p>}
      {calendar && events.length === 0 && <p className="muted small">No meetings today.</p>}
      {calendar && <DayGrid events={events} now={now} states={taskStates} onChange={onChange} />}

    </section>
  );
}
