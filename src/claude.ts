import { PLAN_RULES, STEP_RULE, WRITING_RULES } from "./baseLessons";
import { z } from "zod";
import { runCliStreaming, type StreamingCliRunner } from "./cli";

// Read-only connector tools. Nothing here can send, post, draft or edit.
const SLACK = "mcp__claude_ai_Slack__";
const GMAIL = "mcp__claude_ai_Gmail__";
const GCAL = "mcp__claude_ai_Google_Calendar__";
const ZOOM = "mcp__claude_ai_Zoom_for_Claude__";
const GRANOLA = "mcp__claude_ai_Granola__";
const AMPLITUDE = "mcp__claude_ai_Amplitude__";

export const TOOLS = {
  slackRead: [
    `${SLACK}slack_list_user_channels`,
    `${SLACK}slack_read_channel`,
    `${SLACK}slack_read_thread`,
    `${SLACK}slack_search_public_and_private`,
    `${SLACK}slack_search_public`,
    `${SLACK}slack_search_channels`,
    `${SLACK}slack_read_user_profile`,
    `${SLACK}slack_search_users`,
    `${SLACK}slack_list_channel_members`,
    `${SLACK}slack_read_canvas`,
    `${SLACK}slack_read_file`,
    `${SLACK}slack_read_list`,
    `${SLACK}slack_get_reactions`,
  ],
  gmailRead: [`${GMAIL}search_threads`, `${GMAIL}get_thread`, `${GMAIL}get_message`, `${GMAIL}list_labels`],
  calendarRead: [`${GCAL}list_calendars`, `${GCAL}list_events`, `${GCAL}get_event`, `${GCAL}search_events`, `${GCAL}suggest_time`],
  driveRead: [
    "mcp__claude_ai_Google_Drive__search_files",
    "mcp__claude_ai_Google_Drive__read_file_content",
    "mcp__claude_ai_Google_Drive__get_file_metadata",
    "mcp__claude_ai_Google_Drive__list_recent_files",
    // The contents of Google Docs, Sheets and Slides, and Claude Docs (the artifacts people share
    // from Claude): reading only.
    "mcp__claude_ai_Google_Docs__read_doc",
    "mcp__claude_ai_Google_Sheets__get_spreadsheet",
    "mcp__claude_ai_Google_Sheets__get_values",
    "mcp__claude_ai_Google_Slides__read_presentation",
    "mcp__claude_ai_Google_Slides__read_slide_page",
    "mcp__claude_ai_Google_Slides__read_slide_page_thumbnail",
    "mcp__claude_ai_Claude_Docs__read",
    "mcp__claude_ai_Claude_Docs__query",
    "mcp__claude_ai_Claude_Docs__guide",
  ],
  jiraRead: ["mcp__mcp-jira__jira_search", "mcp__mcp-jira__jira_get_issue"],
  /**
   * Amplitude product analytics, reading only: its context, taxonomy and saved charts, and ad-hoc
   * queries. Nothing that creates, changes or shares (events, properties, dashboards, flags, cohorts,
   * comments), none of its UI widgets (render_*), and not run_amp, which can write.
   */
  amplitudeRead: [
    "get_amplitude_context",
    "search_amp_entities",
    "search_amp_data_taxonomy",
    "get_amp_taxonomy",
    "get_amplitude_charts",
    "query_amplitude_data",
    "get_from_url",
    "get_amp_user_data",
    "get_group_types",
    "get_amp_session_replay_info",
    "get_agent_results",
    "use_amplitude_ai_feedback",
  ].map((t) => `${AMPLITUDE}${t}`),
  /**
   * Amplitude feature-flag experiments and flags: reading and analyzing them, and also creating,
   * changing, starting and rolling them out (one tool does both, by its action), so given only to a
   * task's chat, where the user is in the conversation, and only told to change one when asked.
   */
  amplitudeExperiments: ["use_amp_experiments", "use_amp_flags"].map((t) => `${AMPLITUDE}${t}`),
  /** Zoom meetings: their AI summaries, notes, transcripts and recordings, reading only. */
  zoomRead: [
    "search_meetings",
    "get_meeting_assets",
    "get_recording_resource",
    "recordings_list",
    "my_notes_get_note_content",
    "search",
    "search_describe_capabilities",
    "ask",
  ].map((t) => `${ZOOM}${t}`),
  /** Granola: the user's meetings, their notes and transcripts, reading only. */
  granolaRead: [
    "get_meetings",
    "search_meetings",
    "query_granola_meetings",
    "get_meeting_transcript",
    "search_transcripts",
    "get_meeting_attachment",
    "list_meeting_folders",
  ].map((t) => `${GRANOLA}${t}`),
  /** Reading the user's own DM, for #demian messages. */
  selfDmRead: [`${SLACK}slack_read_channel`],
  /**
   * Answering the #demian messages once Demian has acted on them: a reaction, and a reply in the
   * message's thread with what it did. Only ever in the user's DM with themselves.
   */
  selfDmReply: [`${SLACK}slack_add_reaction`, `${SLACK}slack_send_message`],
  /** The one write tool, used only to post a reminder the user wrote and clicked Send on. */
  slackSend: [`${SLACK}slack_send_message`],
  /** Opening a group DM, used only to send a message the user reviewed and clicked Send on to several people. */
  slackGroupDm: [`${SLACK}slack_create_conversation`],
  /** Creating a Google Doc, used only for a doc the user reviewed and clicked Create on. */
  docCreate: ["mcp__claude_ai_Google_Drive__create_file"],
  /** Creating a calendar event, used only for an invite the user reviewed and clicked Create on. */
  eventCreate: [`${GCAL}create_event`, `${GCAL}suggest_time`],
  /** Filing a Jira ticket, used only for one the user reviewed and clicked Create on: create it, put it in its epic, link it. */
  ticketCreate: ["mcp__mcp-jira__jira_create_issue", "mcp__mcp-jira__jira_link_to_epic", "mcp__mcp-jira__jira_create_issue_link", "mcp__mcp-jira__jira_get_issue", "mcp__mcp-jira__jira_search"],
};

// User settings can route Claude Code through a gateway (ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json). That replaces the claude.ai
// login, which disables the claude.ai connectors these jobs depend on, so blank
// them for the app's runs only.
/**
 * Settings for every run: the claude.ai login (a gateway login would hide the connectors), and file
 * tools kept to the run's own folders and the code folders it's given. Without that, a run looking
 * for code could search the whole home folder, and reading folders like Music, Photos or Desktop
 * makes macOS ask the user to let Demian in.
 */
const RUN_SETTINGS = JSON.stringify({
  env: { ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "" },
  permissions: { blockReadsOutsideWorkingDirectories: true },
});

// Belt and braces: built-in tools that could touch the machine are denied outright. So is U-Know,
// a company knowledge-base connector, which runs no longer use.
const DISALLOWED = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
  ...["ask_uknow", "ask_uknow_session", "list_knowledge_bases"].map((t) => `mcp__claude_ai_U-Know__${t}`),
  // The Atlassian (Rovo) connector reaches Jira Cloud, where the team's issues aren't yet: it would
  // answer with empty or stale results that read like real ones. Jira comes from mcp-jira only.
  "mcp__claude_ai_Atlassian",
  "mcp__claude_ai_Atlassian_Rovo",
];

/**
 * Every connector tool that posts, drafts, sends or changes something. Each run is denied all of them
 * except the ones it's given (see deniedTools): a send run gets the one tool it sends with, and no
 * other run gets any. Deny rules win over allow rules, so the user's own Claude Code settings (an
 * allow rule for Slack, say) can't hand a background run the power to post. In a chat, with these
 * gone, the only way to send is to hand the message to Orb, which sends once the user approves.
 */
export const WRITE_TOOLS = [
  ...[
    "slack_send_message",
    "slack_send_message_draft",
    "slack_schedule_message",
    "slack_create_canvas",
    "slack_update_canvas",
    "slack_add_reaction",
    "slack_create_conversation",
    "slack_create_list",
    "slack_add_list_record",
    "slack_update_list",
    "slack_update_list_record",
    "slack_get_file_upload_url",
    "slack_complete_file_upload",
  ].map((t) => `${SLACK}${t}`),
  ...[
    "create_draft",
    "update_draft",
    "send_message",
    "send_draft",
    "delete_draft",
    "reply",
    "forward",
    "trash_message",
    "trash_thread",
    "untrash_message",
    "untrash_thread",
    "mark_message_spam",
    "mark_thread_spam",
    "unmark_message_spam",
    "unmark_thread_spam",
    "label_message",
    "label_thread",
    "unlabel_message",
    "unlabel_thread",
    "update_message_labels",
    "create_label",
    "update_label",
    "delete_label",
    "apply_sensitive_message_label",
    "apply_sensitive_thread_label",
  ].map((t) => `${GMAIL}${t}`),
  ...["create_event", "update_event", "delete_event", "respond_to_event"].map((t) => `${GCAL}${t}`),
  ...[
    "jira_create_issue",
    "jira_batch_create_issues",
    "jira_update_issue",
    "jira_add_comment",
    "jira_transition_issue",
    "jira_delete_issue",
    "jira_edit_comment",
    "jira_link_to_epic",
    "jira_create_issue_link",
    "jira_remove_issue_link",
    "jira_create_remote_issue_link",
    "jira_add_worklog",
    "jira_add_watcher",
    "jira_remove_watcher",
    "jira_add_issues_to_sprint",
    "jira_create_sprint",
    "jira_update_sprint",
    "jira_create_version",
    "jira_batch_create_versions",
    "jira_update_proforma_form_answers",
  ].map((t) => `mcp__mcp-jira__${t}`),
  // Editing Google Docs, Sheets and Slides, and Claude Docs.
  "mcp__claude_ai_Google_Docs__update_doc",
  ...["update_spreadsheet", "update_values", "update_formulas", "insert_dimension", "append_values", "batch_clear_values", "copy_sheet_to_another_spreadsheet"].map(
    (t) => `mcp__claude_ai_Google_Sheets__${t}`,
  ),
  "mcp__claude_ai_Google_Slides__update_presentation",
  ...["create", "update", "delete", "batch", "export"].map((t) => `mcp__claude_ai_Claude_Docs__${t}`),
  // Zoom: scheduling, changing or controlling meetings, and its file and collaborator writes.
  ...[
    "meeting_create",
    "meeting_update",
    "meeting_delete",
    "in_meeting_control",
    "capabilities_invoke_write",
    "create_new_file_with_markdown",
    "hub_create_file_from_content",
    "canvas_add_file_collaborators",
    "canvas_modify_file_collaborator_role",
    "canvas_remove_file_collaborator",
  ].map((t) => `${ZOOM}${t}`),
  // With these visible, a session asked for a doc tries to make it itself and stalls on the
  // permission instead of handing it to Orb.
  ...["create_file", "copy_file", "update_file", "share_file", "trash_file"].map((t) => `mcp__claude_ai_Google_Drive__${t}`),
  // Amplitude: everything that creates, changes, shares or rolls out (taxonomy, dashboards, notebooks,
  // cohorts, metrics, comments, sharing, and run_amp, which can write). Its experiment and flag tools
  // also change what real users see, so they're here too; a chat gets them only on a turn you started.
  ...[
    "run_amp",
    "manage_amp_entities",
    "manage_amp_events",
    "manage_amp_properties",
    "manage_amp_branches",
    "create_group_types",
    "share_amp_entities",
    "use_amp_comments",
    "use_amp_dashboards",
    "use_amp_notebooks",
    "use_amp_experiments",
    "use_amp_flags",
    "use_amplitude_cohorts",
    "use_amplitude_metrics",
    "use_amp_ai_visibility",
  ].map((t) => `${AMPLITUDE}${t}`),
  // Granola is for reading meetings: nothing changes its notes or folders, writes summaries into it, or signs out of it.
  ...["add_note_to_folder", "create_folder", "remove_note_from_folder", "update_folder", "update_private_notes", "generate_summary", "sign_out"].map((t) => `${GRANOLA}${t}`),
];

/**
 * What a run is denied: the built-in tools that could touch the machine, and every write tool it
 * wasn't given.
 */
export function deniedTools(granted: string[]): string[] {
  const given = new Set(granted);
  return [...DISALLOWED, ...WRITE_TOOLS.filter((t) => !given.has(t))];
}

/**
 * Every run asks for nothing: a tool it wasn't given is refused outright, never offered for approval
 * (there's no one to approve it in a background run). Pinned here so the user's own default mode
 * (bypassPermissions, say) never applies to the app's runs.
 */
export const PERMISSION_MODE = "dontAsk";

/**
 * How long a run may go before it's stopped, with everything it started (see runs.rs): ten minutes
 * without a line of output means it's stuck (a connector call that never returns, say; a slow one
 * fails sooner, after five, inside the run). A refresh or plan has 45 minutes in all, a chat turn,
 * which can work through many steps, an hour.
 */
export const ONE_SHOT_LIMITS = { idleSecs: 600, totalSecs: 45 * 60 };
export const SESSION_LIMITS = { idleSecs: 600, totalSecs: 60 * 60 };

/** Corrections the user has given in the global chat; every run is told them. */
let notes: string[] = [];

export function setStandingNotes(list: string[]) {
  notes = list.map((n) => n.trim()).filter(Boolean);
}

/** The standing corrections as a system prompt addition, or "" when there are none. */
export function notesPrompt(): string {
  return notes.length
    ? `Corrections and context the user has given you about their work. Take them as true and let them shape what you find and write:\n${notes.map((n) => `- ${n}`).join("\n")}`
    : "";
}

/** Claude Code's own read-only file tools, given when a run has code folders to read (see codeArgs). */
export const CODE_TOOLS = ["Read", "Grep", "Glob"];

/** Folders of code a run may read: --add-dir for each, and the read-only file tools to read them with. */
export function codeArgs(dirs: string[] | undefined): { args: string[]; tools: string[] } {
  if (!dirs?.length) return { args: [], tools: [] };
  return { args: ["--add-dir", ...dirs], tools: CODE_TOOLS };
}

export interface ClaudeOptions<T> {
  prompt: string;
  schema: z.ZodType<T>;
  tools: string[];
  /** Code folders the run may read (local checkouts and GitHub mirrors). */
  dirs?: string[];
  model?: string;
  maxTurns?: number;
  /** Called with a plain-language description of each step Claude takes. */
  onStatus?: (status: string) => void;
}

const quoted = (text: string, max = 40) => {
  const t = text.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
};

/** What a tool call is doing, in words, for the refresh status line. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  // "mcp__claude_ai_Slack__slack_read_channel" -> "slack_read_channel"
  const tool = name.split("__").pop() ?? name;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (tool) {
    case "slack_search_public_and_private":
    case "slack_search_public": {
      const keywords = Array.isArray(input.keywords) ? (input.keywords as string[]).join(" ") : "";
      const query = [keywords, str("filters")].filter(Boolean).join(" ");
      return query ? `Searching Slack for ${quoted(query)}` : "Searching Slack";
    }
    case "slack_read_channel":
      return "Reading a Slack channel";
    case "slack_read_thread":
      return "Reading a Slack thread";
    case "slack_list_user_channels":
      return "Listing your Slack channels";
    case "slack_search_channels":
      return "Finding Slack channels";
    case "slack_read_user_profile":
    case "slack_search_users":
      return "Looking people up in Slack";
    case "search_threads":
      return str("query") ? `Searching email for ${quoted(str("query"))}` : "Searching email";
    case "get_thread":
    case "get_message":
      return "Reading an email thread";
    case "list_events":
    case "search_events":
      return "Reading your calendar";
    case "get_event":
      return "Reading a meeting";
    case "list_calendars":
      return "Finding your calendars";
    case "slack_read_canvas":
    case "slack_read_file":
    case "slack_read_list":
      return "Reading something shared in Slack";
    case "slack_list_channel_members":
    case "slack_get_reactions":
      return "Checking who's in a Slack conversation";
    case "read_doc":
      return "Reading a Google Doc";
    case "get_spreadsheet":
    case "get_values":
      return "Reading a spreadsheet";
    case "read_presentation":
    case "read_slide_page":
    case "read_slide_page_thumbnail":
      return "Reading slides";
    // Claude Docs: the artifacts people share from Claude.
    case "read":
    case "query":
    case "guide":
      return "Reading a Claude doc";
    case "list_recent_files":
      return "Looking at recent Drive files";
    case "search_files":
      return "Searching Google Drive";
    case "read_file_content":
    case "get_file_metadata":
      return "Reading a doc";
    case "jira_search":
      return str("jql") ? `Searching Jira for ${quoted(str("jql"))}` : "Searching Jira";
    case "jira_get_issue":
      return str("issue_key") ? `Reading ${str("issue_key")}` : "Reading a Jira issue";
    case "Read":
      return str("file_path") ? `Reading ${str("file_path").split("/").pop()}` : "Reading the code";
    case "Grep":
      return str("pattern") ? `Searching the code for ${quoted(str("pattern"))}` : "Searching the code";
    case "Glob":
      return "Looking through the code";
    default:
      return "Working";
  }
}

export interface ClaudeResult<T> {
  data: T;
  costUsd: number;
  durationMs: number;
}

/** Pulls the JSON object out of a reply that may be wrapped in prose or a code fence. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in Claude's reply");
  return JSON.parse(text.slice(start, end + 1));
}

interface Envelope {
  is_error: boolean;
  result: string;
  total_cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
}

/**
 * The final summary from a stream-json transcript: the line with type "result".
 * Falls back to a single JSON object, which is what --output-format json prints.
 */
export function findEnvelope(stdout: string): Envelope | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && (obj.type === "result" || ("is_error" in obj && "result" in obj))) return obj as Envelope;
    } catch {
      // Not JSON (a stray log line); keep looking.
    }
  }
  return null;
}

/** Reports each tool call in a streamed transcript line as a status. */
function reportLine(line: string, onStatus: (s: string) => void) {
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant") {
      for (const part of obj.message?.content ?? []) {
        if (part.type === "tool_use") onStatus(describeTool(part.name, part.input ?? {}));
        else if (part.type === "text") onStatus("Writing it up");
      }
    }
  } catch {
    // Ignore partial or non-JSON lines.
  }
}

/**
 * The command line for a one-shot run. The prompt itself goes on stdin and the system prompt in a
 * file (see CliInput), so the arguments stay short on every platform.
 */
export function oneShotArgs(opts: Pick<ClaudeOptions<unknown>, "model" | "maxTurns" | "tools" | "dirs">, resumeSession?: string): string[] {
  const code = codeArgs(opts.dirs);
  const tools = [...opts.tools, ...code.tools];
  return [
    ...code.args,
    ...(resumeSession ? ["--resume", resumeSession] : []),
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    RUN_SETTINGS,
    "--permission-mode",
    PERMISSION_MODE,
    "--model",
    opts.model ?? "opus",
    "--max-turns",
    String(opts.maxTurns ?? 40),
    // A job with no tools (like the daily reading) must not pass a bare --allowedTools.
    ...(tools.length ? ["--allowedTools", ...tools] : []),
    "--disallowedTools",
    ...deniedTools(tools),
  ];
}

async function callOnce(
  prompt: string,
  opts: ClaudeOptions<unknown>,
  run: StreamingCliRunner,
  resumeSession?: string,
): Promise<Envelope> {
  const onStatus = opts.onStatus;
  const notes = notesPrompt();
  const out = await run(
    "claude",
    oneShotArgs(opts, resumeSession),
    onStatus ? (line) => reportLine(line, onStatus) : undefined,
    { stdin: prompt, ...(notes ? { appendSystemPrompt: notes } : {}) },
    { limits: ONE_SHOT_LIMITS },
  );
  const envelope = findEnvelope(out.stdout);
  if (!envelope) throw new Error(`claude exited ${out.code}: ${(out.stderr || out.stdout).slice(-500)}`);
  if (envelope.is_error) throw new Error(`claude: ${envelope.result}`);
  return envelope;
}

/**
 * Runs headless Claude and validates its reply against `schema`.
 * On a schema failure it resumes the same session once and asks for a fix,
 * so the connector reads aren't repeated.
 */
export async function runClaude<T>(opts: ClaudeOptions<T>, run: StreamingCliRunner = runCliStreaming): Promise<ClaudeResult<T>> {
  let prompt = opts.prompt;
  let session: string | undefined;
  let costUsd = 0;
  let durationMs = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const envelope = await callOnce(prompt, opts as ClaudeOptions<unknown>, run, session);
    costUsd += envelope.total_cost_usd ?? 0;
    durationMs += envelope.duration_ms ?? 0;
    let problem: string;
    try {
      const parsed = opts.schema.safeParse(extractJson(envelope.result));
      if (parsed.success) return { data: parsed.data, costUsd, durationMs };
      problem = z.prettifyError(parsed.error);
    } catch (e) {
      problem = (e as Error).message;
    }
    if (attempt === 1) throw new Error(`Claude's reply didn't match the schema: ${problem}`);
    session = envelope.session_id;
    prompt = `Your reply was rejected:\n${problem}\n\nReply again with ONLY the corrected JSON object.`;
    if (!session) prompt = `${opts.prompt}\n\n${prompt}\n\nPrevious reply:\n${envelope.result}`;
  }
  throw new Error("unreachable");
}

export interface SessionTurn {
  sessionId: string | null;
  costUsd: number;
  /** Claude stopped on an error (out of turns, a refused tool, not signed in) rather than finishing its turn. */
  error: string | null;
}

/**
 * Runs one turn of a working session in the background: a new session from `prompt`, or, with
 * `resume`, the next turn of an existing one with `prompt` as the user's message. Unlike runClaude
 * there's no reply to parse: the session reports through its transcript ("[orb] …" lines), which
 * Orb reads, and it stays a real Claude Code session the user can open in Claude Desktop.
 */
/**
 * Where a background session's words end up and how to keep Orb's step list in step, given on
 * every turn (so sessions already under way pick it up too): Orb shows the conversation in a chat,
 * as plain text, beside the plan's steps.
 */
export const SESSION_DISPLAY = [
  "Nobody reads this conversation here. My day planner, Orb, shows our conversation in a chat window, next to my reply box, as plain text.",
  "So write to me conversationally, the way you'd message a colleague: short plain sentences and paragraphs. Don't open with a title or heading line; start straight in with what you have to say. Don't use markdown: no headings, bold or italics, bullet or numbered lists, tables, code formatting or horizontal rules. If you need to give me options, say them in a sentence (\"0.92, or 0.85?\").",
  "Keep it brief: say what you did or found, and what you need from me, if anything. Put links in as plain URLs.",
  "The [orb] progress lines and send blocks are the exception: keep writing them exactly as described. Orb hides them from the chat.",
  "You can't post to Slack or send anything yourself: this session's send tools are turned off, and Orb does the sending once I approve. When a Slack message is ready, even one I've told you to send, hand it to Orb as a block: a line `[orb] send step N to <#channel-name, @person for a DM (their Slack user ID, like @U0123ABCD, when you know it, else their full name), for a group DM each of its people the same way, comma-separated (@U0123ABCD, @U0456EFGH), or the permalink of the thread to reply in> (<where that is, in words: '#channel-name', 'DM with Ana' or 'group DM with Ana, Ben'>)`, then the message exactly as it should be posted, then a line `[orb] end`. Then write `[orb] step N waiting: review and send the message` and stop. Orb tells you once it's sent, with its link.",
  "Don't try to save memories, notes or files (you can't write files here). When I state a lasting preference about how I work or how you should plan, write or prioritize (\"don't make tasks for hypothetical future work\"), hand it to Orb on its own line: `[orb] remember <scope>: <the preference, as an instruction>`, where scope is plans, writing, tasks, priority, projects or global. Orb keeps it and applies it to every later plan, refresh and session; tell me it's saved.",
  "You can read only the folders this session was given: you can't add one (no /add-dir here), and don't suggest changing settings to get at others. When you need code you weren't given, write `[orb] code <owner/name on GitHub, the repo's name, or the checkout's folder>` on its own line, say in a sentence what you're getting, and stop. Orb adds it if it's a code checkout on this computer or a GitHub repo it can copy, then tells you to carry on.",
  "To find a conversation with someone in Slack, look up their user id first (slack_search_users), then search with `with:<@USERID>` (a name there doesn't match) and include DMs and group DMs (channel_types \"public_channel,private_channel,mpim,im\"). Try a few searches (by person, by channel, by a distinctive word) before saying you can't find something, and say what you searched.",
  "You can read my Google Calendar (list, search and open events, and find free time with suggest_time), so use it whenever a step depends on my schedule or a meeting; don't say you lack calendar access. You can't create, change or answer events yourself, but Orb can: when I want a meeting scheduled, find a time that works for everyone: get each attendee's email address (slack_search_users, then slack_read_user_profile, or from my email), then call suggest_time with all of them, me included, over the next few working days in working hours (or the window I asked for), and take the earliest slot it gives that's free for every one of them. Never guess a time or pick one from my calendar alone. Then hand the invite to Orb as a block: a line `[orb] event step N: <the event's title>` (or `[orb] event: <title>` when it isn't a plan step), then lines `when: <date, start and end time, e.g. 2026-11-04 14:00-14:30>`, `who: <attendees' email addresses, comma separated>` (look them up in Slack or my email if you need to; leave the line out for a hold on my own calendar), `meet: yes` for a video call, then a blank line and the description, then `[orb] end`. Tell me in a line that the time is free for everyone, or who you couldn't check. Then, if it's a plan step, write `[orb] step N waiting: review and create the invite`, and stop. Orb shows it to me to review, creates it and sends the invites, then tells you its link.",
  "You can't create Jira tickets yourself (its write tools are turned off here), but Orb can: whenever I ask for a ticket, never say you can't file it or that it's my step. Hand it to Orb as a block: a line `[orb] ticket step N: <the ticket's summary>` (or `[orb] ticket: <summary>` when it isn't a plan step), then lines `project: <project key, e.g. ABC>`, `type: <Task, Bug, Story…>`, and when they apply `epic: <epic key>`, `component: <name>`, `priority: <name>`, `labels: <comma separated>`, `links: <KEY (relates to)>, …`, then a blank line and the description (may be empty), then `[orb] end`. Match the project's other tickets (look at a few in the same epic). If I've never filed a ticket in that project (jira_search `project = KEY AND reporter = currentUser()` finds none), say so in a line when you hand it over: I may not be able to create tickets there, and someone on that team could file it instead. Then, if it's a plan step, write `[orb] step N waiting: review and create the ticket`, and stop. Orb shows it to me to review, files it in Jira as me, then tells you its link. Filing it is your step, not mine.",
  "You can't create Google Docs yourself either: Drive's write tools are turned off here, so whenever I ask for a doc (\"make this a Google doc\", \"put the plan in a doc\"), never try a Drive tool or tell me it needs a permission; hand it to Orb. When a doc is ready (a brief, a summary, a spec), hand it to Orb as a block: a line `[orb] doc step N: <the doc's title>` (or `[orb] doc: <title>` when it isn't a plan step), then the doc's content in Markdown (headings, lists and tables are fine there), then a line `[orb] end`. Then, if it's a plan step, write `[orb] step N waiting: review and create the doc`, and stop. Orb shows it to me to review and creates it in my Google Drive, then tells you its link.",
  "Think things through before you agree with something or draft a reply on it. Test what you're told (by a colleague, a doc or a search result) against what you know of the task: the numbers involved, who asked and why, what's been done before. Search Slack and Jira for precedent, and when a claim doesn't fit (a limit far below what's needed, a process that doesn't explain why the person reached out), say so and dig before writing anything. Don't hand me a draft that just restates an answer you haven't checked.",
  "You can read and analyze my Amplitude experiments and feature flags (use_amp_experiments, use_amp_flags). The same tools can also create, change, start or roll out an experiment or flag, which changes what real users see: only do that when I've asked for that exact change in this chat, and tell me what you'll change, in which project, before you do it.",
  `How to get plans and messages right (my own lessons, given with each turn, win where they differ): ${[...PLAN_RULES, ...WRITING_RULES].join(" ")}`,
  "Find answers yourself before asking anyone. Search the code you can read (Read, Grep, Glob over the folders you're given), Jira, Slack, my email, Drive, Zoom meeting summaries and product analytics in Amplitude, and keep at it across sources before concluding something isn't written down. U-Know is off-limits here, even though its instructions may be loaded: don't try it or plan around it. Never draft a question to a colleague, or add one to a message, for something those sources can answer (whether tests cover a flow, how code behaves, a status, a decision, an owner, a link). Ask a person only for their decision, their opinion, or what only they know or haven't done yet, and then say in the message what you already checked. If you find you can't reach a source (a folder, a tool), tell me plainly which and why rather than routing the question to a person.",
  "Orb also shows the plan's steps with their progress, so keep that list true to what's actually happening.",
  "When something in our conversation finishes a step, even out of order or one of mine, report it done straight away. When a step is no longer needed, write `[orb] step N skipped: <why>` on its own line.",
  "When a step can't move until someone else acts (an answer, an approval, a fix from another team), write `[orb] step N blocked: <who or what, in a few words>`. That's different from waiting, which is for things I need to do. Report the step started or done again once it moves.",
  "When the plan itself changes (steps added, dropped, reordered, reworded, or handed to someone else, and anything I ask for that the steps don't cover, which is a new step), write the whole updated plan as a block, before you start on the change: a line `[orb] plan`, then one numbered line per step, finished ones included, with [Me] in front of mine, then a line `[orb] end`. " + STEP_RULE + " From then on, step numbers refer to that list, so report each step's state again against it.",
].join(" ");

export async function runSessionTurn(
  opts: {
    prompt: string;
    tools: string[];
    model?: string;
    effort?: "low" | "medium" | "high";
    maxTurns?: number;
    resume?: string;
    /** More for the system prompt this turn, after SESSION_DISPLAY (e.g. the steps as Orb shows them). */
    context?: string;
    /** Code folders the session may read (local checkouts and GitHub mirrors). */
    dirs?: string[];
    onStatus?: (s: string) => void;
    /** Claude's text so far this turn, as it's written (streamed), each time it grows. */
    onText?: (text: string) => void;
    /** Stops the turn when aborted (Stop in the chat); the turn then rejects with "Stopped". */
    signal?: AbortSignal;
  },
  run: StreamingCliRunner = runCliStreaming,
): Promise<SessionTurn> {
  const code = codeArgs(opts.dirs);
  const tools = [...opts.tools, ...code.tools];
  const args = [
    ...code.args,
    ...(opts.resume ? ["--resume", opts.resume] : []),
    // The prompt (the user's message) goes on stdin and the system prompt in a file; see CliInput.
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    RUN_SETTINGS,
    "--permission-mode",
    PERMISSION_MODE,
    "--model",
    opts.model ?? "opus",
    ...(opts.effort ? ["--effort", opts.effort] : []),
    "--max-turns",
    String(opts.maxTurns ?? 80),
    ...(tools.length ? ["--allowedTools", ...tools] : []),
    "--disallowedTools",
    ...deniedTools(tools),
    // Text arrives as it's written, so the chat can show the reply forming.
    ...(opts.onText ? ["--include-partial-messages"] : []),
  ];
  const { onStatus, onText } = opts;
  let text = "";
  const system = [SESSION_DISPLAY, notesPrompt(), opts.context].filter(Boolean).join("\n\n");
  const out = await run("claude", args, (line) => {
    if (onStatus) reportLine(line, onStatus);
    if (!onText) return;
    try {
      const event = JSON.parse(line).event;
      // Each of Claude's messages this turn starts a new paragraph; text deltas grow it.
      if (event?.type === "message_start" && text) text += "\n\n";
      else if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        text += event.delta.text;
        onText(text);
      }
    } catch {
      // Not a JSON line.
    }
  }, { stdin: opts.prompt, appendSystemPrompt: system }, { limits: SESSION_LIMITS, signal: opts.signal });
  const envelope = findEnvelope(out.stdout);
  if (!envelope) throw new Error(`claude exited ${out.code}: ${(out.stderr || out.stdout).slice(-500)}`);
  return {
    sessionId: envelope.session_id ?? null,
    costUsd: envelope.total_cost_usd ?? 0,
    error: envelope.is_error ? envelope.result || "Claude stopped with an error" : null,
  };
}
