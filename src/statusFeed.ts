/**
 * The bottom bar's line on what's loading: every action any job starts ("Reading a Slack thread",
 * "Searching for …"), written in the order they happen, so concurrent jobs interleave. Each stays
 * up a moment; when many are waiting the line speeds up rather than fall behind.
 */
export interface FeedItem {
  /** The job's key, e.g. "adhoc" or "project:C123". */
  key: string;
  text: string;
}

/** The most actions kept waiting; past this the oldest go, so the line stays close to now. */
export const FEED_MAX_WAITING = 40;

/** Adds an action to the end of the line's queue, dropping the oldest past FEED_MAX_WAITING. */
export function enqueueStep(queue: FeedItem[], item: FeedItem): FeedItem[] {
  const next = [...queue, item];
  return next.length > FEED_MAX_WAITING ? next.slice(next.length - FEED_MAX_WAITING) : next;
}

/** How long an action stays up: 800ms when the line is caught up, down to 150ms with a backlog. */
export function stepMs(waiting: number): number {
  return Math.max(150, 800 - waiting * 40);
}

/**
 * A chat's own work: a turn in a task's chat, the Demian chat, Explain or Draft (session:…), or
 * sending what one handed over (handoff:…). The chat shows that itself, so the bottom line doesn't.
 */
export function isChatJob(key: string): boolean {
  return key.startsWith("session:") || key.startsWith("handoff:");
}
