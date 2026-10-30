import { z } from "zod";
import { runCliStreaming, type StreamingCliRunner } from "./cli";

// Read-only connector tools. Nothing here can send, post, draft or edit.
const SLACK = "mcp__claude_ai_Slack__";
const GMAIL = "mcp__claude_ai_Gmail__";
const GCAL = "mcp__claude_ai_Google_Calendar__";

export const TOOLS = {
  slackRead: [
    `${SLACK}slack_list_user_channels`,
    `${SLACK}slack_read_channel`,
    `${SLACK}slack_read_thread`,
    `${SLACK}slack_search_public_and_private`,
    `${SLACK}slack_search_channels`,
    `${SLACK}slack_read_user_profile`,
    `${SLACK}slack_search_users`,
  ],
  gmailRead: [`${GMAIL}search_threads`, `${GMAIL}get_thread`, `${GMAIL}get_message`],
  calendarRead: [`${GCAL}list_calendars`, `${GCAL}list_events`, `${GCAL}get_event`, `${GCAL}search_events`],
  driveRead: [
    "mcp__claude_ai_Google_Drive__search_files",
    "mcp__claude_ai_Google_Drive__read_file_content",
    "mcp__claude_ai_Google_Drive__get_file_metadata",
  ],
  jiraRead: ["mcp__mcp-jira__jira_search", "mcp__mcp-jira__jira_get_issue"],
  /** The one write tool, used only to post a reminder the user wrote and clicked Send on. */
  slackSend: [`${SLACK}slack_send_message`],
  // An internal knowledge-base connector (U-Know at Unity). Optional: if it isn't connected,
  // Claude just doesn't see these tools.
  uknow: [
    "mcp__claude_ai_U-Know__ask_uknow",
    "mcp__claude_ai_U-Know__ask_uknow_session",
    "mcp__claude_ai_U-Know__list_knowledge_bases",
  ],
};

// User settings can route Claude Code through a gateway (ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json). That replaces the claude.ai
// login, which disables the claude.ai connectors these jobs depend on, so blank
// them for the app's runs only.
const USE_CLAUDE_AI_LOGIN = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "" } });

// Belt and braces: built-in tools that could touch the machine are denied outright.
const DISALLOWED = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent"];

export interface ClaudeOptions<T> {
  prompt: string;
  schema: z.ZodType<T>;
  tools: string[];
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
    case "search_files":
      return "Searching Google Drive";
    case "read_file_content":
    case "get_file_metadata":
      return "Reading a doc";
    case "jira_search":
      return str("jql") ? `Searching Jira for ${quoted(str("jql"))}` : "Searching Jira";
    case "jira_get_issue":
      return str("issue_key") ? `Reading ${str("issue_key")}` : "Reading a Jira issue";
    case "ask_uknow":
    case "ask_uknow_session":
      return "Asking U-Know";
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

async function callOnce(
  prompt: string,
  opts: ClaudeOptions<unknown>,
  run: StreamingCliRunner,
  resumeSession?: string,
): Promise<Envelope> {
  const args = [
    ...(resumeSession ? ["--resume", resumeSession] : []),
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    USE_CLAUDE_AI_LOGIN,
    "--model",
    opts.model ?? "opus",
    "--max-turns",
    String(opts.maxTurns ?? 40),
    // A job with no tools (like the daily reading) must not pass a bare --allowedTools.
    ...(opts.tools.length ? ["--allowedTools", ...opts.tools] : []),
    "--disallowedTools",
    ...DISALLOWED,
  ];
  const onStatus = opts.onStatus;
  const out = await run("claude", args, onStatus ? (line) => reportLine(line, onStatus) : undefined);
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
  "You can't post to Slack or send anything yourself: this session's send tools are turned off, and Orb does the sending once I approve. When a Slack message is ready, even one I've told you to send, hand it to Orb as a block: a line `[orb] send step N to <#channel-name, or the permalink of the thread to reply in>`, then the message exactly as it should be posted, then a line `[orb] end`. Then write `[orb] step N waiting: review and send the message` and stop. Orb tells you once it's sent, with its link.",
  "Orb also shows the plan's steps with their progress, so keep that list true to what's actually happening.",
  "When something in our conversation finishes a step, even out of order or one of mine, report it done straight away. When a step is no longer needed, write `[orb] step N skipped: <why>` on its own line.",
  "When a step can't move until someone else acts (an answer, an approval, a fix from another team), write `[orb] step N blocked: <who or what, in a few words>`. That's different from waiting, which is for things I need to do. Report the step started or done again once it moves.",
  "When the plan itself changes (steps added, dropped, reordered, reworded, or handed to someone else), write the whole updated plan as a block: a line `[orb] plan`, then one numbered line per step, finished ones included, with [Me] in front of mine, then a line `[orb] end`. From then on, step numbers refer to that list, so report each step's state again against it.",
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
    onStatus?: (s: string) => void;
  },
  run: StreamingCliRunner = runCliStreaming,
): Promise<SessionTurn> {
  const args = [
    ...(opts.resume ? ["--resume", opts.resume] : []),
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    USE_CLAUDE_AI_LOGIN,
    "--model",
    opts.model ?? "opus",
    ...(opts.effort ? ["--effort", opts.effort] : []),
    "--max-turns",
    String(opts.maxTurns ?? 80),
    "--append-system-prompt",
    opts.context ? `${SESSION_DISPLAY}\n\n${opts.context}` : SESSION_DISPLAY,
    ...(opts.tools.length ? ["--allowedTools", ...opts.tools] : []),
    "--disallowedTools",
    ...DISALLOWED,
  ];
  const onStatus = opts.onStatus;
  const out = await run("claude", args, onStatus ? (line) => reportLine(line, onStatus) : undefined);
  const envelope = findEnvelope(out.stdout);
  if (!envelope) throw new Error(`claude exited ${out.code}: ${(out.stderr || out.stdout).slice(-500)}`);
  return {
    sessionId: envelope.session_id ?? null,
    costUsd: envelope.total_cost_usd ?? 0,
    error: envelope.is_error ? envelope.result || "Claude stopped with an error" : null,
  };
}
