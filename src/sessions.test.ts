import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./db", () => ({}));

const { parseProgress, parsePlan, currentPlan, readableReply, parseSends } = await import("./sessions");
const { startPrompt, sessionMarker, resumeSessionUrl } = await import("./openInClaude");

describe("session progress", () => {
  it("keeps each step's latest report", () => {
    expect(
      parseProgress([
        "[orb] step 1 started",
        "[orb] step 1 done",
        "[orb] step 2 started",
        "[orb] step 3 waiting: need Eric's export",
        "[orb] Step 4 DONE",
        "not a report",
      ]),
    ).toEqual({
      1: { state: "done" },
      // Never reported done, but step 3 came after it.
      2: { state: "done" },
      3: { state: "waiting", note: "need Eric's export" },
      4: { state: "done" },
    });
  });

  it("puts the marker first and asks for progress lines in Approve & start", () => {
    const p = startPrompt({ id: "t-42", title: "Draft the ticket" }, "Claude drafts it.", [{ title: "Read CPS-1", by: "claude" }]);
    expect(p.startsWith(`${sessionMarker("t-42")}\n`)).toBe(true);
    expect(p).toContain("[orb] step N done");
  });

  it("leaves the marker out without a task id", () => {
    const p = startPrompt({ title: "Draft the ticket" }, "Claude drafts it.", [{ title: "Read CPS-1", by: "claude" }]);
    expect(p).not.toContain("Orb task:");
    expect(p).not.toContain("[orb]");
  });

  it("reopens a linked session by id", () => {
    expect(resumeSessionUrl("1f2e-3d4c")).toBe("claude://resume?session=1f2e-3d4c");
  });
});

describe("step state", () => {
  it("prefers a step the user marked done over the session's last report", async () => {
    const { stepState } = await import("./sessions");
    const progress = { steps: { 2: { state: "done" as const }, 3: { state: "waiting" as const, note: "send the draft" } }, sends: [], updatedAt: 1, found: true };
    const link = { startedAt: 0, doneSteps: [3] };
    expect(stepState(progress, link, 3)).toEqual({ state: "done" });
    expect(stepState(progress, link, 2)).toEqual({ state: "done" });
    expect(stepState(progress, { startedAt: 0 }, 3)).toEqual({ state: "waiting", note: "send the draft" });
    expect(stepState(null, link, 1)).toBeUndefined();
  });
});

describe("progress reports", () => {
  it("counts an earlier started step as done once a later one is reported", async () => {
    const { parseProgress } = await import("./sessions");
    const steps = parseProgress(["[orb] step 1 started", "[orb] step 2 started", "[orb] step 2 done", "[orb] step 3 waiting: confirm the channel"]);
    expect(steps).toEqual({ 1: { state: "done" }, 2: { state: "done" }, 3: { state: "waiting", note: "confirm the channel" } });
  });

  it("leaves an earlier step that's waiting on the user as waiting", async () => {
    const { parseProgress } = await import("./sessions");
    const steps = parseProgress(["[orb] step 1 waiting: send me the doc", "[orb] step 2 started"]);
    expect(steps[1]).toEqual({ state: "waiting", note: "send me the doc" });
    expect(steps[2]).toEqual({ state: "started" });
  });
});

describe("handed-off messages", () => {
  it("reads the destination, step and text, unwrapping a code fence", async () => {
    const { parseSends } = await import("./sessions");
    const [send] = parseSends([{ header: "[orb] send step 3 to #tmp-asset-library-plugin:", body: "```\nHeads up, the filter is ready.\n• Use publisherId=\n```" }]);
    expect(send).toMatchObject({ step: 3, to: "#tmp-asset-library-plugin", text: "Heads up, the filter is ready.\n• Use publisherId=" });
    expect(parseSends([{ header: "[orb] send to https://x.slack.com/archives/C1/p1700000000000100", body: "Done!" }])[0]).toMatchObject({ to: "https://x.slack.com/archives/C1/p1700000000000100", text: "Done!" });
    expect(parseSends([{ header: "[orb] sending soon", body: "x" }])).toEqual([]);
  });

  it("keeps only the latest unsent message for each step", async () => {
    const { parseSends, unsentMessages } = await import("./sessions");
    const sends = parseSends([
      { header: "[orb] send step 3 to #a", body: "first draft" },
      { header: "[orb] send step 3 to #a", body: "second draft" },
      { header: "[orb] send step 4 to #b", body: "other" },
    ]);
    expect(unsentMessages(sends, { startedAt: 0 }).map((s) => s.text)).toEqual(["second draft", "other"]);
    expect(unsentMessages(sends, { startedAt: 0, sentKeys: [sends[1].key] }).map((s) => s.text)).toEqual(["other"]);
  });
});

describe("readable reply", () => {
  it("drops report lines and hand-off blocks, keeping what Claude said", async () => {
    const { readableReply } = await import("./sessions");
    const text = "[orb] step 1 done\n\nTwo rates are on the table:\n- 0.92 (storefront)\n- 0.85 (Finance)\n\n[orb] send step 5 to #refunds\nDraft here\n[orb] end\n`[orb] step 2 waiting: which rate?`";
    expect(readableReply(text)).toBe("Two rates are on the table:\n- 0.92 (storefront)\n- 0.85 (Finance)");
  });
});

describe("revised plans", () => {
  it("reads the steps of a plan block, [Me] marking the user's", () => {
    expect(parsePlan("1. Draft the summary\n2. [Me] Ask Eric to clear the 15-day window with Legal\n- Post the decisions")).toEqual([
      { title: "Draft the summary", by: "claude" },
      { title: "Ask Eric to clear the 15-day window with Legal", by: "you" },
      { title: "Post the decisions", by: "claude" },
    ]);
  });

  it("counts only the reports after the latest plan, which renumbers the steps", () => {
    const lines = ["[orb] step 3 done", "[orb] step 4 waiting: ask Legal", "[orb] plan", "[orb] step 1 done", "[orb] step 2 skipped: Eric took it"];
    const { plan, lines: after } = currentPlan(lines, [{ header: "[orb] plan", body: "1. Draft\n2. [Me] Ask Legal\n3. Post" }]);
    expect(plan).toHaveLength(3);
    expect(parseProgress(after)).toEqual({ 1: { state: "done" }, 2: { state: "skipped", note: "Eric took it" } });
  });

  it("keeps the original numbering until the session revises the plan", () => {
    const lines = ["[orb] step 1 done"];
    expect(currentPlan(lines, [])).toEqual({ plan: null, lines });
  });

  it("hides plan blocks from the chat and isn't mistaken for a message to send", () => {
    expect(readableReply("Updated the plan.\n[orb] plan\n1. Draft\n[orb] end")).toBe("Updated the plan.");
    expect(parseSends([{ header: "[orb] plan", body: "1. Draft" }])).toEqual([]);
  });
});

describe("blocked steps", () => {
  it("records who or what a blocked step is waiting on", () => {
    expect(parseProgress(["[orb] step 2 blocked: Legal's answer on the 15-day window"])).toEqual({
      2: { state: "blocked", note: "Legal's answer on the 15-day window" },
    });
  });
});
