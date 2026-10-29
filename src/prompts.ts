import type { AdhocTask, ProjectSnapshot, RepoState } from "./schema";

const READ_ONLY = "Never send, post, react, draft, or modify anything. Only read.";
const JSON_ONLY = "Output ONLY the JSON object: no prose, no code fence.";

/** ISO date (YYYY-MM-DD) and unix seconds for an incremental read window. */
export function windowStart(lastRefreshedAt: string | null, now: Date, firstRunDays: number) {
  // Overlap by an hour so messages near the boundary aren't lost.
  const start = lastRefreshedAt
    ? new Date(new Date(lastRefreshedAt).getTime() - 60 * 60 * 1000)
    : new Date(now.getTime() - firstRunDays * 24 * 60 * 60 * 1000);
  return { date: start.toISOString().slice(0, 10), unix: Math.floor(start.getTime() / 1000) };
}

export function discoveryPrompt(): string {
  return `Find the current Slack user's ID (call slack_read_user_profile with no user_id) and every Slack channel they are a member of whose name starts with "tmp-". Use slack_list_user_channels with name_prefix "tmp-" and exclude_archived true, paging through all results.
${READ_ONLY}
${JSON_ONLY} Shape: {"user_id": string, "channels": [{"channel_id": string, "name": string}]}. Names have no leading "#".`;
}

export interface ProjectPromptInput {
  channelId: string;
  channelName: string;
  userId: string;
  previous: ProjectSnapshot | null;
  lastRefreshedAt: string | null;
  repoState: RepoState | null;
  now: Date;
}

export function projectPrompt(p: ProjectPromptInput): string {
  const since = windowStart(p.lastRefreshedAt, p.now, 14);
  const reading = p.previous
    ? `You already have a snapshot from ${p.lastRefreshedAt}:
${JSON.stringify(p.previous)}

Read only what changed since then:
- slack_read_channel on ${p.channelId} with oldest=${since.unix} for new top-level messages.
- slack_search_public_and_private with query "in:<#${p.channelId}> after:${since.date}" to catch new replies in older threads. Open a thread with slack_read_thread only when the new reply matters for status, blockers, or requests of the user.
- If a waiting_on item or task in the snapshot may have been resolved, check its thread.
Then update the snapshot: keep items that still hold, drop resolved ones, add new ones, and revise status, summary and last_activity. If nothing changed, return the snapshot as is.`
    : `Read the last 14 days of the channel (slack_read_channel with oldest=${since.unix}, response_format "concise"), and open every thread that has replies with slack_read_thread.`;

  const repos =
    p.repoState && (p.repoState.local.length || p.repoState.prs.length)
      ? `\nLocal repo and GitHub PR state for this project (from git and gh): ${JSON.stringify(p.repoState)}\nPRs waiting on review count as waiting_on the reviewer when the channel shows who it is.`
      : "";

  return `You maintain a status snapshot of one project for the user, Slack user ${p.userId}.
The project channel is #${p.channelName} (${p.channelId}). Do not look at other channels.

${reading}
${repos}

Definitions:
- status: "blocked" = progress cannot continue until someone else acts; "at_risk" = a deadline or scope is threatened, or an important dependency is late; "on_track" = moving normally; "idle" = no meaningful activity in 14 days.
- status_reason: one or two sentences explaining the status, naming the specific late item or dependency.
- waiting_on: people other than the user who owe an answer, review, decision, or deliverable that the project needs. "since" is the date it was asked or promised; "link" is the message permalink.
- my_tasks: things the user was asked to do or committed to and hasn't visibly done. "id" is the permalink of the message that created the task, so it stays stable across refreshes. "due" is YYYY-MM-DD or null.
- summary: three to five sentences on where the project stands.
- last_activity: YYYY-MM-DD of the latest message.

${READ_ONLY}
${JSON_ONLY} Shape:
{"status": "on_track"|"at_risk"|"blocked"|"idle", "status_reason": string,
 "waiting_on": [{"person": string, "slack_user_id": string|null, "what": string, "since": "YYYY-MM-DD"|null, "link": string|null}],
 "my_tasks": [{"id": string, "title": string, "link": string|null, "due": "YYYY-MM-DD"|null}],
 "summary": string, "last_activity": "YYYY-MM-DD"|null}`;
}

export interface AdhocPromptInput {
  userId: string;
  previous: AdhocTask[];
  lastRefreshedAt: string | null;
  now: Date;
}

export function adhocPrompt(p: AdhocPromptInput): string {
  const since = windowStart(p.lastRefreshedAt, p.now, 7);
  return `Build the user's list of open ad-hoc tasks: requests or commitments that are NOT part of a project channel (channels named tmp-*). The user is Slack user ${p.userId}.

Currently open tasks from the last refresh (${p.lastRefreshedAt ?? "never"}):
${JSON.stringify(p.previous)}

Look for new items since ${since.date}:
- Slack: slack_search_public_and_private with "<@${p.userId}> after:${since.date}" and with "is:dm after:${since.date}". Skip anything in a tmp-* channel. A task is a direct request of the user, a question awaiting their answer, or something they said they'd do.
- Gmail: search_threads with "in:inbox after:${since.date.replaceAll("-", "/")} -category:promotions -category:social -category:updates". A task is a thread where a person (not an automated sender) asks the user to reply, decide, review, or do something, and the user hasn't replied after that ask.
Also check whether each currently open task has been resolved (the user replied or did it, or the requester withdrew it); open its thread only if unsure.

Return the full list of tasks that are still open: carried-over ones that aren't resolved, plus new ones.
- id: for Slack, the message permalink; for email, "gmail:<thread id>". Reuse the existing id for carried-over tasks.
- title: a short imperative, e.g. "Reply to Ana about the Q4 refund numbers".
- requester: the person's name. due: YYYY-MM-DD or null. link: permalink or Gmail URL "https://mail.google.com/mail/u/0/#all/<thread id>".
- description: two to four sentences: what exactly is being asked, by whom and why, and any context or constraints from the thread. Keep a carried-over task's description unless the thread added something.
- follow_up: the single next action that would close or advance the task. kind is one of "reply" (answer in the thread or email), "review" (read or review a doc, PR or design), "decide" (make a call others are waiting on), "do" (produce something: a ticket, doc, update), "schedule" (set up a meeting), "share" (send something to someone). action is one specific imperative sentence that names where and with what, e.g. "Reply in the #asset-store-eng thread with the Nov 17 dev-complete date".

${READ_ONLY}
${JSON_ONLY} Shape: {"tasks": [{"id": string, "title": string, "description": string, "source": "slack"|"email", "follow_up": {"kind": "reply"|"review"|"decide"|"do"|"schedule"|"share", "action": string}, "requester": string|null, "link": string|null, "due": "YYYY-MM-DD"|null}]}`;
}

export interface CalendarPromptInput {
  date: string;
  timeZone: string;
  projectNames: string[];
}

export function calendarPrompt(p: CalendarPromptInput): string {
  return `Build the user's meeting plan for ${p.date} (time zone ${p.timeZone}).

1. list_events on the primary calendar for ${p.date}, 00:00 to 23:59 in ${p.timeZone}. Skip events the user declined, all-day events, working-location and out-of-office entries, and focus-time blocks.
2. For each meeting, work out concrete prep the user should do beforehand. Look at the event description and attachments, and search Slack (slack_search_public_and_private) and Gmail (search_threads) from the last 7 days for the meeting title or its agenda. Prep must be a specific action ("Read the refunds QA doc", "Bring the dev-complete date for asset refunds"); leave prep empty when nothing specific is needed. Don't invent prep.
3. related_project: the matching name from this list if the meeting is clearly about one of them, else null: ${JSON.stringify(p.projectNames)}

- id: the calendar event id. Prep id: "<event id>#<short-kebab-slug>", stable for the same prep item.
- start and end: ISO 8601 with offset. attendees: display names (not the user), at most 8. link: the event's htmlLink.

${READ_ONLY}
${JSON_ONLY} Shape: {"date": "${p.date}", "events": [{"id": string, "title": string, "start": string, "end": string, "attendees": [string], "link": string|null, "related_project": string|null, "prep": [{"id": string, "title": string, "link": string|null}]}]}`;
}

export interface PlanPromptInput {
  title: string;
  description: string | null;
  link: string | null;
  requester: string | null;
  source: string;
  userId: string | null;
}

export function planPrompt(p: PlanPromptInput): string {
  return `The user (a product manager on Unity's Asset Store${p.userId ? `, Slack user ${p.userId}` : ""}) has this task and wants a proposed plan for getting it done.

Task: ${p.title}
${p.description ? `Description: ${p.description}\n` : ""}${p.requester ? `Requested by: ${p.requester}\n` : ""}Source: ${p.source}${p.link ? ` (${p.link})` : ""}

First research it. Read the source thread if there's a link. Search Slack, Gmail, Google Drive and Jira for related discussion, docs and tickets, and ask U-Know for Unity-specific context when the task depends on internal systems, teams or processes. Spend effort in proportion to the task: a quick reply needs little research.

Then propose a plan:
- approach: two to four sentences on how to tackle it and what "done" looks like.
- steps: three to eight concrete, ordered actions the user can take, e.g. "Ask Kim in #tmp-x whether UPM dependencies show on the PDP", "Draft the ticket in CPS with these acceptance criteria: …". Name the people, channels, docs and tickets involved. detail adds specifics; link points at the relevant doc, ticket or thread if there is one.
- open_questions: what's unclear or needs a decision before or during the work. Empty if none.
- sources: the threads, docs and tickets you relied on.

${READ_ONLY} Don't take any of the steps yourself; only propose them.
${JSON_ONLY} Shape: {"approach": string, "steps": [{"title": string, "detail": string|null, "link": string|null}], "open_questions": [string], "sources": [{"title": string, "link": string}]}`;
}
