import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./db", () => ({}));
vi.mock("./jobs", () => ({}));
vi.mock("./claude", () => ({}));

const { areaOn, areasOn, CONNECTORS_RECHECK_MS, projectConnectors, projectConnectorsReady, projectConnectorsRecent, projectsGate, saveProjectConnectors, setAreaOn } = await import("./features");
const { globalActionDocs, globalTaskRules, GLOBAL_TASK_RULES, PROJECT_ACTIONS, TASK_ACTIONS } = await import("./openInClaude");
const { adhocPrompt, selfDmActionsPrompt } = await import("./prompts");
const { applyAction } = await import("./globalActions");
const { checkProjectConnectors, projectConnectorsOf } = await import("./setup");

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

const adhoc = (o: { projects?: boolean; updates?: boolean } = {}) =>
  adhocPrompt({ userId: "U1", previous: [], previousReplies: [], projectChannels: ["tmp-refunds"], lastRefreshedAt: null, now: new Date(2026, 10, 4), ...o });

describe("the areas, each of which can be turned off", () => {
  it("has Updates, Tasks and Projects on and Watched topics off until chosen", () => {
    expect(areasOn()).toEqual(["updates", "tasks", "projects"]);
    setAreaOn("watched", true);
    setAreaOn("updates", false);
    expect(areasOn()).toEqual(["tasks", "projects", "watched"]);
    setAreaOn("updates", true);
    expect(areaOn("updates")).toBe(true);
  });

  it("keeps the last area on", () => {
    setAreaOn("updates", false);
    setAreaOn("projects", false);
    setAreaOn("tasks", false);
    expect(areasOn()).toEqual(["tasks"]);
    // Storage that somehow has them all off still shows one.
    localStorage.setItem("feature:tasks-off", "1");
    expect(areasOn()).toEqual(["tasks"]);
  });
});

describe("Projects needs Jira and GitHub", () => {
  it("can't be turned on until both are set up, as the last check found them", () => {
    expect(projectConnectors()).toBeNull();
    expect(projectConnectorsReady()).toBe(false);
    saveProjectConnectors({ jira: true, github: false });
    expect(projectConnectorsReady()).toBe(false);
    saveProjectConnectors({ jira: true, github: true });
    expect(projectConnectorsReady()).toBe(true);
  });

  it("reads them from a setup check, or checks just them", async () => {
    expect(projectConnectorsOf({ claude: null, login: null, connectors: null, gh: null })).toBeNull();
    const init = (status: string) => JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "claude.ai Atlassian Rovo", status }] });
    const run = (code: number) => async () => ({ code, stdout: "", stderr: "" });
    const stream = (status: string) => async () => ({ code: 0, stdout: init(status), stderr: "" });
    expect(await checkProjectConnectors(run(0), stream("connected"))).toEqual({ jira: true, github: true });
    expect(await checkProjectConnectors(run(1), stream("needs-auth"))).toEqual({ jira: false, github: false });
    // A connector still connecting is looked at again.
    const states = ["pending", "connected"];
    expect(await checkProjectConnectors(run(0), async () => ({ code: 0, stdout: init(states.shift()!), stderr: "" }))).toEqual({ jira: true, github: true });
    // Not known: still connecting after a second look, or the probe didn't run. Neither is "missing".
    expect(await checkProjectConnectors(run(0), stream("pending"))).toBeNull();
    expect(await checkProjectConnectors(run(0), async () => ({ code: 1, stdout: "", stderr: "not signed in" }))).toBeNull();
  });

  it("doesn't take a Jira still connecting during setup for a missing one", () => {
    const report = (state: "connected" | "pending" | "missing") => ({
      claude: { ok: true },
      login: { ok: true },
      gh: { ok: true },
      connectors: [{ id: "jira", label: "Atlassian Rovo", purpose: "", required: false, state }],
    });
    expect(projectConnectorsOf(report("connected"))).toEqual({ jira: true, github: true });
    expect(projectConnectorsOf(report("missing"))).toEqual({ jira: false, github: true });
    expect(projectConnectorsOf(report("pending"))).toBeNull();
  });

  it("says why its switch can't be turned on: checking, couldn't check, or what to set up", () => {
    const missingGh = { jira: true, github: false, at: new Date().toISOString() };
    const gate = (o: Partial<Parameters<typeof projectsGate>[0]>) => projectsGate({ on: false, connectors: missingGh, checking: false, checkFailed: false, ...o });
    expect(gate({ on: true })).toEqual({ blocked: false, why: null });
    expect(gate({ connectors: { ...missingGh, github: true } })).toEqual({ blocked: false, why: null });
    expect(gate({})).toEqual({ blocked: true, why: "Set up GitHub to turn it on." });
    expect(gate({ connectors: { ...missingGh, jira: false } })).toEqual({ blocked: true, why: "Set up Jira and GitHub to turn it on." });
    expect(gate({ checking: true })).toEqual({ blocked: true, why: "Checking them…" });
    expect(gate({ checkFailed: true })).toEqual({ blocked: true, why: "Couldn't check them just now." });
    expect(gate({ connectors: null })).toEqual({ blocked: true, why: "Couldn't check them just now." });
  });

  it("checks again only once the last check is a few minutes old", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    const at = (ms: number) => ({ jira: false, github: true, at: new Date(now - ms).toISOString() });
    expect(projectConnectorsRecent(at(60_000), now)).toBe(true);
    expect(projectConnectorsRecent(at(CONNECTORS_RECHECK_MS + 1), now)).toBe(false);
    expect(projectConnectorsRecent(null, now)).toBe(false);
  });
});

describe("Projects off", () => {
  it("leaves the project changes and what a project is out of the chat's changes", () => {
    const on = globalActionDocs(false, true, true);
    const off = globalActionDocs(false, false, true);
    for (const type of PROJECT_ACTIONS) {
      expect(on).toContain(`"type": "${type}"`);
      expect(off).not.toContain(`"type": "${type}"`);
    }
    expect(off).not.toContain("A project is the planner's own record");
    for (const type of ["add_task", "add_task_context", "update_task", "plan_today", "set_task_status", "set_task_priority", "add_note"]) expect(off).toContain(`"type": "${type}"`);
    expect(on).toContain('"what": "all" | "project" | "briefing" | "calendar" | "tasks", "project_id": "C111" or null}');
    expect(off).toContain('"what": "all" | "briefing" | "calendar" | "tasks"}');
    expect(globalActionDocs(true, false, true)).toContain('"type": "watch_topic"');
  });

  it("finds tasks in every channel", () => {
    expect(adhoc()).toContain("NOT part of a project channel");
    expect(adhoc()).toContain("#tmp-refunds");
    const p = adhoc({ projects: false });
    expect(p).toContain("in any channel");
    expect(p).not.toContain("NOT part of a project channel");
    expect(p).not.toContain("#tmp-refunds");
    // News still comes, from every channel.
    expect(p).toContain("- News: list the user's channels (slack_list_user_channels, exclude_archived true) and skim");
  });

  it("doesn't point a #demian message at the project changes", () => {
    const ask = () => selfDmActionsPrompt([{ ts: "1793000000.000100", text: "Refunds is paused until Q3 #demian" }], "What my planner shows right now: …");
    expect(ask()).toContain("uses the project changes");
    setAreaOn("projects", false);
    expect(ask()).not.toContain("uses the project changes");
    expect(ask()).not.toContain('"type": "create_project"');
  });

  it("turns down a project change a chat begun before it was off still proposes", async () => {
    setAreaOn("projects", false);
    await expect(applyAction({ type: "rename_project", project_id: "C1", name: "Refunds" })).rejects.toThrow("Projects is off");
    await expect(applyAction({ type: "set_task_project", task_id: "manual:1", title: "Book venue", project_id: "C1" })).rejects.toThrow("Projects is off");
    await expect(applyAction({ type: "refresh", what: "project", project_id: "C1" })).rejects.toThrow("Projects is off");
  });
});

describe("Updates off", () => {
  it("puts messages waiting on a reply on the task list, with no news", () => {
    const p = adhoc({ updates: false });
    expect(p).toContain("leave the news list empty");
    expect(p).not.toContain("News beyond the project channels");
    expect(p).toContain("Leave the replies list empty");
    expect(p).toContain('follow_up kind "reply"');
    expect(p).toContain("is a task below");
    // Project channels are still left to their projects.
    expect(p).toContain("NOT part of a project channel");
    const on = adhoc();
    expect(on).toContain("News beyond the project channels");
    expect(on).toContain("- replies: every other Slack DM");
  });

  it("leaves the briefing out of the chat's refresh, and turns down a refresh of it", async () => {
    expect(globalActionDocs(false, true, false)).toContain('"what": "all" | "project" | "calendar" | "tasks"');
    setAreaOn("updates", false);
    await expect(applyAction({ type: "refresh", what: "briefing", project_id: null })).rejects.toThrow("Updates, where the daily briefing is, is off");
  });
});

describe("Tasks off", () => {
  it("leaves the task changes out of the chats, and says there's no list", () => {
    const off = globalActionDocs(false, true, true, false);
    for (const type of TASK_ACTIONS) expect(off).not.toContain(`"type": "${type}"`);
    expect(off).toContain('"type": "add_note"');
    // Refresh still rereads Slack and email for the inbox and news while Updates is on.
    expect(off).toContain('"calendar" | "tasks"');
    expect(globalActionDocs(false, true, false, false)).not.toContain('"tasks"');
    expect(globalTaskRules(true)).toBe(GLOBAL_TASK_RULES);
    expect(globalTaskRules(false)).toContain("Tasks is off");
  });

  it("doesn't add a to-do from a #demian message", () => {
    const ask = () => selfDmActionsPrompt([{ ts: "1793000000.000100", text: "Book the venue #demian" }], "What my planner shows right now: …");
    expect(ask()).toContain("Most are a to-do: add_task");
    setAreaOn("tasks", false);
    expect(ask()).not.toContain("Most are a to-do: add_task");
    expect(ask()).toContain("Tasks is off in my planner");
  });

  it("turns down a task change a chat begun before it was off still proposes", async () => {
    setAreaOn("tasks", false);
    await expect(applyAction({ type: "set_task_status", task_id: "manual:1", title: "Book venue", status: "done" })).rejects.toThrow("Tasks is off");
  });
});
