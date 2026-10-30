/**
 * The first-run check: is everything the app depends on in place? Claude Code installed, signed in
 * with a claude.ai account (only that login brings the claude.ai connectors), and the connectors
 * connected. The checks themselves are cheap: `claude auth status` costs nothing, and one tiny
 * headless run reports every connector's state in its first (init) line.
 */
import { runCli, runCliStreaming, type CliRunner, type StreamingCliRunner } from "./cli";

export type ConnectorState = "connected" | "needs_auth" | "pending" | "failed" | "missing";

export interface ConnectorCheck {
  id: string;
  label: string;
  /** What the app uses it for. */
  purpose: string;
  required: boolean;
  state: ConnectorState;
  /** Claude Code's own word for a state the app doesn't know, e.g. "disabled". */
  rawStatus?: string;
}

export interface SetupReport {
  /** Each check is null until it has run; a check runs only when the ones before it pass. */
  claude: { ok: boolean; version?: string } | null;
  login: { ok: boolean; method?: string; email?: string } | null;
  connectors: ConnectorCheck[] | null;
  /**
   * The probe saw no claude.ai connectors at all: Claude Code isn't using a claude.ai account. (The
   * login method from `auth status` can't tell: a gateway in settings.json shows as a token login,
   * though the app's runs switch the gateway off and use the claude.ai login underneath.)
   */
  noClaudeAi?: boolean;
  /** Set when the probe couldn't run, e.g. Claude Code failed to start. */
  probeError?: string;
  gh: { ok: boolean } | null;
}

/** The connectors the app uses, matched against Claude Code's MCP server names. */
const CONNECTORS: { id: string; label: string; purpose: string; required: boolean; match: (name: string) => boolean }[] = [
  { id: "slack", label: "Slack", purpose: "Projects, tasks, replies and news", required: true, match: (n) => n === "claude.ai Slack" },
  { id: "gmail", label: "Gmail", purpose: "Email tasks and replies", required: true, match: (n) => n === "claude.ai Gmail" },
  { id: "calendar", label: "Google Calendar", purpose: "Today's meetings and prep", required: true, match: (n) => n === "claude.ai Google Calendar" },
  { id: "drive", label: "Google Drive", purpose: "Research when planning a task", required: false, match: (n) => n === "claude.ai Google Drive" },
  { id: "jira", label: "Jira", purpose: "Tickets when planning and checking tasks", required: false, match: (n) => n === "mcp-jira" },
  { id: "uknow", label: "Company knowledge base", purpose: "Company context when planning", required: false, match: (n) => /U-Know/i.test(n) },
];

/** The "init" line of a stream-json transcript: the session's tools and MCP servers. */
export function findInit(stdout: string): { mcp_servers?: { name: string; status: string }[] } | null {
  for (const line of stdout.split("\n")) {
    try {
      const obj = JSON.parse(line);
      if (obj?.type === "system" && obj.subtype === "init") return obj;
    } catch {
      // Not JSON; keep looking.
    }
  }
  return null;
}

/** Each connector the app uses and its state, from the init line's MCP server list. */
export function connectorChecks(servers: { name: string; status: string }[]): ConnectorCheck[] {
  return CONNECTORS.map(({ match, ...c }) => {
    const status = servers.find((s) => match(s.name))?.status;
    const state: ConnectorState =
      status === "connected"
        ? "connected"
        : status === "needs-auth"
          ? "needs_auth"
          : status === "pending"
            ? "pending"
            : status
              ? "failed"
              : "missing";
    return { ...c, state, ...(state === "failed" ? { rawStatus: status } : {}) };
  });
}

/** Ready when Claude Code is signed in and every required connector is connected. */
export function isReady(r: SetupReport): boolean {
  return !!r.claude?.ok && !!r.login?.ok && !!r.connectors?.every((c) => !c.required || c.state === "connected");
}

/** The same settings override as the refresh jobs: a gateway login would hide the connectors. */
const USE_CLAUDE_AI_LOGIN = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "" } });

const PROBE_ARGS = [
  "-p",
  "Reply with OK.",
  "--output-format",
  "stream-json",
  "--verbose",
  "--settings",
  USE_CLAUDE_AI_LOGIN,
  "--model",
  "haiku",
  "--max-turns",
  "1",
  "--tools",
  "",
];

/** Runs every check in order, reporting progress; later checks are skipped when an earlier one fails. */
export async function runSetupChecks(
  onProgress: (r: SetupReport) => void,
  run: CliRunner = runCli,
  stream: StreamingCliRunner = runCliStreaming,
): Promise<SetupReport> {
  const report: SetupReport = { claude: null, login: null, connectors: null, gh: null };
  const step = () => onProgress({ ...report });

  const gh = await run("gh", ["auth", "status"]).catch(() => null);
  report.gh = { ok: gh?.code === 0 };

  const version = await run("claude", ["--version"]).catch(() => null);
  report.claude = { ok: version?.code === 0, version: version?.stdout.trim().split(" ")[0] };
  step();
  if (!report.claude.ok) return report;

  const auth = await run("claude", ["auth", "status"]).catch(() => null);
  try {
    const s = JSON.parse(auth?.stdout ?? "");
    report.login = { ok: !!s.loggedIn, method: s.loggedIn ? s.authMethod : undefined, email: s.email };
  } catch {
    report.login = { ok: false };
  }
  step();
  if (!report.login.ok) return report;

  // A one-turn run on the cheapest model; only its init line matters. A connector can still be
  // connecting when that line is written, so look again (twice at most) while a needed one is pending.
  for (let attempt = 0; attempt < 3; attempt++) {
    const probe = await stream("claude", PROBE_ARGS).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
    const init = findInit(probe.stdout);
    if (!init) {
      report.probeError = (probe.stderr || probe.stdout).trim().slice(-300) || `claude exited ${probe.code}`;
      break;
    }
    const servers = init.mcp_servers ?? [];
    report.connectors = connectorChecks(servers);
    report.noClaudeAi = !servers.some((s) => s.name.startsWith("claude.ai "));
    if (!report.connectors.some((c) => c.required && c.state === "pending")) break;
    step();
  }
  step();
  return report;
}
