import { describe, expect, it } from "vitest";
import { connectorChecks, findInit, isReady, runSetupChecks } from "./setup";

describe("setup checks", () => {
  it("reads connector states from the init line", () => {
    const stdout = [
      '{"type":"system","subtype":"hook_started"}',
      JSON.stringify({
        type: "system",
        subtype: "init",
        mcp_servers: [
          { name: "claude.ai Slack", status: "connected" },
          { name: "claude.ai Gmail", status: "needs-auth" },
          { name: "mcp-jira", status: "failed" },
          { name: "claude.ai U-Know", status: "connected" },
        ],
      }),
    ].join("\n");
    const checks = connectorChecks(findInit(stdout)!.mcp_servers!);
    const state = Object.fromEntries(checks.map((c) => [c.id, c.state]));
    expect(state).toEqual({ slack: "connected", gmail: "needs_auth", calendar: "missing", drive: "missing", jira: "failed", uknow: "connected" });
    expect(checks.find((c) => c.id === "jira")?.rawStatus).toBe("failed");
  });

  it("is ready only with a claude.ai login and every required connector", () => {
    const connected = connectorChecks(["Slack", "Gmail", "Google Calendar"].map((n) => ({ name: `claude.ai ${n}`, status: "connected" })));
    const base = { claude: { ok: true }, login: { ok: true }, gh: { ok: false } };
    expect(isReady({ ...base, connectors: connected })).toBe(true);
    expect(isReady({ ...base, connectors: connected.map((c) => (c.id === "gmail" ? { ...c, state: "needs_auth" as const } : c)) })).toBe(false);
    expect(isReady({ ...base, login: { ok: false }, connectors: connected })).toBe(false);
    expect(isReady({ ...base, connectors: null })).toBe(false);
  });

  it("stops when Claude Code isn't signed in, without running the probe", async () => {
    let probed = false;
    const report = await runSetupChecks(
      () => {},
      async (program, args) => {
        if (program === "gh") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "2.1.311 (Claude Code)\n", stderr: "" };
        return { code: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
      },
      async () => {
        probed = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    expect(report.claude).toEqual({ ok: true, version: "2.1.311" });
    expect(report.login).toEqual({ ok: false, method: undefined, email: undefined });
    expect(report.connectors).toBeNull();
    expect(probed).toBe(false);
  });

  it("accepts a gateway token login when the claude.ai connectors still show up", async () => {
    const init = JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "claude.ai Slack", status: "connected" }] });
    const report = await runSetupChecks(
      () => {},
      async (program, args) => {
        if (program === "gh") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "--version") return { code: 0, stdout: "2.1.311 (Claude Code)\n", stderr: "" };
        return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth_token" }), stderr: "" };
      },
      async () => ({ code: 0, stdout: init, stderr: "" }),
    );
    expect(report.login?.ok).toBe(true);
    expect(report.noClaudeAi).toBe(false);
    expect(report.connectors?.find((c) => c.id === "slack")?.state).toBe("connected");
  });

  it("flags a login with no claude.ai connectors at all", async () => {
    const init = JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "mcp-jira", status: "connected" }] });
    const report = await runSetupChecks(
      () => {},
      async (_program, args) =>
        args[0] === "--version"
          ? { code: 0, stdout: "2.1.311\n", stderr: "" }
          : { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key" }), stderr: "" },
      async () => ({ code: 0, stdout: init, stderr: "" }),
    );
    expect(report.noClaudeAi).toBe(true);
  });

  it("looks again while a needed connector is still connecting", async () => {
    const init = (status: string) =>
      JSON.stringify({
        type: "system",
        subtype: "init",
        mcp_servers: ["Slack", "Gmail", "Google Calendar"].map((n) => ({ name: `claude.ai ${n}`, status: n === "Slack" ? status : "connected" })),
      });
    const replies = [init("pending"), init("connected")];
    let probes = 0;
    const report = await runSetupChecks(
      () => {},
      async (_program, args) =>
        args[0] === "--version" ? { code: 0, stdout: "2.1.311\n", stderr: "" } : { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" },
      async () => ({ code: 0, stdout: replies[probes++], stderr: "" }),
    );
    expect(probes).toBe(2);
    expect(isReady(report)).toBe(true);
  });
});
