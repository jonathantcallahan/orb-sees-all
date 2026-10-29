import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { dayRange, layoutDay, nowOffset } from "../calendar";
import { refreshCalendar } from "../jobs";
import { nameFromChannel } from "../projects";
import type { CalendarDay, CalendarEvent } from "../schema";
import { applyTaskState, type Pressure, type TaskState } from "../tasks";
import { Checklist, RefreshButton, Updated } from "./common";
import { PressureBlob } from "./PressureBlob";
import { useJobStatus } from "../useAppData";

/** Pixels per minute on the day grid (72px an hour). */
const PX_PER_MIN = 1.2;

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** "meet.google.com" from a call link, tolerating a malformed URL from the model. */
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });

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

/** Details shown while hovering a meeting: what it's about and how to prepare. */
function MeetingCard({ ev, anchor }: { ev: CalendarEvent; anchor: DOMRect }) {
  const width = 280;
  // Beside the block, kept inside the window. In the lower half of the window it
  // grows upward from the block's bottom edge so it isn't cut off.
  const left = Math.min(anchor.right + 8, window.innerWidth - width - 8);
  const vertical = anchor.top > window.innerHeight / 2 ? { bottom: Math.max(8, window.innerHeight - anchor.bottom) } : { top: anchor.top };
  return (
    <div className="card meeting-card" style={{ left, width, ...vertical }} role="tooltip">
      <div className="meeting-card-title">{ev.title}</div>
      <div className="muted small">
        {time(ev.start)} – {time(ev.end)}
        {ev.video_link && ` · ${hostOf(ev.video_link)}`}
      </div>
      {ev.summary && <p className="small">{ev.summary}</p>}
      {ev.attendees.length > 0 && <div className="muted small">With {ev.attendees.join(", ")}</div>}
      {ev.prep.length > 0 && (
        <>
          <h4>Prep</h4>
          <ul className="small meeting-prep">
            {ev.prep.map((p) => (
              <li key={p.id}>{p.title}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DayGrid({ events, now }: { events: CalendarEvent[]; now: Date }) {
  const range = dayRange(events, now);
  const hours = Array.from({ length: range.endHour - range.startHour }, (_, i) => range.startHour + i);
  const placed = layoutDay(events, range);
  const nowTop = nowOffset(now, range);
  const [hover, setHover] = useState<{ ev: CalendarEvent; anchor: DOMRect } | null>(null);

  return (
    <div className="day-grid" style={{ height: hours.length * 60 * PX_PER_MIN }}>
      {hours.map((h, i) => (
        <div key={h} className="hour" style={{ top: i * 60 * PX_PER_MIN }}>
          <span className="hour-label">{hourLabel(h)}</span>
        </div>
      ))}
      <div className="events">
        {placed.map(({ event: ev, top, height, column, columns }) => {
          const past = new Date(ev.end) < now;
          const current = !past && new Date(ev.start) <= now;
          // The call is worth surfacing from 10 minutes before until the meeting ends.
          const joinSoon = !past && new Date(ev.start).getTime() - now.getTime() <= 10 * 60_000;
          return (
            <div
              key={ev.id}
              role="link"
              tabIndex={0}
              className={`event-block${past ? " past" : ""}${current ? " current" : ""}`}
              style={{
                top: top * PX_PER_MIN,
                height: Math.max(height * PX_PER_MIN, 18),
                left: `${(column / columns) * 100}%`,
                width: `calc(${100 / columns}% - 2px)`,
              }}
              onClick={() => ev.link && openUrl(ev.link)}
              onKeyDown={(e) => e.key === "Enter" && ev.link && openUrl(ev.link)}
              onMouseEnter={(e) => setHover({ ev, anchor: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={() => setHover(null)}
            >
              <span className="event-name">{ev.title}</span>
              {height >= 40 && <span className="event-when">{time(ev.start)}</span>}
              {ev.prep.length > 0 && <span className="event-prep">{ev.prep.length} prep</span>}
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
      {nowTop != null && <div className="now-line" style={{ top: nowTop * PX_PER_MIN }} />}
      {hover && <MeetingCard ev={hover.ev} anchor={hover.anchor} />}
    </div>
  );
}

export function TodayColumn({
  pressure,
  calendar,
  taskStates,
  busy,
  onChange,
}: {
  pressure: Pressure;
  calendar: { day: CalendarDay; refreshed_at: string } | null;
  taskStates: Map<string, TaskState>;
  busy: boolean;
  onChange: () => void;
}) {
  const now = useNow();
  const calendarStatus = useJobStatus("calendar");
  const events = calendar?.day.events ?? [];
  // Prep only matters for meetings that haven't ended.
  const upcomingPrep = [...events]
    .sort((a, b) => a.start.localeCompare(b.start))
    .filter((ev) => ev.prep.length > 0 && new Date(ev.end) >= now);

  return (
    <section className="column">
      <PressureBlob pressure={pressure} />
      <header className="column-header">
        <div>
          <h2>Today</h2>
          <Updated at={calendar?.refreshed_at} />
        </div>
        <RefreshButton busy={busy} status={calendarStatus} title="Refresh calendar" onClick={() => refreshCalendar().catch(() => {})} />
      </header>

      {!calendar && <p className="muted small">{busy ? "Reading your calendar…" : "No calendar loaded for today yet."}</p>}
      {calendar && events.length === 0 && <p className="muted small">No meetings today.</p>}
      {calendar && <DayGrid events={events} now={now} />}

      {upcomingPrep.length > 0 && (
        <section className="prep">
          <h4 className="section-title">Prep</h4>
          {upcomingPrep.map((ev) => (
            <div key={ev.id} className="prep-meeting">
              <div className="small prep-for" title={ev.title}>
                <span className="muted">{time(ev.start)}</span> {ev.title}
                {ev.related_project && <span className="chip">{nameFromChannel(ev.related_project)}</span>}
              </div>
              <Checklist tasks={applyTaskState(ev.prep, taskStates)} onChange={onChange} />
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
