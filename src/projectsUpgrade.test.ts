import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { areaOn, projectConnectors } = await import("./features");
const { markProjectsUpgradeDone, projectsUpgradeSettled, turnOffProjectsWithoutConnectors } = await import("./projectsUpgrade");

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

const check = (c: { jira: boolean; github: boolean } | null) => async () => c;

describe("after an upgrade, Projects without Jira and GitHub", () => {
  it("is turned off once, when either is missing, and its check is kept for Settings", async () => {
    expect(areaOn("projects")).toBe(true);
    expect(await turnOffProjectsWithoutConnectors(check({ jira: true, github: false }))).toBe("off");
    expect(areaOn("projects")).toBe(false);
    expect(projectConnectors()).toMatchObject({ jira: true, github: false });
    // Once: turned on again later (after connecting them), it isn't turned off again.
    expect(await turnOffProjectsWithoutConnectors(check({ jira: false, github: false }))).toBe("settled");
  });

  it("stays on with both connected", async () => {
    expect(await turnOffProjectsWithoutConnectors(check({ jira: true, github: true }))).toBe("kept");
    expect(areaOn("projects")).toBe(true);
    expect(projectsUpgradeSettled()).toBe(true);
  });

  it("waits for a check that can tell, trying again next time", async () => {
    expect(await turnOffProjectsWithoutConnectors(check(null))).toBe("unknown");
    expect(await turnOffProjectsWithoutConnectors(async () => Promise.reject(new Error("claude not found")))).toBe("unknown");
    expect(areaOn("projects")).toBe(true);
    expect(projectsUpgradeSettled()).toBe(false);
    expect(await turnOffProjectsWithoutConnectors(check({ jira: false, github: true }))).toBe("off");
  });

  it("is left to a first run's onboarding, which sets Projects itself", async () => {
    markProjectsUpgradeDone();
    expect(await turnOffProjectsWithoutConnectors(check({ jira: false, github: false }))).toBe("settled");
    expect(areaOn("projects")).toBe(true);
  });
});
