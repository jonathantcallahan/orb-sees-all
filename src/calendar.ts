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

/** 8am to 6pm, stretched to fit any meeting that starts earlier or ends later. */
export function dayRange(events: Pick<CalendarEvent, "start" | "end">[]): DayRange {
  let startHour = 8;
  let endHour = 18;
  for (const e of events) {
    startHour = Math.min(startHour, Math.floor(minutesOfDay(e.start) / 60));
    const end = minutesOfDay(e.end);
    // A meeting ending at midnight reads as 0; treat it as the end of the day.
    endHour = Math.max(endHour, Math.ceil((end === 0 ? 24 * 60 : end) / 60));
  }
  return { startHour, endHour: Math.min(endHour, 24) };
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
      const start = minutesOfDay(event.start);
      const rawEnd = minutesOfDay(event.end);
      const end = rawEnd <= start ? 24 * 60 : rawEnd;
      return { event, start, end };
    })
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
