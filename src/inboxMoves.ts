/**
 * Updates you move to the inbox (Move to inbox on an update): a project update or a piece of news
 * that turns out to need a response from you becomes an inbox item, with Draft response, Create as
 * task and Mark as handled like any other. It keeps the update's key as its id, so it doesn't show
 * in Updates as well.
 *
 * The Slack and email refresh writes the inbox afresh each time, so moved updates are kept apart
 * from it (see db.moveToInbox) and added to it when it's read.
 */
import type { QuickReply } from "./schema";

/**
 * The key an update goes by: its read state, and its id once moved to the inbox. A project's update
 * by its permalink (or its text, so the state survives refreshes), a piece of news by its id.
 */
export const projectUpdateKey = (channelId: string, u: { link?: string | null; summary: string }) => `update:${u.link ?? `${channelId}:${u.summary}`}`;
export const newsKey = (n: { id: string }) => `update:${n.id}`;

/** An update as the Updates stack shows it. */
export interface UpdateItem {
  key: string;
  /** The project it's about, or where the news was ("#channel", "Email: <subject>"). */
  label: string;
  text: string;
  link?: string | null;
  date?: string | null;
}

/** The inbox item an update becomes. */
export function inboxItemFromUpdate(u: UpdateItem): QuickReply {
  const email = /^email:/i.test(u.label) || !!u.link && (u.link.includes("mail.google.com") || u.link.startsWith("gmail:"));
  return {
    id: u.key,
    source: email ? "email" : "slack",
    from: u.label,
    summary: u.text,
    where: null,
    received: u.date ?? null,
    link: u.link ?? null,
  };
}

/** The refresh's inbox, plus the updates you moved there that it doesn't already have. */
export function withMovedUpdates(replies: QuickReply[], moved: QuickReply[]): QuickReply[] {
  const ids = new Set(replies.map((r) => r.id));
  return [...replies, ...moved.filter((r) => !ids.has(r.id))];
}
