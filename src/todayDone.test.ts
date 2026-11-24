import { afterEach, describe, expect, it, vi } from "vitest";
import { doneStaysSince } from "./todayDone";

describe("doneStaysSince", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the start of the day it first runs, and stays that day after", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const first = doneStaysSince(new Date(2026, 10, 23, 15, 30));
    expect(first).toBe(new Date(2026, 10, 23).toISOString());
    expect(doneStaysSince(new Date(2026, 10, 25, 9))).toBe(first);
  });
});
