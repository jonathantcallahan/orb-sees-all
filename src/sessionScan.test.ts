import { describe, expect, it } from "vitest";
import { SAME_WORK_RULE } from "./baseLessons";
import { sessionScanPrompt } from "./prompts";
import { acceptedSessionMatches, nextScanSince, scanCandidates, scanEntry, scanSkips } from "./sessionScan";
import type { RecentSession } from "./sessions";

const session = (sessionId: string, modifiedMs: number, more: Partial<RecentSession> = {}): RecentSession => ({
  path: `/p/${sessionId}.jsonl`,
  sessionId,
  modifiedMs,
  cwd: "/Users/me/storefront",
  title: `Session ${sessionId}`,
  prompt: "Fix the publisher filter",
  lastAsk: null,
  lastReply: null,
  ...more,
});

describe("scanning your Claude Code sessions", () => {
  it("looks at new sessions, and skipped ones again once they carry on, never ones it linked or you disconnected", () => {
    const found = [session("new", 50), session("quiet", 40), session("active", 60), session("linked", 70), session("declined", 80)];
    const picked = scanCandidates(found, {
      quiet: { decision: "skipped", at: 40 },
      active: { decision: "skipped", at: 45 },
      linked: { decision: "connected", taskId: "t1", at: 10 },
      declined: { decision: "declined", taskId: "t2", at: 10 },
    });
    expect(picked.map((s) => s.sessionId)).toEqual(["new", "active"]);
  });

  it("leaves out sessions it settled, or a task follows, before they're read; skipped ones until they carry on", () => {
    const skip = scanSkips(
      { a: { decision: "connected", taskId: "t1", at: 5 }, b: { decision: "skipped", at: 7 }, c: { decision: "declined", at: 9 } },
      { t2: { startedAt: 1, sessionId: "d" }, t3: { startedAt: 1 } },
    );
    expect(skip).toEqual({ a: Number.MAX_SAFE_INTEGER, b: 7, c: Number.MAX_SAFE_INTEGER, d: Number.MAX_SAFE_INTEGER });
  });

  it("looks next from where it left off, so no session is passed over", () => {
    const waiting = [session("a", 900), session("b", 800), session("c", 700)];
    const base = { now: 1000, since: 100, waiting, marginMs: 10 };
    // All settled: from now.
    expect(nextScanSince({ ...base, more: false, decided: new Set(["a", "b", "c"]) })).toBe(990);
    // One left for next time (not answered for, or past the cap): from it.
    expect(nextScanSince({ ...base, more: false, decided: new Set(["a", "c"]) })).toBe(790);
    // More than one scan takes: from the same place, to get to the rest.
    expect(nextScanSince({ ...base, more: true, decided: new Set(["a", "b", "c"]) })).toBe(100);
  });

  it("connects only to open tasks with no session, one session each, and caps new tasks", () => {
    const sessions = [session("a", 5), session("b", 4), session("c", 3), session("d", 2), session("e", 1), session("f", 0)];
    const matches = acceptedSessionMatches(
      [
        { id: "a", action: "connect", task_id: "slack:1", why: "Same fix" },
        { id: "b", action: "connect", task_id: "slack:1", why: "Also the fix" },
        { id: "c", action: "connect", task_id: "manual:busy", why: "x" },
        { id: "d", action: "new", title: " Write the refunds brief ", description: "Draft it.", project_id: "C-unknown", why: "Unfinished" },
        { id: "e", action: "new", title: "Second", project_id: "C1", why: "Unfinished" },
        { id: "f", action: "new", title: "Over the cap", why: "x" },
      ],
      { sessions, open: new Set(["slack:1", "manual:busy"]), linked: new Set(["manual:busy"]), projects: new Set(["C1"]), maxNew: 2 },
    );
    expect(matches.map((m) => [m.session.sessionId, m.action])).toEqual([
      ["a", "connect"],
      ["b", "skip"],
      ["c", "skip"],
      ["d", "new"],
      ["e", "new"],
    ]);
    expect(matches[3]).toMatchObject({ title: "Write the refunds brief", projectId: null, description: "Draft it." });
    expect(matches[4]).toMatchObject({ projectId: "C1" });
  });

  it("leaves a session it wasn't answered for to look at next time", () => {
    const matches = acceptedSessionMatches([{ id: "gone", action: "skip" }], { sessions: [session("a", 1)], open: new Set(), linked: new Set(), projects: new Set(), maxNew: 5 });
    expect(matches).toEqual([]);
  });

  it("asks about each session with where it got to, against every open task and project folder", () => {
    const entry = scanEntry(session("a", 1, { lastAsk: "Now open a PR", lastReply: "Opened the PR." }), "2h ago");
    expect(entry).toMatchObject({ id: "a", folder: "/Users/me/storefront", last_active: "2h ago", latest_ask: "Now open a PR", latest_reply: "Opened the PR." });
    expect(scanEntry(session("b", 1, { lastAsk: "Fix the publisher filter" }), "now")).not.toHaveProperty("latest_ask");
    const p = sessionScanPrompt({
      sessions: [entry],
      index: [{ id: "slack:1", title: "Fix the publisher filter" }],
      projects: [{ id: "C1", name: "Storefront", folders: ["/Users/me/storefront"] }],
      lessons: ["Quick questions to Claude aren't tasks"],
    });
    expect(p).toContain(SAME_WORK_RULE);
    expect(p).toContain('"latest_reply":"Opened the PR."');
    expect(p).toContain('"id":"slack:1"');
    expect(p).toContain('"folders":["/Users/me/storefront"]');
    expect(p).toContain("- Quick questions to Claude aren't tasks");
  });
});
