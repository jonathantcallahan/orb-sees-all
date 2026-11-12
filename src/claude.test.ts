import { describe, expect, it, vi } from "vitest";
import envelope from "./__fixtures__/project-envelope.json";
import { describeTool, extractJson, findEnvelope, runClaude, runSessionTurn } from "./claude";
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
    const [, retryArgs, , retryInput] = run.mock.calls[1];
    expect(retryArgs.slice(0, 2)).toEqual(["--resume", "s1"]);
    expect(retryInput?.stdin).toContain("status");
  });

  it("sends the prompt on stdin, never on the command line", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    const long = `line one\n${"x".repeat(40_000)}\n100% done & dusted ^`;
    await runClaude({ prompt: long, schema: ProjectSnapshot, tools: [] }, run);
    const [, args, , input] = run.mock.calls[0];
    expect(input?.stdin).toBe(long);
    // The whole command line stays well under Windows' ~32k limit.
    expect(args.join(" ").length).toBeLessThan(16_000);
    expect(args).not.toContain("--append-system-prompt");
  });

  it("overrides gateway credentials so the claude.ai connectors load", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    const args = run.mock.calls[0][1];
    expect(JSON.parse(args[args.indexOf("--settings") + 1]).env).toEqual({ ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "" });
  });

  it("tells sessions how to ask for code they weren't given, instead of searching for it", async () => {
    const { SESSION_DISPLAY } = await import("./claude");
    expect(SESSION_DISPLAY).toMatch(/\[orb\] code </);
    expect(SESSION_DISPLAY).toMatch(/no \/add-dir here/);
  });

  it("keeps file tools to the run's own folders, so nothing searches the home folder", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [], dirs: ["/code/repo"] }, run);
    const args = run.mock.calls[0][1];
    expect(JSON.parse(args[args.indexOf("--settings") + 1]).permissions).toEqual({ blockReadsOutsideWorkingDirectories: true });
    expect(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2)).toEqual(["--add-dir", "/code/repo"]);
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
      otherTasks: [{ id: "t2", title: "Send Q4 figures to Ben" }],
      userId: "U1",
    });
    for (const check of ["Captured correctly", "Still necessary", "Duplicate", "Priority", "Missing context"]) expect(p).toContain(check);
    expect(p).toContain("Send Q4 figures to Ben");
    expect(p).toMatch(/Never send, post/);
  });
});

describe("runSessionTurn", () => {
  it("resumes the session for a later turn and returns its id and cost", async () => {
    const run = vi.fn<CliRunner>().mockResolvedValue(reply("[orb] step 2 waiting: which channel?", { session_id: "abc" }));
    const turn = await runSessionTurn({ prompt: "Post it in #plugins", tools: ["mcp__x__read"], resume: "abc" }, run);
    const [, args, , input] = run.mock.calls[0];
    expect(args.slice(0, 3)).toEqual(["--resume", "abc", "-p"]);
    expect(input?.stdin).toBe("Post it in #plugins");
    // The display rules and context go in the system-prompt file, not the arguments.
    expect(input?.appendSystemPrompt).toContain("Orb");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).toContain("--disallowedTools");
    expect(args).not.toContain("--effort");
    expect(turn).toEqual({ sessionId: "abc", costUsd: 0.5, error: null });
  });

  it("reports a turn that stopped on an error", async () => {
    const run = vi.fn<CliRunner>().mockResolvedValue(reply("Reached max turns", { is_error: true }));
    expect((await runSessionTurn({ prompt: "p", tools: [] }, run)).error).toBe("Reached max turns");
  });
});

describe("runSessionTurn effort", () => {
  it("passes the model and effort through", async () => {
    const run = vi.fn<CliRunner>().mockResolvedValue(reply("done"));
    await runSessionTurn({ prompt: "p", tools: [], model: "claude-opus-5-5", effort: "medium" }, run);
    const args = run.mock.calls[0][1];
    expect(args.join(" ")).toContain("--model claude-opus-5-5 --effort medium");
  });
});

describe("code access", () => {
  it("adds the code folders and only Claude Code's read-only file tools", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: ["mcp__x__read"], dirs: ["/code/a", "/code/b"] }, run);
    const args = run.mock.calls[0][1];
    expect(args.slice(0, 3)).toEqual(["--add-dir", "/code/a", "/code/b"]);
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(allowed).toEqual(["mcp__x__read", "Read", "Grep", "Glob"]);
    // Writing and shell tools stay off.
    expect(args.slice(args.indexOf("--disallowedTools"))).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
  });

  it("gives no file tools when there's no code", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    expect(run.mock.calls[0][1]).not.toContain("--add-dir");
    expect(run.mock.calls[0][1]).not.toContain("Read");
  });
});

describe("locked-down runs", () => {
  const SEND = "mcp__claude_ai_Slack__slack_send_message";
  const denied = (args: string[]) => args.slice(args.indexOf("--disallowedTools") + 1);

  it("never ask: every run pins its own permission mode, whatever the user's default is", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    await runSessionTurn({ prompt: "p", tools: [] }, run);
    for (const [, args] of run.mock.calls) expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
  });

  it("denies a background run every write tool, so no allow rule of the user's can let it post", async () => {
    const { TOOLS, WRITE_TOOLS } = await import("./claude");
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.granolaRead] }, run);
    const args = run.mock.calls[0][1];
    expect(denied(args)).toEqual(expect.arrayContaining([SEND, ...WRITE_TOOLS]));
    expect(denied(args)).toEqual(expect.arrayContaining(["mcp__claude_ai_Amplitude__run_amp", "mcp__Amplitude__run_amp", "mcp__claude_ai_Granola__update_private_notes", "mcp__mcp-jira__jira_add_worklog"]));
  });

  it("denies a send run every write tool but the one it sends with", async () => {
    const { TOOLS, WRITE_TOOLS } = await import("./claude");
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: TOOLS.slackSend }, run);
    const args = run.mock.calls[0][1];
    expect(denied(args)).not.toContain(SEND);
    expect(denied(args)).toEqual(expect.arrayContaining(WRITE_TOOLS.filter((t) => t !== SEND)));
  });

  it("denies a chat every write tool: it hands messages to Orb to send", async () => {
    const { WRITE_TOOLS } = await import("./claude");
    const run = vi.fn<CliRunner>(async () => reply("ok"));
    await runSessionTurn({ prompt: "p", tools: ["mcp__x__read"] }, run);
    expect(denied(run.mock.calls[0][1])).toEqual(expect.arrayContaining(WRITE_TOOLS));
  });

  it("keeps the longest command line, a chat turn with every tool and a dozen code folders, under half of Windows' ~32k limit", async () => {
    const { sessionTools } = await import("./jobs");
    const run = vi.fn<CliRunner>(async () => reply("ok"));
    const dirs = Array.from({ length: 12 }, (_, i) => `/Users/someone.with.a.long.name/Library/Application Support/com.demian.app/work/repos/owner-${i}/repository-name-${i}`);
    await runSessionTurn({ prompt: "p", tools: sessionTools(true), dirs, resume: "abcdefabcdefabcdefabcdef" }, run);
    expect(run.mock.calls[0][1].join(" ").length).toBeLessThan(16_000);
  });

  it("lists only real writes as write tools: none of a run's reading tools is denied", async () => {
    const { TOOLS, WRITE_TOOLS } = await import("./claude");
    const reads = [...TOOLS.slackRead, ...TOOLS.gmailRead, ...TOOLS.calendarRead, ...TOOLS.driveRead, ...TOOLS.jiraRead, ...TOOLS.zoomRead, ...TOOLS.amplitudeRead, ...TOOLS.granolaRead];
    expect(reads.filter((t) => WRITE_TOOLS.includes(t))).toEqual([]);
  });
});

describe("time limits", () => {
  it("gives a one-shot run its limits, and a chat turn its own and its Stop", async () => {
    const { ONE_SHOT_LIMITS, SESSION_LIMITS } = await import("./claude");
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    expect(run.mock.calls[0][4]).toEqual({ limits: ONE_SHOT_LIMITS });
    const stop = new AbortController();
    await runSessionTurn({ prompt: "p", tools: [], signal: stop.signal }, run);
    expect(run.mock.calls[1][4]).toEqual({ limits: SESSION_LIMITS, signal: stop.signal });
    // Stuck is ten minutes with no output; a long refresh still has room.
    expect(ONE_SHOT_LIMITS.idleSecs).toBe(600);
    expect(ONE_SHOT_LIMITS.totalSecs).toBeGreaterThanOrEqual(30 * 60);
  });
});

describe("web search", () => {
  /** The values after a flag, up to the next flag. */
  const listAfter = (args: string[], flag: string) => {
    const rest = args.slice(args.indexOf(flag) + 1);
    const next = rest.findIndex((a) => a.startsWith("--"));
    return next < 0 ? rest : rest.slice(0, next);
  };

  it("lets chats search the web but not fetch pages, and background runs do neither", async () => {
    const { oneShotArgs, TOOLS } = await import("./claude");
    const { sessionTools } = await import("./jobs");
    const run = vi.fn<CliRunner>(async () => reply("ok"));
    await runSessionTurn({ prompt: "p", tools: sessionTools(false) }, run);
    const chat = run.mock.calls[0][1];
    expect(listAfter(chat, "--allowedTools")).toContain("WebSearch");
    expect(listAfter(chat, "--disallowedTools")).not.toContain("WebSearch");
    expect(listAfter(chat, "--disallowedTools")).toContain("WebFetch");
    const job = oneShotArgs({ tools: TOOLS.slackRead });
    expect(listAfter(job, "--allowedTools")).not.toContain("WebSearch");
    expect(listAfter(job, "--disallowedTools")).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
  });
});

describe("Amplitude experiments and flags in chats", () => {
  it("gives chats the experiment and flag tools, and says to change one only when asked", async () => {
    const { SESSION_DISPLAY, TOOLS } = await import("./claude");
    // Under the connector's name and that of an Amplitude server added to Claude Code itself.
    expect(TOOLS.amplitudeExperiments).toEqual([
      "mcp__claude_ai_Amplitude__use_amp_experiments",
      "mcp__claude_ai_Amplitude__use_amp_flags",
      "mcp__Amplitude__use_amp_experiments",
      "mcp__Amplitude__use_amp_flags",
    ]);
    expect(TOOLS.amplitudeRead).toEqual(expect.arrayContaining(["mcp__claude_ai_Amplitude__query_amplitude_data", "mcp__Amplitude__query_amplitude_data", "mcp__Amplitude__get_amplitude_context"]));
    // Background jobs keep the read-only list.
    expect(TOOLS.amplitudeRead).not.toContain("mcp__claude_ai_Amplitude__use_amp_flags");
    expect(SESSION_DISPLAY).toContain("only do that when I've asked for that exact change in this chat");
  });

  it("gives them only on a turn you started, never one Demian starts by itself", async () => {
    const { TOOLS } = await import("./claude");
    const { sessionTools } = await import("./jobs");
    expect(sessionTools(true)).toEqual(expect.arrayContaining(TOOLS.amplitudeExperiments));
    for (const t of TOOLS.amplitudeExperiments) expect(sessionTools(false)).not.toContain(t);
  });
});
