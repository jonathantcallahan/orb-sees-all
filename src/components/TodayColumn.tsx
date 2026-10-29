import { useEffect, useRef, useState } from "react";
import { dayRange, layoutDay, nowOffset } from "../calendar";
import { refreshCalendar } from "../jobs";
import { nameFromChannel } from "../projects";
import type { CalendarDay, CalendarEvent } from "../schema";
import { applyTaskState, type Pressure, type TaskState } from "../tasks";
import { Checklist, ExternalLink, RefreshButton, Updated } from "./common";
import { PressureBlob } from "./PressureBlob";

/** Pixels per minute on the day grid (48px an hour). */
const PX_PER_MIN = 0.8;

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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

function DayGrid({ events, now }: { events: CalendarEvent[]; now: Date }) {
  const range = dayRange(events);
  const hours = Array.from({ length: range.endHour - range.startHour }, (_, i) => range.startHour + i);
  const placed = layoutDay(events, range);
  const nowTop = nowOffset(now, range);
  const nowLine = useRef<HTMLDivElement>(null);

  // Start with the current time in view.
  useEffect(() => {
    nowLine.current?.scrollIntoView({ block: "center" });
  }, []);

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
          const tooltip = [`${ev.title}`, `${time(ev.start)} – ${time(ev.end)}`, ev.prep.length ? `${ev.prep.length} prep` : ""]
            .filter(Boolean)
            .join("\n");
          return (
            <ExternalLink
              key={ev.id}
              href={ev.link}
              className={`event-block${past ? " past" : ""}${current ? " current" : ""}`}
              title={tooltip}
              style={{
                top: top * PX_PER_MIN,
                height: Math.max(height * PX_PER_MIN, 18),
                left: `${(column / columns) * 100}%`,
                width: `calc(${100 / columns}% - 2px)`,
              }}
            >
              <span className="event-name">{ev.title}</span>
              {height >= 40 && <span className="event-when">{time(ev.start)}</span>}
              {ev.prep.length > 0 && <span className="event-prep">{ev.prep.length} prep</span>}
            </ExternalLink>
          );
        })}
      </div>
      {nowTop != null && (
        <div ref={nowLine} className="now-line" style={{ top: nowTop * PX_PER_MIN }} title={`Now, ${time(now.toISOString())}`} />
      )}
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
        <RefreshButton busy={busy} title="Refresh calendar" onClick={() => refreshCalendar().catch(() => {})} />
      </header>

      {!calendar && <p className="muted small">{busy ? "Reading your calendar…" : "No calendar loaded for today yet."}</p>}
      {calendar && events.length === 0 && <p className="muted small">No meetings today.</p>}
      {calendar && <DayGrid events={events} now={now} />}

      {upcomingPrep.length > 0 && (
        <section className="prep">
          <h4>Prep</h4>
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
