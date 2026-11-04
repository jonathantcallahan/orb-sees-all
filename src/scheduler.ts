export interface MorningSchedule {
  /** "HH:MM", local time. */
  time: string;
  weekdaysOnly: boolean;
}

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * True when the morning refresh is due: it's past the scheduled time today,
 * today counts (weekday, if required), and no full refresh has run today.
 * Checked every minute and on launch, so a Mac that slept through the
 * scheduled time catches up when it wakes.
 */
export function shouldRunMorning(now: Date, schedule: MorningSchedule, lastFullRefreshDate: string | null): boolean {
  const day = now.getDay();
  if (schedule.weekdaysOnly && (day === 0 || day === 6)) return false;
  if (lastFullRefreshDate === localDate(now)) return false;
  const [h, m] = schedule.time.split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

/** A time: just the time when it's today, otherwise just the day ("Yesterday", "Oct 27"); bare dates as "Oct 27". */
export function formatWhen(received: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(received)) {
    return new Date(`${received}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  }
  const d = new Date(received);
  if (Number.isNaN(d.getTime())) return received;
  // Only today's need a time; any other day is just the day.
  const day = localDate(d);
  if (day === localDate(new Date())) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (day === localDate(new Date(Date.now() - 86_400_000))) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
