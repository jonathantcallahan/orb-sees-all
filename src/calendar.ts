import type { CalendarEvent } from "./schema";

export interface DayRange {
  /** First and last hour shown, in local time (endHour is exclusive). */
  startHour: number;
  endHour: number;
}

const minutesOfDay = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

/**
 * 8am to 6pm, stretched to fit any meeting that starts earlier or ends later.
 * With `now`, hours that are long past are dropped: the grid starts one hour
 * before the current hour.
 */
export function dayRange(events: Pick<CalendarEvent, "start" | "end">[], now?: Date): DayRange {
  let startHour = 8;
  // The day always runs to midnight, so the rest of the evening is there to see.
  const endHour = 24;
  for (const e of events) startHour = Math.min(startHour, Math.floor(minutesOfDay(e.start) / 60));
  if (now) startHour = Math.max(startHour, Math.min(now.getHours() - 1, endHour - 1));
  return { startHour, endHour };
}

export interface PlacedEvent<T> {
  event: T;
  /** Minutes from the top of the range, and duration in minutes. */
  top: number;
  height: number;
  /** Side-by-side position among overlapping events. */
  column: number;
  columns: number;
}

/**
 * Places events on the day grid. Overlapping events share the width: each
 * cluster of overlapping events is split into as many columns as it needs, and
 * each event takes the first free column.
 */
export function layoutDay<T extends Pick<CalendarEvent, "start" | "end">>(events: T[], range: DayRange): PlacedEvent<T>[] {
  const items = events
    .map((event) => {
      const rawStart = minutesOfDay(event.start);
      const rawEnd = minutesOfDay(event.end);
      const end = rawEnd <= rawStart ? 24 * 60 : rawEnd;
      // Meetings already running when the grid starts are clipped at the top.
      const start = Math.max(rawStart, range.startHour * 60);
      return { event, start, end };
    })
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const placed: PlacedEvent<T>[] = [];
  let cluster: { item: (typeof items)[number]; column: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const columns = Math.max(1, ...cluster.map((c) => c.column + 1));
    for (const { item, column } of cluster) {
      placed.push({
        event: item.event,
        top: item.start - range.startHour * 60,
        height: item.end - item.start,
        column,
        columns,
      });
    }
    cluster = [];
  };

  for (const item of items) {
    if (item.start >= clusterEnd) flush();
    // First column whose last event has ended by the time this one starts.
    let column = 0;
    while (cluster.some((c) => c.column === column && c.item.end > item.start)) column++;
    cluster.push({ item, column });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return placed;
}

/** Minutes from the top of the range to `now`, or null when now is outside it. */
export function nowOffset(now: Date, range: DayRange): number | null {
  const m = now.getHours() * 60 + now.getMinutes() - range.startHour * 60;
  return m < 0 || m > (range.endHour - range.startHour) * 60 ? null : m;
}
