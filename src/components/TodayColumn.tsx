import { refreshCalendar } from "../jobs";
import type { CalendarDay } from "../schema";
import { applyTaskState, type Pressure, type TaskState } from "../tasks";
import { Checklist, ExternalLink, RefreshButton, Updated } from "./common";
import { PressureBlob } from "./PressureBlob";
import { nameFromChannel } from "../projects";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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
  const now = Date.now();
  const events = [...(calendar?.day.events ?? [])].sort((a, b) => a.start.localeCompare(b.start));

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

      <ol className="timeline">
        {events.map((ev) => {
          const past = new Date(ev.end).getTime() < now;
          const current = !past && new Date(ev.start).getTime() <= now;
          return (
            <li key={ev.id} className={`card event${past ? " past" : ""}${current ? " current" : ""}`}>
              <div className="event-time">
                {time(ev.start)} – {time(ev.end)}
              </div>
              <ExternalLink href={ev.link} className="event-title">
                {ev.title}
              </ExternalLink>
              {ev.related_project && <span className="chip">{nameFromChannel(ev.related_project)}</span>}
              {ev.attendees.length > 0 && <div className="muted small">{ev.attendees.join(", ")}</div>}
              {ev.prep.length > 0 && (
                <div className="prep">
                  <h4>Prep</h4>
                  <Checklist tasks={applyTaskState(ev.prep, taskStates)} onChange={onChange} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
