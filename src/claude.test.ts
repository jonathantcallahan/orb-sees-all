import { describe, expect, it, vi } from "vitest";
import envelope from "./__fixtures__/project-envelope.json";
import { describeTool, extractJson, findEnvelope, runClaude } from "./claude";
import type { StreamingCliRunner as CliRunner } from "./cli";
import { ProjectSnapshot } from "./schema";

const MIN_SNAPSHOT = JSON.stringify({
  description: "d",
  status: "idle",
  status_reason: "",
  raci: { role: "informed", reason: "" },
  priority: { level: "P4", reason: "" },
  blockers: [],
  my_tasks: [],
  summary: "",
});

const reply = (result: string, extra: object = {}) => ({
  code: 0,
  stdout: JSON.stringify({ is_error: false, result, total_cost_usd: 0.5, duration_ms: 1000, session_id: "s1", ...extra }),
  stderr: "",
});

describe("extractJson", () => {
  it("strips prose and code fences", () => {
    expect(extractJson('Here you go:\n```json\n{"a": {"b": 1}}\n```')).toEqual({ a: { b: 1 } });
  });

  it("throws when there is no object", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("runClaude", () => {
  it("parses a recorded project reply", async () => {
    const run: CliRunner = async () => ({ code: 0, stdout: JSON.stringify(envelope), stderr: "" });
    const { data } = await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    expect(data.status).toBe("at_risk");
    expect(data.raci.role).toBe("accountable");
    expect(data.blockers.flatMap((b) => b.owners).some((o) => o.is_me)).toBe(true);
    // A blocker the user owns is also one of their tasks, under the same id.
    const mine = data.blockers.filter((b) => b.owners.some((o) => o.is_me));
    expect(mine.every((b) => data.my_tasks.some((t) => t.id === b.id))).toBe(true);
  });

  it("passes read-only tools and denies built-in tools", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: ["mcp__x__read"] }, run);
    const args = run.mock.calls[0][1];
    expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--disallowedTools"))).toEqual(["--allowedTools", "mcp__x__read"]);
    expect(args).toContain("Bash");
  });

  it("resumes the session once with the validation error, and sums cost", async () => {
    const run = vi
      .fn<CliRunner>()
      .mockResolvedValueOnce(reply('{"status":"fine"}'))
      .mockResolvedValueOnce(reply(MIN_SNAPSHOT.replace('"idle"', '"on_track"')));
    const result = await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    expect(result.data.status).toBe("on_track");
    expect(result.costUsd).toBe(1);
    const retryArgs = run.mock.calls[1][1];
    expect(retryArgs.slice(0, 2)).toEqual(["--resume", "s1"]);
    expect(retryArgs[3]).toContain("status");
  });

  it("overrides gateway credentials so the claude.ai connectors load", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    const args = run.mock.calls[0][1];
    expect(JSON.parse(args[args.indexOf("--settings") + 1]).env).toEqual({ ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "" });
  });

  it("leaves out --allowedTools when a job needs no tools", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    expect(run.mock.calls[0][1]).not.toContain("--allowedTools");
  });

  it("gives up after the retry fails", async () => {
    const run: CliRunner = async () => reply("{}");
    await expect(runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run)).rejects.toThrow(/schema/);
  });

  it("surfaces CLI errors such as being logged out", async () => {
    const run: CliRunner = async () => reply("Not logged in · Please run /login", { is_error: true });
    await expect(runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run)).rejects.toThrow(/Not logged in/);
  });
});

describe("streaming", () => {
  it("finds the result line in a stream-json transcript", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "x", input: {} }] } }),
      JSON.stringify({ type: "result", is_error: false, result: "{}", total_cost_usd: 0.1 }),
    ].join("\n");
    expect(findEnvelope(stdout)).toMatchObject({ type: "result", total_cost_usd: 0.1 });
    expect(findEnvelope("not json")).toBeNull();
  });

  it("reports each tool call as a status while Claude works", async () => {
    const statuses: string[] = [];
    const run: CliRunner = async (_p, _a, onLine) => {
      const lines = [
        { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__claude_ai_Slack__slack_search_public_and_private", input: { keywords: ["refunds"], filters: "after:2026-10-20" } }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__mcp-jira__jira_get_issue", input: { issue_key: "CPS-6931" } }] } },
        { type: "result", is_error: false, result: MIN_SNAPSHOT },
      ].map((l) => JSON.stringify(l));
      lines.forEach((l) => onLine?.(l));
      return { code: 0, stdout: lines.join("\n"), stderr: "" };
    };
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [], onStatus: (s) => statuses.push(s) }, run);
    expect(statuses).toEqual(['Searching Slack for "refunds after:2026-10-20"', "Reading CPS-6931"]);
  });

  it("describes tools from every connector", () => {
    expect(describeTool("mcp__claude_ai_Gmail__search_threads", { query: "from:sean" })).toBe('Searching email for "from:sean"');
    expect(describeTool("mcp__claude_ai_Google_Calendar__list_events", {})).toBe("Reading your calendar");
    expect(describeTool("mcp__claude_ai_U-Know__ask_uknow", {})).toBe("Asking U-Know");
    expect(describeTool("mcp__something__unknown", {})).toBe("Working");
  });
});

describe("task double check", () => {
  it("parses a check and defaults missing lists", async () => {
    const { TaskCheck } = await import("./schema");
    const c = TaskCheck.parse({ verdict: "already_done", summary: "Ben shipped it on Oct 28." });
    expect(c.findings).toEqual([]);
    expect(c.evidence).toEqual([]);
    expect(() => TaskCheck.parse({ verdict: "maybe", summary: "" })).toThrow();
  });

  it("asks for every check and stays read-only", async () => {
    const { checkTaskPrompt } = await import("./prompts");
    const p = checkTaskPrompt({
      task: { title: "Send Q4 numbers", description: null, source: "Slack", link: "https://x/1", requester: "Ben", due: null, priority: null },
      otherTasks: ["Send Q4 figures to Ben"],
      userId: "U1",
    });
    for (const check of ["Captured correctly", "Still necessary", "Duplicate", "Priority", "Missing context"]) expect(p).toContain(check);
    expect(p).toContain("Send Q4 figures to Ben");
    expect(p).toMatch(/Never send, post/);
  });
});
