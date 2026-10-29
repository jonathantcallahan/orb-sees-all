import type { AdhocTask, Blocker, ProjectSnapshot, QuickReply, RepoState } from "./schema";

const READ_ONLY = "Never send, post, react, draft, or modify anything. Only read.";
const JSON_ONLY = "Output ONLY the JSON object: no prose, no code fence.";

/** Shared definition of a task assessment, used by every prompt that produces tasks. */
const ASSESSMENT_GUIDE = `assessment: who can get the task done, given Claude can read and draft across Slack, email, Google Drive, Jira and Unity's internal knowledge base, but can't attend meetings, make the user's decisions, or speak for them without review.
  - automation: "human" = needs the user's judgment, relationships or presence (a decision, a negotiation, a 1:1); "assisted" = the user does it, but Claude can do much of the legwork (research, a first draft, a summary, a ticket write-up); "claude" = Claude could produce the finished result for the user to review and send (a status summary, a ticket from a clear spec, a reply that only restates facts).
  - suggestion: one sentence with a concrete first take: how to approach it, or what Claude would produce.
  - needs_details: true when the task is too vague to act on without more from the user (e.g. "Check status with Mike": status of what?). Then details_question asks the user for exactly what's missing, and suggestion says what Claude would do once it has that. Otherwise false and details_question null.
  - estimate_minutes: realistic hands-on time for the user to finish it, counting Claude's help when automation is "assisted" or "claude" (then it's mostly review time), and not counting time spent waiting on others. Use 5, 10, 15, 30, 45, 60, 90, 120, 180 or 240. For a vague task, estimate the likely version.
  - priority: how much the task matters now. "critical" = part of a P0 project, blocks others or a launch, has an exec or external deadline, or is due within two days; "high" = someone is actively waiting on it, or it moves a high-priority project; "medium" = should happen this week or two; "low" = nice to have, no one is waiting.`;
const ASSESSMENT_SHAPE = `"assessment": {"automation": "human"|"assisted"|"claude", "suggestion": string, "needs_details": boolean, "details_question": string|null, "estimate_minutes": number, "priority": "critical"|"high"|"medium"|"low"}`;

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
- If a blocker or task in the snapshot may have been resolved, check its thread.
Then update the snapshot: keep items that still hold, drop resolved ones, add new ones, and revise the rest. Fill in any field the previous snapshot is missing. If nothing changed, return the snapshot as is.`
    : `Read the last 14 days of the channel (slack_read_channel with oldest=${since.unix}, response_format "concise"), and open every thread that has replies with slack_read_thread. Read the channel's topic and purpose too (slack_search_channels), and pinned or early messages that define the project if they help.`;

  const repos =
    p.repoState && (p.repoState.local.length || p.repoState.prs.length)
      ? `\nLocal repo and GitHub PR state for this project (from git and gh): ${JSON.stringify(p.repoState)}\nA PR waiting on review is a blocker owned by the reviewer when the channel shows who it is.`
      : "";

  return `You maintain a status snapshot of one project for the user, Slack user ${p.userId}, a product manager on Unity's Asset Store.
The project channel is #${p.channelName} (${p.channelId}). Do not look at other channels.

${reading}
${repos}

Fields:
- name: the project's proper name as people refer to it, two to four words in sentence case (e.g. "Asset refunds", "UPM paid products"). Not the channel name.
- description: what the project is and what it delivers, at most two short lines (about 160 characters). No status here.
- status: "blocked" = progress cannot continue until someone acts; "at_risk" = a deadline or scope is threatened, or an important dependency is late; "on_track" = moving normally; "idle" = no meaningful activity in 14 days.
- status_reason: one short sentence that leads with the most important blocker and who it's waiting on (e.g. "Waiting on legal sign-off for screenshot search."). With no blockers, name the next milestone or what's most in motion. Don't list every blocker; they're shown separately.
- raci: the user's role, inferred from how they participate. "accountable" = they own the outcome (they set direction, make the calls, report status upward, or others ask them for decisions). "responsible" = they do the work but someone else owns the outcome. "consulted" = people ask their input but they don't drive. "informed" = they mostly read along. reason: one short sentence of evidence.
- priority: strategic priority to the business, not urgency. "P0" = company-critical: exec-visible, revenue or legal/compliance impact, or a hard external date; "P1" = a committed roadmap item or a dependency for other teams; "P2" = planned work with moderate impact; "P3" = low impact or nice to have; "P4" = exploratory, informational or social. reason: one short sentence.
- blockers: work someone is waiting on and can't proceed without until it's done: an unanswered question, a missing decision, review, ticket, or deliverable that stops someone else from working. what names the task; owners are the people responsible for it, with is_me true for the user. A project can have no blockers. id is the permalink of the message that raised it; link is the same or a better permalink; since is when it was raised (YYYY-MM-DD).
- active: planned work that's underway and isn't stopping anyone (tickets in a sprint, a doc being written, a build in progress), with the same fields; since is when it started. Don't repeat anything listed in blockers. At most five, most important first.
- my_tasks: (if the project's priority is P0, set every task's assessment priority to "critical") things the user was asked to do or committed to and hasn't visibly done, including every blocker the user owns (use the same id). id is the permalink of the message that created the task, so it stays stable across refreshes. description: two or three sentences on what exactly is needed and why. follow_up: the single next action, with kind one of "reply", "review", "decide", "do", "schedule", "share" and action one specific imperative sentence. due: YYYY-MM-DD or null. ${ASSESSMENT_GUIDE}
- recent_updates: up to three notable developments since the previous snapshot (on a first read, the last two days): a decision made, a date set or moved, something launched or merged, a new risk. One sentence each, with the date (YYYY-MM-DD) and the message permalink. Empty when nothing notable happened.
- summary: three to five sentences on where the project stands.
- last_activity: YYYY-MM-DD of the latest message.

${READ_ONLY}
${JSON_ONLY} Shape:
{"name": string, "description": string, "status": "on_track"|"at_risk"|"blocked"|"idle", "status_reason": string,
 "raci": {"role": "responsible"|"accountable"|"consulted"|"informed", "reason": string},
 "priority": {"level": "P0"|"P1"|"P2"|"P3"|"P4", "reason": string},
 "blockers": [{"id": string, "what": string, "owners": [{"name": string, "slack_user_id": string|null, "is_me": boolean}], "since": "YYYY-MM-DD"|null, "link": string|null}],
 "active": [{"id": string, "what": string, "owners": [{"name": string, "slack_user_id": string|null, "is_me": boolean}], "since": "YYYY-MM-DD"|null, "link": string|null}],
 "my_tasks": [{"id": string, "title": string, "description": string, "follow_up": {"kind": string, "action": string}, ${ASSESSMENT_SHAPE}, "link": string|null, "due": "YYYY-MM-DD"|null}],
 "recent_updates": [{"summary": string, "date": "YYYY-MM-DD"|null, "link": string|null}],
 "summary": string, "last_activity": "YYYY-MM-DD"|null}`;
}

export interface AdhocPromptInput {
  userId: string;
  previous: AdhocTask[];
  previousReplies: QuickReply[];
  lastRefreshedAt: string | null;
  now: Date;
}

export function adhocPrompt(p: AdhocPromptInput): string {
  const since = windowStart(p.lastRefreshedAt, p.now, 7);
  return `Build the user's list of open ad-hoc tasks: requests or commitments that are NOT part of a project channel (channels named tmp-*). The user is Slack user ${p.userId}.

Currently open tasks from the last refresh (${p.lastRefreshedAt ?? "never"}):
${JSON.stringify(p.previous)}

Messages waiting on a quick reply from the last refresh:
${JSON.stringify(p.previousReplies)}

Look for new items since ${since.date}:
- Slack: slack_search_public_and_private with "<@${p.userId}> after:${since.date}" and with "is:dm after:${since.date}". Skip anything in a tmp-* channel. A task is a direct request of the user, a question awaiting their answer, or something they said they'd do.
- Gmail: search_threads with "in:inbox after:${since.date.replaceAll("-", "/")} -category:promotions -category:social -category:updates". A task is a thread where a person (not an automated sender) asks the user to reply, decide, review, or do something, and the user hasn't replied after that ask.
- News beyond the project channels: list the user's channels (slack_list_user_channels, exclude_archived true) other than tmp-* ones and skim the most relevant active ones (team, product, engineering, announcement and leadership channels; at most about ten) since ${since.date} with slack_read_channel and response_format "concise". Also check Gmail for internal announcements since then (search_threads "after:${since.date.replaceAll("-", "/")} from:unity3d.com" or company-wide lists). Keep only what matters to someone working on the Asset Store, commerce and package distribution: launches, decisions, incidents, org or process changes, deadlines, dates that moved. Skip chatter, social posts and anything already covered by a task or reply.
Also check whether each currently open task has been resolved (the user replied or did it, or the requester withdrew it); open its thread only if unsure.

Sort what's still open into two lists:
- replies: every Slack message and email addressed to the user that is waiting on a response from them and that they haven't answered, quick or not.
- tasks: everything that needs real work (research, a doc, a decision with tradeoffs, a ticket, coordination), even if it ends in a reply. A message that needs both a response and real work goes in both lists, with the same id.

Return the full lists of what's still open: carried-over items that aren't resolved, plus new ones.
- id: for Slack, the message permalink; for email, "gmail:<thread id>". Reuse the existing id for carried-over tasks.
- title: a short imperative, e.g. "Reply to Ana about the Q4 refund numbers".
- requester: the person's name. due: YYYY-MM-DD or null. link: permalink or Gmail URL "https://mail.google.com/mail/u/0/#all/<thread id>".
- description: two to four sentences: what exactly is being asked, by whom and why, and any context or constraints from the thread. Keep a carried-over task's description unless the thread added something.
- follow_up: the single next action that would close or advance the task. kind is one of "reply" (answer in the thread or email), "review" (read or review a doc, PR or design), "decide" (make a call others are waiting on), "do" (produce something: a ticket, doc, update), "schedule" (set up a meeting), "share" (send something to someone). action is one specific imperative sentence that names where and with what, e.g. "Reply in the #asset-store-eng thread with the Nov 17 dev-complete date".
- ${ASSESSMENT_GUIDE}

For each news item: id is the message permalink or "gmail:<thread id>"; link is the Slack permalink or the Gmail URL "https://mail.google.com/mail/u/0/#all/<thread id>"; headline is under 12 words; detail is one sentence on why it matters to the user; where is "#channel" or "Email: <subject>"; date is YYYY-MM-DD. At most eight, most important first.

For each reply:
- id: as for tasks, reusing the existing id for carried-over replies. from: the sender's name. summary: what they asked, in under 12 words. where: "#channel", "DM" or the email subject. received: when the message was sent, as ISO 8601 date-time with offset (e.g. "2026-10-29T14:05:00-07:00"). link: as for tasks.

${READ_ONLY}
${JSON_ONLY} Shape: {"news": [{"id": string, "headline": string, "detail": string|null, "where": string|null, "date": "YYYY-MM-DD"|null, "link": string|null}], "replies": [{"id": string, "source": "slack"|"email", "from": string, "summary": string, "where": string|null, "received": string|null, "link": string|null}], "tasks": [{"id": string, "title": string, "description": string, "source": "slack"|"email", "follow_up": {"kind": "reply"|"review"|"decide"|"do"|"schedule"|"share", "action": string}, ${ASSESSMENT_SHAPE}, "requester": string|null, "link": string|null, "due": "YYYY-MM-DD"|null}]}`;
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
- summary: two or three sentences on what the meeting is likely to cover and what the user is expected to bring or decide, drawn from the description, agenda, attached docs and related threads. For a routine meeting with nothing specific, one short sentence.
- video_link: the URL to join the call: the event's Google Meet link (hangoutLink or conferenceData), or a Zoom, Teams or other meeting URL from the location or description. null when there's no call.

${READ_ONLY}
${JSON_ONLY} Shape: {"date": "${p.date}", "events": [{"id": string, "title": string, "start": string, "end": string, "attendees": [string], "link": string|null, "summary": string|null, "video_link": string|null, "related_project": string|null, "prep": [{"id": string, "title": string, "link": string|null}]}]}`;
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

export interface AssessPromptInput {
  userId: string | null;
  tasks: { id: string; title: string; description: string | null }[];
}

export function assessPrompt(p: AssessPromptInput): string {
  return `The user (a product manager on Unity's Asset Store${p.userId ? `, Slack user ${p.userId}` : ""}) keeps a personal to-do list of short notes. For each task below, work out what it means and how it could get done.

Tasks:
${JSON.stringify(p.tasks)}

For each task:
- description: when the task has no description, write two or three sentences on what it most likely involves and why, using context you find. Search Slack (slack_search_public_and_private), Gmail (search_threads) and Jira (jira_search) for the task's key terms, people and tickets; a quick search or two per task is enough. Say what you found, not what you guessed: if you found nothing, describe the task only as far as its wording supports. When the task already has a description, return null.
- ${ASSESSMENT_GUIDE}

Return exactly one entry per task, with the same id.

${READ_ONLY}
${JSON_ONLY} Shape: {"assessments": [{"id": string, "description": string|null, "automation": "human"|"assisted"|"claude", "suggestion": string, "needs_details": boolean, "details_question": string|null, "estimate_minutes": number, "priority": "critical"|"high"|"medium"|"low"}]}`;
}

export function draftReplyPrompt(r: QuickReply, userId: string | null): string {
  return `Draft a reply for the user${userId ? ` (Slack user ${userId})` : ""} to this message:
${JSON.stringify(r)}

Read the thread first (slack_read_thread or the channel for Slack, get_thread for email) so you answer what was actually asked, in context. Look at a few of the user's own recent messages in the same place to match their tone and length.

Write the reply as the user would send it: short, direct, friendly, in their voice. For Slack, no greeting or sign-off unless they use one; for email, a brief greeting and sign-off with their first name. Where the answer depends on something only the user knows, leave a clearly marked blank like [date] rather than guessing.

${READ_ONLY} Only draft; never send.
${JSON_ONLY} Shape: {"draft": string}`;
}

export function readingPrompt(context: unknown): string {
  return `You are the Orb, who sees all of the user's work. Write today's reading and pick today's recommended tasks.

Base it only on this snapshot of their day: projects with status, priority (P0 highest to P4), their role, blockers (someone is waiting), active work (underway, not blocking) and recent updates; their open tasks with ids, priority and estimates (and which they've planned for today); today's meetings; messages waiting on a quick reply; and news from around the company.
${JSON.stringify(context)}

The overwhelming focus is P0 projects. Lower-priority work only earns attention when it blocks a P0, has a hard deadline today, or takes minutes.

- reading: one paragraph (60 to 110 words). Name what will move the P0 projects forward most today (a blocker only the user can clear, a decision, a deliverable, a meeting that needs prep), say roughly how to spend the open time between meetings, and say what can wait. If a project update or piece of news changes today's priorities, weave it in; the full list of updates is shown separately, so don't recite it. Be concrete: use project, task and meeting names. Voice: calm and lightly oracular, but practical; no lists, no headings, no emoji. If there are no P0 projects, focus on the highest priority present.
- recommended: the ids (copied exactly from the tasks list) of up to five tasks the user should accomplish today to further P0 projects, most important first. Include a task not tied to a P0 project only if it clearly unblocks P0 work. Fit them in the open time today, using their estimates. Empty if nothing qualifies.

${JSON_ONLY} Shape: {"reading": string, "recommended": [string]}`;
}

/** The default reminder text, with readable @Name mentions for the user to edit. */
export function reminderText(owners: { name: string }[], what: string, link: string | null | undefined): string {
  const mentions = owners.map((o) => `@${o.name}`).join(" ");
  return `${mentions} quick nudge on this one: *${what}*. Is there anything I can do to help unblock it?${link ? `\n${link}` : ""}`;
}

/** Turns the composer's @Name mentions into Slack mentions (<@U123>) before posting. */
export function toSlackMentions(text: string, owners: { name: string; slack_user_id?: string | null }[]): string {
  return owners.reduce((t, o) => (o.slack_user_id ? t.split(`@${o.name}`).join(`<@${o.slack_user_id}>`) : t), text);
}

export function sendReminderPrompt(channelId: string, text: string): string {
  return `Post the message below to the Slack channel ${channelId} by calling slack_send_message exactly once, with channel_id "${channelId}" and the message text exactly as written: do not reword, shorten, add to, or reformat it. Do not post anywhere else and do not reply in a thread.

Message (between the markers):
<<<MESSAGE
${text}
MESSAGE>>>

After posting, ${JSON_ONLY} Shape: {"sent": boolean, "link": string|null, "error": string|null}. link is the posted message's permalink if the tool returned one.`;
}

export interface CheckBlockerInput {
  projectName: string;
  channelId: string;
  blocker: Blocker;
  userId: string | null;
}

export function checkBlockerPrompt(p: CheckBlockerInput): string {
  return `The user (${p.userId ? `Slack user ${p.userId}, ` : ""}a product manager on Unity's Asset Store) has this item listed as blocking the "${p.projectName}" project (Slack channel ${p.channelId}):
${JSON.stringify(p.blocker)}

Double check it. Dig deeper than the project channel:
1. Read the message that raised it and its thread (the link), and the latest messages in ${p.channelId}.
2. Search for anything that resolved it elsewhere: Slack across channels and DMs (slack_search_public_and_private, using the key terms and the owners' names, since the date it was raised), email (search_threads), Jira (jira_search for related tickets and their status) and Google Drive (search_files for a doc it asked for).
3. Decide whether it's accurate: is someone really unable to proceed until it's done, and is the named owner the right person?

verdict: "still_blocking" (nothing resolves it), "resolved" (it was answered, done or delivered somewhere), "partly_resolved" (some of it is done), "not_blocking" (it's real work but nobody is actually waiting on it, or it's the wrong owner), or "unclear" (not enough evidence either way).
summary: two or three sentences explaining the verdict, naming where you found the answer if it was resolved.
evidence: the threads, emails, tickets and docs that support the verdict, with links.
next_step: if it's still blocking or partly resolved, the single action that would clear it; otherwise null.

${READ_ONLY}
${JSON_ONLY} Shape: {"verdict": "still_blocking"|"resolved"|"partly_resolved"|"not_blocking"|"unclear", "summary": string, "evidence": [{"title": string, "link": string}], "next_step": string|null}`;
}
