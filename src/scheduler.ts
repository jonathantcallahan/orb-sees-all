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
