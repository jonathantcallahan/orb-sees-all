import { z } from "zod";
import { runCli, type CliRunner } from "./cli";

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

async function callOnce(
  prompt: string,
  opts: ClaudeOptions<unknown>,
  run: CliRunner,
  resumeSession?: string,
): Promise<Envelope> {
  const args = [
    ...(resumeSession ? ["--resume", resumeSession] : []),
    "-p",
    prompt,
    "--output-format",
    "json",
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
  const out = await run("claude", args);
  let envelope: Envelope;
  try {
    envelope = JSON.parse(out.stdout);
  } catch {
    throw new Error(`claude exited ${out.code}: ${(out.stderr || out.stdout).slice(0, 500)}`);
  }
  if (envelope.is_error) throw new Error(`claude: ${envelope.result}`);
  return envelope;
}

/**
 * Runs headless Claude and validates its reply against `schema`.
 * On a schema failure it resumes the same session once and asks for a fix,
 * so the connector reads aren't repeated.
 */
export async function runClaude<T>(opts: ClaudeOptions<T>, run: CliRunner = runCli): Promise<ClaudeResult<T>> {
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
