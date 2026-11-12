import { revealTask } from "./TaskCard";
import { showDetailTab } from "../viewMode";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { setTaskState } from "../db";
import { dayRange, layoutDay, nowOffset } from "../calendar";
import type { CalendarDay, CalendarEvent } from "../schema";
import { stateOf, type Pressure, type TaskState } from "../tasks";
import { Spinner } from "./common";
import { PressureBlob, type OrbLook } from "./PressureBlob";
import { useJobStatus } from "../useAppData";
import { formatRemaining, restartPomodoro, restartPomodoroBlock, SESSIONS, stopPomodoro, togglePomodoroPause, usePomodoro, usePomodoroActive, usePomodoroFocusDone, usePomodoroSettings, usePomodoroStopped } from "../pomodoro";

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

/**
 * The current time, refreshed every `everyMs`. The calendar's is every few seconds: often enough
 * that it and the now line move a pixel at a time (2.9px a minute is one about every 20s) instead
 * of a few at once each minute.
 */
function useNow(everyMs = 3_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
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
  states,
  pomodoroOn,
  pomodoroActive,
  onChange,
}: {
  events: CalendarEvent[];
  states: Map<string, TaskState>;
  /** The pomodoro timer is on in Settings: today's finished focus sessions are drawn under the meetings. */
  pomodoroOn: boolean;
  /** A series is running (or paused), not stopped: its current block is drawn too. */
  pomodoroActive: boolean;
  onChange: () => void;
}) {
  // The time here, not in the column, so only the calendar redraws as it moves.
  const now = useNow();
  // Meetings you declined don't take up space on your day.
  const events = all.filter((ev) => ev.my_response !== "declined");
  // The grid is the whole day, midnight to midnight, in its own scroll box under the header. It rests
  // an hour before now (see dayRange), so only the last hour of the past shows, and can be scrolled
  // up to earlier in the day or down to midnight; see useRestingScroll. While the pomodoro timer is
  // on, it takes room from the column, so the calendar rests only half an hour back (stopped too,
  // so stopping it doesn't move the calendar).
  const range = { startHour: 0, endHour: 24 };
  // Both on whole pixels, and from the same time, so as the day goes on the calendar and the now
  // line step together, one pixel at a time, and never shimmy against each other.
  const restPx = wholePx(dayRange(events, now, pomodoroOn ? 30 : 60).startHour * 60 * PX_PER_MIN);
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
  const nowPx = nowTop != null ? wholePx(nowTop * PX_PER_MIN) : null;
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
        {pomodoroOn && <FocusDone range={range} />}
        {pomodoroActive && <PomodoroBlock range={range} />}
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

type DayRange = { startHour: number; endHour: number };

/** Minutes from the top of the calendar to time \`t\`, kept on today (the day it shows). */
function minutesInDay(t: number, range: DayRange): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Math.min(Math.max((t - midnight.getTime()) / 60_000 - range.startHour * 60, 0), (range.endHour - range.startHour) * 60);
}

/** Where a block from \`from\` to \`to\` sits on the calendar, in px, or null when it isn't on today. */
function blockPlace(from: number, to: number, range: DayRange) {
  const top = minutesInDay(from, range);
  const bottom = minutesInDay(to, range);
  if (bottom <= top) return null;
  return { top, style: { top: wholePx(top * PX_PER_MIN) + EVENT_INSET_TOP, height: Math.max(wholePx((bottom - top) * PX_PER_MIN) - EVENT_INSET_TOP - EVENT_INSET_BOTTOM, 4) } };
}

/**
 * The pomodoro's current block on the calendar, its full length up to when it will end, under the
 * meetings: no title, just a field of small dots (see PomodoroField), steady down to now and
 * pulsing after, so it doesn't read as a meeting. Hidden while paused; carried on, its start has
 * moved later by the pause rather than the block stretching over it. A block running past midnight
 * runs off its bottom.
 */
function PomodoroBlock({ range }: { range: DayRange }) {
  // The timer ticks every second; only the block redraws for it, not the calendar around it.
  const block = usePomodoro();
  const place = block && blockPlace(block.start, block.end, range);
  if (!block || block.paused || !place) return null;
  return (
    <div className={`pomodoro-block ${block.phase}`} style={place.style} aria-hidden>
      <PomodoroField doneY={() => minutesInDay(Date.now(), range) * PX_PER_MIN - wholePx(place.top * PX_PER_MIN) - EVENT_INSET_TOP} />
    </div>
  );
}

/**
 * Today's finished focus sessions on the calendar, under the meetings: steady fields of dots, like
 * the done part of the current block. They stay when the series is stopped or started over.
 */
function FocusDone({ range }: { range: DayRange }) {
  const done = usePomodoroFocusDone();
  return (
    <>
      {done.map(([from, to]) => {
        const place = blockPlace(from, to, range);
        return (
          place && (
            <div key={from} className="pomodoro-block focus" style={place.style} aria-hidden>
              {/* Done all the way down. */}
              <PomodoroField doneY={() => 1e6} still />
            </div>
          )
        );
      })}
    </>
  );
}

/** How often the pulsing dots are drawn (ms). */
const PULSE_FRAME_MS = 50;
/** The dot field's grid: a dot every 6px. */
const FIELD_STEP = 6;
/** How far the done part's edge wanders either way, and how deep the blend into pulsing dots is, in px. */
const EDGE_WANDER = 5;
const EDGE_BLEND = 14;

/** A steady pseudo-random number in [0, 1) for a dot. */
const dotRandom = (i: number, j: number, k: number) => {
  const v = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
  return v - Math.floor(v);
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * The pomodoro block's dots on the calendar. What's done of the block, from its top down to now,
 * is a steady field of full dots; the rest, below the now line, pulse in and out, each dot on its
 * own beat. The edge between them isn't a straight line: each column's edge bobs up and down a
 * little on its own slow beat (smoothed with its neighbors', so nothing ripples sideways) and
 * blends into the pulsing dots, so the front looks fluid as it moves down. Only whole dots are
 * drawn: none where a meeting covers the field, even in part, so none shows cut by a meeting's edge
 * or through a meeting that's over (drawn half see-through). A finished block (`still`), or any
 * with reduced motion, holds still. Drawn on a canvas, as each dot's size changes on its own; its
 * color comes from the CSS (see .pomodoro-field). \`doneY\` is how far down the block now is, in px.
 */
function PomodoroField({ doneY, still = false }: { doneY: () => number; still?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(doneY);
  latest.current = doneY;
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let wait = 0;
    let color = "";
    let readAt = -Infinity;
    // The meetings, as rects in the canvas's own px with a little margin: no dots under them.
    let covered: { left: number; right: number; top: number; bottom: number }[] = [];
    // The pulsing's clock: it runs only while the timer does.
    let clock = 0;
    let last = performance.now();
    // Draws the field as it is now. The pulsing only moves on while the timer runs.
    const steady = still || reduce;
    const paint = (now: number) => {
      const doneY = latest.current;
      if (!steady) clock += Math.min(now - last, 100) / 1000;
      last = now;
      // The color follows the CSS (gray at rest, in color under the pointer), and the meetings can
      // move: both are checked a few times a second.
      if (now - readAt > 100) {
        color = getComputedStyle(el).color;
        const box = el.getBoundingClientRect();
        covered = [...(el.closest(".events")?.querySelectorAll(".event-block") ?? [])].map((ev) => {
          const r = ev.getBoundingClientRect();
          return { left: r.left - box.left - 2, right: r.right - box.left + 2, top: r.top - box.top - 2, bottom: r.bottom - box.top + 2 };
        });
        readAt = now;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = color;
      const done = doneY();
      const cols = Math.floor(w / FIELD_STEP);
      const rows = Math.floor(h / FIELD_STEP);
      const x0 = FIELD_STEP / 2;
      const y0 = (h - rows * FIELD_STEP + FIELD_STEP) / 2;
      // Each column's edge: now, pushed a little up or down by two slow swells of its own, then
      // eased toward its neighbors' so the front stays smooth.
      const bob = Array.from({ length: cols }, (_, i) =>
        0.6 * Math.sin(clock * (0.4 + 0.5 * dotRandom(i, 0, 3)) + dotRandom(i, 0, 4) * Math.PI * 2) +
        0.4 * Math.sin(clock * (0.7 + 0.6 * dotRandom(i, 0, 5)) + dotRandom(i, 0, 6) * Math.PI * 2),
      );
      for (let i = 0; i < cols; i++) {
        const x = x0 + i * FIELD_STEP;
        const edge = done + EDGE_WANDER * (0.25 * (bob[i - 1] ?? bob[i]) + 0.5 * bob[i] + 0.25 * (bob[i + 1] ?? bob[i]));
        for (let j = 0; j < rows; j++) {
          const y = y0 + j * FIELD_STEP;
          if (covered.some((r) => x > r.left && x < r.right && y > r.top && y < r.bottom)) continue;
          // 0 in the done part, 1 well past its edge.
          const pulsing = smooth(edge - EDGE_BLEND / 2, edge + EDGE_BLEND / 2, y);
          // Each dot on its own beat, a few seconds long, from a speck to a full dot and back.
          const beat = 0.5 + 0.5 * Math.sin(clock * (0.9 + 1.6 * dotRandom(i, j, 1)) + dotRandom(i, j, 2) * Math.PI * 2);
          // Done: full dots (r 1, at 55%).
          ctx.globalAlpha = 0.55 - pulsing * (0.45 - 0.3 * beat);
          ctx.beginPath();
          ctx.arc(x, y, 1 - pulsing * (0.65 - 0.65 * beat), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    // Pulsing is drawn about 20 times a second, plenty for dots that swell over a few seconds and
    // far less work than every frame; standing still, once a second is enough for the edge.
    const loop = (now: number) => {
      paint(now);
      wait = window.setTimeout(() => (frame = requestAnimationFrame(loop)), steady ? 1000 : PULSE_FRAME_MS);
    };
    // The block moves and changes size on Restart timer: drawn again at once at its new size, or the
    // old drawing would show stretched until the next one.
    const resized = new ResizeObserver(() => paint(performance.now()));
    resized.observe(el);
    loop(performance.now());
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(wait);
      resized.disconnect();
    };
  }, [still]);
  return <canvas ref={canvas} className="pomodoro-field" aria-hidden />;
}

/**
 * Where the series is: a small rounded square cut into quarters, one per focus session, read like
 * text (the first two on top, the next two under them). Done sessions are filled (the one before a
 * break as soon as the break starts), the one you're in light gray, the rest open; pointing at it
 * shows Focus or Break under it. 15px, drawn on whole pixels with even quarters (6px each side of a
 * 1px cross) so its lines stay crisp.
 */
function SeriesSquare({ session, focus, phase }: { session: number; focus: boolean; phase: string }) {
  const clip = useId();
  // The square is centered on its line, so it can land part way into a pixel, blurring its lines:
  // nudge it back onto a whole one each time it's drawn (the timer redraws every second).
  const svg = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const whole = (v: number) => Math.round(v * dpr) / dpr;
    el.style.transform = "";
    const { left, top } = el.getBoundingClientRect();
    const dx = whole(left) - left;
    const dy = whole(top) - top;
    if (dx || dy) el.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  const quarters = [
    [0, 0],
    [7.5, 0],
    [0, 7.5],
    [7.5, 7.5],
  ];
  return (
    <span className="pomodoro-square">
      <svg ref={svg} className="pomodoro-series" width="15" height="15" viewBox="0 0 15 15" role="img" aria-label={session < 0 ? "Pomodoro stopped" : `${phase}, session ${session + 1} of ${SESSIONS}`}>
        <clipPath id={clip}>
          <rect x="0.5" y="0.5" width="14" height="14" rx="3" />
        </clipPath>
        <g clipPath={`url(#${CSS.escape(clip)})`}>
          {quarters.map(([x, y], i) =>
            i <= session ? <rect key={i} x={x} y={y} width="7.5" height="7.5" fill="currentColor" fillOpacity={i < session || !focus ? 1 : 0.45} /> : null,
          )}
        </g>
        <rect x="0.5" y="0.5" width="14" height="14" rx="3" fill="none" stroke="currentColor" />
        <path d="M7.5 0.5V14.5M0.5 7.5H14.5" stroke="currentColor" />
      </svg>
      <span className="card pomodoro-tip small" aria-hidden>
        {phase}
      </span>
    </span>
  );
}

/**
 * The pomodoro timer, at the right of the calendar's heading: a square for the series (a quarter for
 * each focus session, filled as they're done; pointing at it says Focus or Break), then the time left
 * in the timestamps' gray. Pointing at the time shows a small menu above it, like Refresh's: Pause (Resume
 * while paused), Restart timer (the block it's in, from its full length), Restart series (from the
 * first focus session) and Stop. Stopped, it reads 00:00 with an empty square and nothing on the
 * calendar, and its menu offers Start.
 */
function PomodoroTimer() {
  // Ticking every second here, not in the column, so only the timer redraws.
  const timer = usePomodoro();
  const stopped = usePomodoroStopped();
  if (stopped)
    return (
      <div className="pomodoro">
        <SeriesSquare session={-1} focus={false} phase="Stopped" />
        <span className="pomodoro-time-wrap">
          <span className="pomodoro-time timestamp" role="timer" aria-label="Pomodoro timer stopped">
            00:00
          </span>
          <span className="card menu-card pomodoro-tip small" role="menu" aria-label="Pomodoro timer">
            <button role="menuitem" className="link-button small" onClick={restartPomodoro}>
              Start
            </button>
          </span>
        </span>
      </div>
    );
  if (!timer) return null;
  const phase = timer.phase === "focus" ? "Focus" : "Break";
  return (
    <div className={`pomodoro ${timer.phase}${timer.paused ? " paused" : ""}`}>
      <SeriesSquare session={timer.session} focus={timer.phase === "focus"} phase={phase} />
      <span className="pomodoro-time-wrap">
        <span className={`pomodoro-time timestamp${timer.paused ? "" : " text-shimmer"}`} role="timer" aria-label={`${phase}, ${formatRemaining(timer.remainingMs)} left${timer.paused ? ", paused" : ""}`}>
          {formatRemaining(timer.remainingMs)}
        </span>
        <span className="card menu-card pomodoro-tip small" role="menu" aria-label="Pomodoro timer">
          <button role="menuitem" className="link-button small" onClick={togglePomodoroPause}>
            {timer.paused ? "Resume" : "Pause"}
          </button>
          <button role="menuitem" className="link-button small" onClick={restartPomodoroBlock}>
            Restart timer
          </button>
          <button role="menuitem" className="link-button small" onClick={restartPomodoro}>
            Restart series
          </button>
          <button role="menuitem" className="link-button small" onClick={stopPomodoro}>
            Stop
          </button>
        </span>
      </span>
    </div>
  );
}

/**
 * A length on whole pixels, so the calendar's scroll and what's drawn over it land on the same ones
 * (a scroll position may not take part of a pixel) and step together.
 */
const wholePx = (px: number) => Math.round(px);

/** How long the calendar takes to ease back to where it rests, after you've scrolled it and left. */
const RETURN_MS = 1500;
/** How long it takes to glide to a new resting point (the pomodoro timer turned on, say). */
const GLIDE_MS = 700;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The calendar's scroll box: it sits at `restPx` (an hour before now), following it as the day goes
 * on, a pixel at a time; a bigger move (the pomodoro timer turned on, waking from sleep) glides
 * there instead. Scroll it yourself and it stays where you put it while the pointer is over it;
 * leave, and it eases back over a second and a half. Only your own scrolling (wheel, touch, keys)
 * moves it off.
 */
function useRestingScroll(restPx: number, onUserScroll: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const restPxRef = useRef(restPx);
  restPxRef.current = restPx;
  /** Scrolled away by the user, and not yet sent back. */
  const away = useRef(false);
  const frame = useRef(0);
  const stopReturn = () => cancelAnimationFrame(frame.current);
  /** Placed at its first resting point yet. */
  const placed = useRef(false);
  // Eases from where it is to the resting point (as it is each frame) over `ms`, then is at rest.
  const easeBack = (el: HTMLDivElement, ms: number) => {
    const from = el.scrollTop;
    const begin = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - begin) / ms);
      el.scrollTop = from + (restPxRef.current - from) * easeInOut(t);
      if (t < 1) frame.current = requestAnimationFrame(step);
      else {
        frame.current = 0;
        away.current = false;
      }
    };
    stopReturn();
    frame.current = requestAnimationFrame(step);
  };
  // At rest it follows the resting point: a pixel at a time, or gliding when it's further.
  useLayoutEffect(() => {
    const el = ref.current;
    // Scrolled away, or already easing toward it (which follows the point as it moves).
    if (!el || away.current || frame.current) return;
    // Where it can actually get to: late in the day the point is past the bottom of the scroll.
    const reachable = Math.min(restPx, Math.max(0, el.scrollHeight - el.clientHeight));
    if (!placed.current || Math.abs(el.scrollTop - reachable) <= 2) el.scrollTop = restPx;
    else easeBack(el, GLIDE_MS);
    placed.current = true;
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
      if (away.current && el) easeBack(el, RETURN_MS);
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
  // The day's name changes at midnight; checking each minute is enough.
  const today = useNow(60_000);
  const pomodoroOn = usePomodoroSettings().on;
  // Running or paused: stopped, its current block leaves the calendar (what's done stays).
  const pomodoroActive = usePomodoroActive();
  const calendarStatus = useJobStatus("calendar");
  const events = calendar?.day.events ?? [];

  return (
    <section className="column today-column">
      <PressureBlob pressure={pressure} look={orbLook} working={working} />
      {/* The day, "Tuesday November 10" with the weekday in the darker text color, and the pomodoro timer at the right. */}
      <header className="column-header">
        <div>
          <h2>
            <span className="today-weekday">{today.toLocaleDateString([], { weekday: "long" })}</span>{" "}
            <span className="timestamp today-date">{today.toLocaleDateString([], { month: "long", day: "numeric" })}</span>
            {/* Refreshed from the bottom bar's Refresh menu; a spinner here while it runs. */}
            {busy && (
              <span className="section-spinner" aria-label={calendarStatus ?? "Refreshing the calendar"}>
                <Spinner />
              </span>
            )}
          </h2>
        </div>
        {pomodoroOn && <PomodoroTimer />}
      </header>

      {!calendar && <p className="muted small">{busy ? "Reading your calendar…" : "No calendar loaded for today yet."}</p>}
      {calendar && events.length === 0 && <p className="muted small">No meetings today.</p>}
      {calendar && <DayGrid events={events} states={taskStates} pomodoroOn={pomodoroOn} pomodoroActive={pomodoroActive} onChange={onChange} />}

    </section>
  );
}
