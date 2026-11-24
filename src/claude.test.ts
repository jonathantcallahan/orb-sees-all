import { describe, expect, it, vi } from "vitest";
import envelope from "./__fixtures__/project-envelope.json";
import { describeTool, extractJson, findEnvelope, runClaude, runSessionTurn } from "./claude";
import type { StreamingCliRunner as CliRunner } from "./cli";
import { ProjectSnapshot, SelfDmPoll } from "./schema";

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

  it("gives a draft run the draft tool alone, never the one that sends", async () => {
    const { TOOLS, deniedTools } = await import("./claude");
    expect(TOOLS.slackDraft).toEqual(["mcp__claude_ai_Slack__slack_send_message_draft"]);
    const denied = deniedTools(TOOLS.slackDraft);
    expect(denied).toContain("mcp__claude_ai_Slack__slack_send_message");
    expect(denied).not.toContain("mcp__claude_ai_Slack__slack_send_message_draft");
  });

  it("takes a reply with no JSON as noJson says, without asking again", async () => {
    const run = vi.fn<CliRunner>(async () => reply("I couldn't read the DM. The Slack read was denied."));
    const result = await runClaude({ prompt: "p", schema: SelfDmPoll, tools: [], noJson: (r) => ({ unreachable: r, latest_ts: null, messages: [] }) }, run);
    expect(result.data).toEqual({ unreachable: "I couldn't read the DM. The Slack read was denied.", latest_ts: null, messages: [] });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("takes a reply whose only braces are in its prose as having no JSON", async () => {
    const run = vi.fn<CliRunner>(async () => reply("I couldn't read {D0123}: the Slack read was denied."));
    const result = await runClaude({ prompt: "p", schema: SelfDmPoll, tools: [], noJson: (r) => ({ unreachable: r, latest_ts: null, messages: [] }) }, run);
    expect(result.data.unreachable).toBe("I couldn't read {D0123}: the Slack read was denied.");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("still asks again about JSON that doesn't fit, with noJson set", async () => {
    const run = vi
      .fn<CliRunner>()
      .mockResolvedValueOnce(reply('{"messages": "none"}'))
      .mockResolvedValueOnce(reply('{"unreachable": null, "latest_ts": "1.2", "messages": []}'));
    const result = await runClaude({ prompt: "p", schema: SelfDmPoll, tools: [], noJson: () => ({ unreachable: "x", latest_ts: null, messages: [] }) }, run);
    expect(result.data.latest_ts).toBe("1.2");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("says why a run stopped when its result doesn't", async () => {
    const run = vi.fn<CliRunner>(async () => ({ code: 0, stdout: JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns" }), stderr: "" }));
    await expect(runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run)).rejects.toThrow("claude: ran out of turns before finishing");
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

  it("asks once more about a reply that parses but needs a fix, and keeps the answer", async () => {
    const run = vi
      .fn<CliRunner>()
      .mockResolvedValueOnce(reply(MIN_SNAPSHOT))
      .mockResolvedValueOnce(reply(MIN_SNAPSHOT.replace('"idle"', '"on_track"')));
    const recheck = vi.fn((d: ProjectSnapshot) => (d.status === "idle" ? "R4 isn't on any issue." : null));
    const result = await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [], recheck }, run);
    expect(result.data.status).toBe("on_track");
    expect(result.costUsd).toBe(1);
    // Asked about once, in the same session; the second reply is kept without asking again.
    expect(recheck).toHaveBeenCalledTimes(1);
    const [, args, , input] = run.mock.calls[1];
    expect(args.slice(0, 2)).toEqual(["--resume", "s1"]);
    expect(input?.stdin).toContain("Your reply needs one more fix:\nR4 isn't on any issue.");
  });

  it("keeps the first reply when the one after a recheck doesn't parse", async () => {
    const run = vi.fn<CliRunner>().mockResolvedValueOnce(reply(MIN_SNAPSHOT)).mockResolvedValueOnce(reply("{}"));
    const result = await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [], recheck: () => "Place R4." }, run);
    expect(result.data.status).toBe("idle");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("asks nothing more when the recheck finds nothing", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [], recheck: () => null }, run);
    expect(run).toHaveBeenCalledTimes(1);
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
        { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__claude_ai_Atlassian_Rovo__getJiraIssue", input: { cloudId: "example.atlassian.net", issueIdOrKey: "PAY-6931" } }] } },
        { type: "result", is_error: false, result: MIN_SNAPSHOT },
      ].map((l) => JSON.stringify(l));
      lines.forEach((l) => onLine?.(l));
      return { code: 0, stdout: lines.join("\n"), stderr: "" };
    };
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [], onStatus: (s) => statuses.push(s) }, run);
    expect(statuses).toEqual(['Searching Slack for "refunds after:2026-10-20"', "Reading PAY-6931"]);
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
    // The message goes in as one stream-json line, and stdin stays open for the answers to asks.
    expect(input?.stdin?.endsWith("\n")).toBe(true);
    expect(JSON.parse(input!.stdin!)).toEqual({ type: "user", message: { role: "user", content: "Post it in #plugins" } });
    expect(input?.keepStdinOpen).toBe(true);
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

  it("pins its own permission mode, whatever the user's default is: never ask in the background, auto in a chat", async () => {
    const run = vi.fn<CliRunner>(async () => reply(MIN_SNAPSHOT));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    await runSessionTurn({ prompt: "p", tools: [] }, run);
    const modes = run.mock.calls.map(([, args]) => args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2));
    expect(modes).toEqual([
      ["--permission-mode", "dontAsk"],
      ["--permission-mode", "auto"],
    ]);
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
    expect(run.mock.calls[1][4]).toMatchObject({ limits: SESSION_LIMITS, signal: stop.signal });
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

  it("lets chats search the web and fetch pages, and background runs do neither", async () => {
    const { oneShotArgs, TOOLS } = await import("./claude");
    const { sessionTools } = await import("./jobs");
    const run = vi.fn<CliRunner>(async () => reply("ok"));
    await runSessionTurn({ prompt: "p", tools: sessionTools(false) }, run);
    const chat = run.mock.calls[0][1];
    expect(listAfter(chat, "--allowedTools")).toContain("WebSearch");
    expect(listAfter(chat, "--disallowedTools")).not.toContain("WebSearch");
    expect(listAfter(chat, "--disallowedTools")).not.toContain("WebFetch");
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

describe("chats: auto mode, and asks answered in the chat", () => {
  /** The values after a flag, up to the next flag. */
  const listAfter = (args: string[], flag: string) => {
    const rest = args.slice(args.indexOf(flag) + 1);
    const next = rest.findIndex((a) => a.startsWith("--"));
    return next < 0 ? rest : rest.slice(0, next);
  };
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  /** A chat run that prints `lines`, recording what Demian writes back on its stdin. */
  function fakeChat(lines: object[]) {
    const writes: string[] = [];
    const waiting: boolean[] = [];
    let closed = false;
    const run: CliRunner = async (_program, _args, onLine, _input, control) => {
      control?.onInput?.({
        write: async (text) => void writes.push(text),
        close: async () => void (closed = true),
        waiting: async (on) => void waiting.push(on),
      });
      for (const line of lines) onLine?.(JSON.stringify(line));
      await new Promise((r) => setTimeout(r, 0));
      return reply("done");
    };
    return { run, writes, waiting, closed: () => closed, sent: () => writes.map((w) => JSON.parse(w)) };
  }

  const BASH_ASK = {
    type: "control_request",
    request_id: "r1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      display_name: "Bash",
      input: { command: "ls /Applications | head -3", description: "List apps" },
      description: "List apps",
      permission_suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls /Applications | head -3" }], behavior: "allow", destination: "localSettings" },
        { type: "addRules", rules: [{ toolName: "Read", ruleContent: "//Applications/**" }], behavior: "allow", destination: "session" },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    },
  };

  it("runs in auto mode with asks coming to Demian, or asks about everything when told to", async () => {
    const run = vi.fn<CliRunner>(async () => reply("ok"));
    await runSessionTurn({ prompt: "p", tools: [] }, run);
    await runSessionTurn({ prompt: "p", tools: [], permissionMode: "default" }, run);
    const [auto, ask] = run.mock.calls.map((c) => c[1]);
    expect(after(auto, "--permission-mode")).toBe("auto");
    expect(after(ask, "--permission-mode")).toBe("default");
    expect(after(auto, "--input-format")).toBe("stream-json");
    expect(after(auto, "--permission-prompt-tool")).toBe("stdio");
  });

  it("lets a chat use Claude Code's own tools and read anywhere, but still never send or reach U-Know", async () => {
    const { TOOLS, WRITE_TOOLS } = await import("./claude");
    const run = vi.fn<CliRunner>(async () => reply("ok"));
    await runSessionTurn({ prompt: "p", tools: TOOLS.slackRead }, run);
    const args = run.mock.calls[0][1];
    const denied = listAfter(args, "--disallowedTools");
    for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "Agent"]) expect(denied).not.toContain(tool);
    expect(denied).toEqual(expect.arrayContaining([...WRITE_TOOLS, "mcp__claude_ai_U-Know__ask_uknow", "mcp__claude_ai_Atlassian_Rovo__search"]));
    expect(JSON.parse(after(args, "--settings")).permissions?.blockReadsOutsideWorkingDirectories).toBeUndefined();
  });

  it("allows again what the user chose Always for earlier in the chat", async () => {
    const run = vi.fn<CliRunner>(async () => reply("ok"));
    await runSessionTurn({ prompt: "p", tools: ["mcp__x__read"], allowRules: ["Bash(git status:*)"] }, run);
    expect(listAfter(run.mock.calls[0][1], "--allowedTools")).toEqual(["mcp__x__read", "Bash(git status:*)"]);
  });

  it("leaves background runs as they were: never asking, no shell or edits, reads kept to their folders", async () => {
    const { oneShotArgs } = await import("./claude");
    const job = oneShotArgs({ tools: [] });
    expect(after(job, "--permission-mode")).toBe("dontAsk");
    expect(job).not.toContain("--permission-prompt-tool");
    expect(listAfter(job, "--disallowedTools")).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "WebFetch", "Agent"]));
    expect(JSON.parse(after(job, "--settings")).permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  });

  it("asks the user, waits without timing out, and allows the call once", async () => {
    const chat = fakeChat([BASH_ASK]);
    const onAsk = vi.fn(async () => "allow" as const);
    await runSessionTurn({ prompt: "p", tools: [], onAsk }, chat.run);
    await new Promise((r) => setTimeout(r, 0));
    expect(onAsk).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", tool: "Bash", input: BASH_ASK.request.input, description: "List apps", rules: ["Bash(ls /Applications | head -3)", "Read(//Applications/**)"] }),
    );
    expect(chat.waiting).toEqual([true, false]);
    expect(chat.sent()).toEqual([
      { type: "control_response", response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: BASH_ASK.request.input } } },
    ]);
  });

  it("answers Always with the suggested allow rules, kept to this run, and Deny with a refusal", async () => {
    const always = fakeChat([BASH_ASK]);
    await runSessionTurn({ prompt: "p", tools: [], onAsk: async () => "always" }, always.run);
    await new Promise((r) => setTimeout(r, 0));
    const [allowed] = always.sent();
    expect(allowed.response.response.behavior).toBe("allow");
    expect(allowed.response.response.updatedPermissions).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls /Applications | head -3" }], behavior: "allow", destination: "session" },
      { type: "addRules", rules: [{ toolName: "Read", ruleContent: "//Applications/**" }], behavior: "allow", destination: "session" },
    ]);
    const denied = fakeChat([BASH_ASK]);
    await runSessionTurn({ prompt: "p", tools: [], onAsk: async () => "deny" }, denied.run);
    await new Promise((r) => setTimeout(r, 0));
    expect(denied.sent()[0].response.response).toEqual({ behavior: "deny", message: "Declined in the chat." });
    // With no one to ask, it's refused.
    const nobody = fakeChat([BASH_ASK]);
    await runSessionTurn({ prompt: "p", tools: [] }, nobody.run);
    await new Promise((r) => setTimeout(r, 0));
    expect(nobody.sent()[0].response.response.behavior).toBe("deny");
  });

  it("refuses requests it doesn't handle, passes on a withdrawn ask, the mode in force, and ends with the result", async () => {
    const chat = fakeChat([
      { type: "system", subtype: "init", permissionMode: "auto" },
      { type: "system", subtype: "status", status: null, permissionMode: "default" },
      { type: "control_request", request_id: "h1", request: { subtype: "hook_callback" } },
      { type: "control_cancel_request", request_id: "r9" },
      { type: "result", subtype: "success", is_error: false, result: "done" },
    ]);
    const onMode = vi.fn();
    const onAskGone = vi.fn();
    await runSessionTurn({ prompt: "p", tools: [], onMode, onAskGone }, chat.run);
    await new Promise((r) => setTimeout(r, 0));
    expect(onMode.mock.calls).toEqual([["auto"], ["default"]]);
    expect(onAskGone).toHaveBeenCalledWith("r9");
    expect(chat.sent()).toEqual([{ type: "control_response", response: { subtype: "error", request_id: "h1", error: "Not supported here" } }]);
    expect(chat.closed()).toBe(true);
  });
});


describe("Jira and Confluence through Atlassian's Rovo connector", () => {
  it("reads Jira and Confluence with Rovo's tools, and no longer through mcp-jira", async () => {
    const { TOOLS } = await import("./claude");
    const rovo = (t: string) => `mcp__claude_ai_Atlassian_Rovo__${t}`;
    expect(TOOLS.jiraRead).toEqual(expect.arrayContaining([rovo("searchJiraIssuesUsingJql"), rovo("getJiraIssue"), rovo("getAccessibleAtlassianResources")]));
    expect(TOOLS.driveRead).toEqual(expect.arrayContaining([rovo("getConfluencePage"), rovo("searchConfluenceUsingCql")]));
    expect(TOOLS.ticketCreate).toEqual(expect.arrayContaining([rovo("createJiraIssue"), rovo("createIssueLink")]));
    const all = Object.values(TOOLS).flat();
    expect(all.filter((t) => t.startsWith("mcp__mcp-jira__"))).toEqual([]);
  });

  it("keeps Rovo's writes for the hand-offs you approve, and its credit-spending search off everywhere", async () => {
    const { TOOLS, WRITE_TOOLS, deniedTools, chatDeniedTools } = await import("./claude");
    const writes = ["createJiraIssue", "editJiraIssue", "transitionJiraIssue", "addCommentToJiraIssue", "createIssueLink", "createConfluencePage", "updateConfluencePage"].map(
      (t) => `mcp__claude_ai_Atlassian_Rovo__${t}`,
    );
    expect(WRITE_TOOLS).toEqual(expect.arrayContaining(writes));
    for (const denied of [deniedTools(TOOLS.jiraRead), chatDeniedTools([...TOOLS.jiraRead, ...TOOLS.driveRead])]) {
      expect(denied).toEqual(expect.arrayContaining([...writes, "mcp__claude_ai_Atlassian_Rovo__search"]));
      for (const read of [...TOOLS.jiraRead, ...TOOLS.confluenceRead]) expect(denied).not.toContain(read);
    }
    // Filing a ticket you approved gets its create and link tools, and nothing that changes other issues.
    const filing = deniedTools(TOOLS.ticketCreate);
    expect(filing).not.toContain("mcp__claude_ai_Atlassian_Rovo__createJiraIssue");
    expect(filing).toContain("mcp__claude_ai_Atlassian_Rovo__transitionJiraIssue");
    expect(filing).toContain("mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue");
  });

  it("names Rovo's calls in the status line", () => {
    expect(describeTool("mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql", { cloudId: "x", jql: "parent = PAY-1" })).toBe('Searching Jira for "parent = PAY-1"');
    expect(describeTool("mcp__claude_ai_Atlassian_Rovo__getConfluencePage", { cloudId: "x", pageId: "1" })).toBe("Reading a Confluence page");
    expect(describeTool("mcp__claude_ai_Atlassian_Rovo__getAccessibleAtlassianResources", {})).toBe("Finding your Atlassian site");
  });

  it("tells every Jira prompt how to reach the cloud site and follow older links", async () => {
    const { ATLASSIAN_RULE } = await import("./baseLessons");
    const prompts = await import("./prompts");
    const texts = [
      prompts.epicCheckPrompt("PAY-1"),
      prompts.epicChildrenPrompt("PAY-1"),
      prompts.createTicketPrompt("Add export", "project: ABC\ntype: Task\n\nBody"),
      prompts.requirementsPrompt({ doc: { title: "Refunds PRD", link: "https://wiki.example.com/spaces/ABC/pages/123/Refunds+PRD" } }),
      prompts.projectPrompt({ channels: [{ channel_id: "C1", name: "x" }], userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-16T10:00:00Z") }),
    ];
    for (const text of texts) {
      expect(text).toContain(ATLASSIAN_RULE);
      expect(text).not.toMatch(/\bjira_(search|get_issue|create_issue|link_to_epic)/);
    }
    expect(ATLASSIAN_RULE).toMatch(/never by the old link's page id/);
    expect(texts[3]).toContain("getConfluencePage");
    expect(texts[3]).not.toContain("Confluence pages can't be read here");
  });
});
