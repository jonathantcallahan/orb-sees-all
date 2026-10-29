import { describe, expect, it, vi } from "vitest";
import envelope from "./__fixtures__/project-envelope.json";
import { extractJson, runClaude } from "./claude";
import type { CliRunner } from "./cli";
import { ProjectSnapshot } from "./schema";

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
    expect(data.waiting_on.length).toBeGreaterThan(0);
    expect(data.my_tasks.every((t) => t.id.startsWith("https://"))).toBe(true);
  });

  it("passes read-only tools and denies built-in tools", async () => {
    const run = vi.fn<CliRunner>(async () => reply('{"status":"idle","status_reason":"","waiting_on":[],"my_tasks":[],"summary":""}'));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: ["mcp__x__read"] }, run);
    const args = run.mock.calls[0][1];
    expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--disallowedTools"))).toEqual(["--allowedTools", "mcp__x__read"]);
    expect(args).toContain("Bash");
  });

  it("resumes the session once with the validation error, and sums cost", async () => {
    const run = vi
      .fn<CliRunner>()
      .mockResolvedValueOnce(reply('{"status":"fine"}'))
      .mockResolvedValueOnce(reply('{"status":"on_track","status_reason":"ok","waiting_on":[],"my_tasks":[],"summary":"s"}'));
    const result = await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    expect(result.data.status).toBe("on_track");
    expect(result.costUsd).toBe(1);
    const retryArgs = run.mock.calls[1][1];
    expect(retryArgs.slice(0, 2)).toEqual(["--resume", "s1"]);
    expect(retryArgs[3]).toContain("status");
  });

  it("overrides gateway credentials so the claude.ai connectors load", async () => {
    const run = vi.fn<CliRunner>(async () => reply('{"status":"idle","status_reason":"","waiting_on":[],"my_tasks":[],"summary":""}'));
    await runClaude({ prompt: "p", schema: ProjectSnapshot, tools: [] }, run);
    const args = run.mock.calls[0][1];
    expect(JSON.parse(args[args.indexOf("--settings") + 1]).env).toEqual({ ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "" });
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
