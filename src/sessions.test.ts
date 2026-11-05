import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./db", () => ({}));

const { parseProgress, parsePlan, currentPlan, readableReply, parseSends } = await import("./sessions");
const { taskChatPrompt, sessionMarker, resumeSessionUrl } = await import("./openInClaude");

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
      // Never reported done: step 3 coming after it doesn't finish it (a re-check settles it).
      2: { state: "started" },
      3: { state: "waiting", note: "need Eric's export" },
      4: { state: "done" },
    });
  });

  it("finishes the plan only when every step is done and nothing is left to send", async () => {
    const { planFinished } = await import("./sessions");
    expect(planFinished([{ state: "done" }, { state: "skipped" }, { state: "done" }], 0)).toBe(true);
    // The last step is done, but an earlier one isn't.
    expect(planFinished([{ state: "done" }, { state: "waiting", note: "review and create the doc" }, { state: "done" }], 0)).toBe(false);
    expect(planFinished([{ state: "done" }, { state: "started" }, { state: "done" }], 0)).toBe(false);
    expect(planFinished([{ state: "done" }, undefined], 0)).toBe(false);
    // Every step is done, but a draft is still waiting for you to send or create it.
    expect(planFinished([{ state: "done" }, { state: "done" }], 1)).toBe(false);
    // Nothing done at all isn't finished.
    expect(planFinished([{ state: "skipped" }], 0)).toBe(false);
    expect(planFinished([], 0)).toBe(false);
  });

  it("puts the marker first and asks for progress lines in a task's chat", () => {
    const p = taskChatPrompt({ id: "t-42", title: "Draft the ticket" }, "Claude drafts it.", [{ title: "Read ABC-1", by: "claude" }]);
    expect(p.startsWith(`${sessionMarker("t-42")}\n`)).toBe(true);
    expect(p).toContain("[orb] step N done");
  });

  it("opens a chat on a task with no plan yet", () => {
    const p = taskChatPrompt({ id: "t-7", title: "Book the venue" }, "", []);
    expect(p).toContain("There's no plan for it yet");
    expect(p).toContain("asking me whether I'd like you to plan the steps");
    expect(p).not.toContain("Your suggestion:");
    expect(p).not.toContain("The plan, in order");
  });

  it("leaves the marker out without a task id", () => {
    const p = taskChatPrompt({ title: "Draft the ticket" }, "Claude drafts it.", [{ title: "Read ABC-1", by: "claude" }]);
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
  it("doesn't count an earlier started step as done because a later one moved", async () => {
    const { parseProgress, looksOutOfSync } = await import("./sessions");
    const steps = parseProgress(["[orb] step 1 started", "[orb] step 2 started", "[orb] step 2 done", "[orb] step 3 waiting: confirm the channel"]);
    expect(steps).toEqual({ 1: { state: "started" }, 2: { state: "done" }, 3: { state: "waiting", note: "confirm the channel" } });
    // That's out of order, so the card re-checks it against the conversation instead.
    expect(looksOutOfSync([steps[1], steps[2], steps[3]])).toBe(true);
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

describe("re-checked steps", () => {
  it("spots a later step moving while an earlier one isn't done", async () => {
    const { looksOutOfSync } = await import("./sessions");
    expect(looksOutOfSync([{ state: "done" }, { state: "waiting" }, { state: "started" }])).toBe(true);
    expect(looksOutOfSync([{ state: "done" }, { state: "skipped" }, { state: "started" }, undefined])).toBe(false);
  });

  it("applies the session's later reports on top of a re-check", async () => {
    const { stepsNow } = await import("./sessions");
    const recheck = { plan: [{ title: "A", by: "claude" as const }, { title: "B", by: "you" as const }], states: { 1: { state: "done" as const } }, reports: 2 };
    expect(stepsNow(["[orb] step 1 started", "[orb] step 4 started", "[orb] step 2 done"], [], recheck)).toEqual({
      plan: recheck.plan,
      steps: { 1: { state: "done" }, 2: { state: "done" } },
    });
  });
});

describe("a task's chat", () => {
  it("opens with the plan, holds the work until you say go, and keeps the steps current", async () => {
    const p = taskChatPrompt({ id: "t-1", title: "Confirm refunds" }, "Draft the summary", [
      { title: "Draft the summary", by: "claude" },
      { title: "Post it", by: "you" },
    ]);
    expect(p).toMatch(/^Orb task: t-1\n/);
    expect(p).toContain("2. [Me] Post it");
    expect(p).toMatch(/Until I tell you to go ahead, .*don't start the steps/);
    // Extra work you ask for is a step, restated before it's done, before and after the go-ahead.
    expect(p).toMatch(/anything I ask for that the steps don't cover yet .* which is a new step/);
    expect(p).toMatch(/It holds after you've started too/);
  });

  it("knows whether you've spoken since the plan was last restated", async () => {
    const { heardSincePlan } = await import("./sessions");
    const opening = { role: "user" as const, text: "Orb task: t-1\n\nI'd like to work through this task" };
    expect(heardSincePlan([opening, { role: "assistant", text: "Here's my take." }])).toEqual({ userMessages: 0, userSincePlan: false });
    // You asked for more and Claude carried on without restating the plan.
    expect(
      heardSincePlan([opening, { role: "assistant", text: "Here's my take." }, { role: "user", text: "Go, and split it by region too" }, { role: "assistant", text: "Done.\n[orb] step 4 done" }]),
    ).toEqual({ userMessages: 1, userSincePlan: true });
    // It restated the plan after your message (in a code span too).
    expect(
      heardSincePlan([opening, { role: "user", text: "Add the region split" }, { role: "assistant", text: "Added it.\n`[orb] plan`\n1. Read it\n2. Split by region\n[orb] end" }]),
    ).toEqual({ userMessages: 1, userSincePlan: false });
  });

  it("reads requests for more code, and hides Orb's own notes to the session", async () => {
    const { codeRequests, readableMessages, heardSincePlan, ORB_NOTE } = await import("./sessions");
    expect(codeRequests(["[orb] step 2 started", "[orb] code acme/storefront-ui", "[orb] code: acme/storefront-ui", "[orb] code ~/code/search-api"])).toEqual(["acme/storefront-ui", "~/code/search-api"]);
    const note = { role: "user" as const, text: `${ORB_NOTE} you can read acme/storefront-ui now. Carry on where you left off.)` };
    const raw = [{ role: "user" as const, text: "Go ahead" }, { role: "assistant" as const, text: "I need the UI code.\n[orb] code acme/storefront-ui" }, note, { role: "assistant" as const, text: "Reading it now." }];
    expect(readableMessages(raw).map((m) => m.text)).toEqual(["Go ahead", "I need the UI code.", "Reading it now."]);
    // The note isn't you speaking, so it doesn't count toward re-checking the steps.
    expect(heardSincePlan(raw)).toEqual({ userMessages: 1, userSincePlan: true });
  });

  it("re-checks the steps when they may not reflect the chat", async () => {
    const { stepsNeedRecheck } = await import("./sessions");
    const shown = [{ state: "done" as const }, undefined, undefined];
    // Nothing new: you haven't spoken since the plan, and the reports fit the list.
    expect(stepsNeedRecheck({ steps: { 1: { state: "done" } }, userMessages: 1, userSincePlan: false }, shown, 0)).toBe(false);
    // You said something it didn't restate the plan for, and the last re-check hasn't seen it.
    expect(stepsNeedRecheck({ steps: { 1: { state: "done" } }, userMessages: 2, userSincePlan: true }, shown, 1)).toBe(true);
    // The last re-check already heard it.
    expect(stepsNeedRecheck({ steps: { 1: { state: "done" } }, userMessages: 2, userSincePlan: true }, shown, 2)).toBe(false);
    // It reported a step the list doesn't have.
    expect(stepsNeedRecheck({ steps: { 4: { state: "done" } }, userMessages: 0, userSincePlan: false }, shown, 0)).toBe(true);
    // A later step moved while an earlier one isn't done.
    expect(stepsNeedRecheck({ steps: {} }, [undefined, { state: "started" }], 0)).toBe(true);
  });

  it("asks the re-check to add work you asked for and leave a list that matches", async () => {
    const { recheckStepsPrompt } = await import("./prompts");
    const p = recheckStepsPrompt({ task: "Investigate the dip", steps: [{ title: "Read the results", by: "claude", state: null }], conversation: [{ role: "user", text: "Also split it by region" }] });
    expect(p).toMatch(/if it already matches, return it as it is/);
    expect(p).toMatch(/When I asked for work the steps don't cover .* that's a step/);
    expect(p).toMatch(/Until I've told Claude to go ahead, we're only talking the plan through/);
  });
});

describe("restating the plan", () => {
  const opening = {
    role: "user" as const,
    text: "Orb task: t-1\n\nI'd like to work through this task\n\nThe plan, in order. Steps marked [Me] are mine; the rest are yours:\n1. Read the API thread\n2. Read the epic's tickets\n3. Draft the ticket\n4. [Me] File the ticket\n\nReport progress so my planner can follow along.",
  };

  it("reads the plan a chat opened with", async () => {
    const { openingPlan } = await import("./sessions");
    expect(openingPlan([opening])).toEqual([
      { title: "Read the API thread", by: "claude" },
      { title: "Read the epic's tickets", by: "claude" },
      { title: "Draft the ticket", by: "claude" },
      { title: "File the ticket", by: "you" },
    ]);
    expect(openingPlan([{ role: "user", text: "Hello" }])).toBeNull();
  });

  it("keeps each step's state when the plan is restated with a step added", async () => {
    const { stepsNow, openingPlan } = await import("./sessions");
    const lines = ["[orb] step 1 done", "[orb] step 2 done", "[orb] step 3 done", "[orb] plan", "[orb] step 4 started", "[orb] step 4 done", "[orb] step 5 waiting: file the ticket"];
    const blocks = [{ header: "[orb] plan", body: "1. Read the API thread\n2. Read the epic's tickets\n3. Draft the ticket\n4. Rewrite the ticket to match the others\n5. [Me] File the ticket" }];
    const now = stepsNow(lines, blocks, undefined, openingPlan([opening]));
    expect(now.plan?.map((st) => st.title)).toEqual(["Read the API thread", "Read the epic's tickets", "Draft the ticket", "Rewrite the ticket to match the others", "File the ticket"]);
    // Steps 1 to 3 stay done; the new step 4 and step 5 follow the reports after the restatement.
    expect(now.steps).toEqual({ 1: { state: "done" }, 2: { state: "done" }, 3: { state: "done" }, 4: { state: "done" }, 5: { state: "waiting", note: "file the ticket" } });
  });

  it("keeps a re-check's states when the session restates the same plan after it", async () => {
    const { stepsNow } = await import("./sessions");
    const recheck = { plan: [{ title: "Read it", by: "claude" as const }, { title: "File it", by: "claude" as const }], states: { 1: { state: "done" as const }, 2: { state: "started" as const } }, reports: 1 };
    const now = stepsNow(["[orb] step 1 done", "[orb] plan", "[orb] step 2 waiting: review and create the ticket"], [{ header: "[orb] plan", body: "1. Read it\n2. [Me] File it" }], recheck);
    expect(now.steps).toEqual({ 1: { state: "done" }, 2: { state: "waiting", note: "review and create the ticket" } });
  });

  it("starts a reworded step fresh, and carries nothing when the old plan isn't known", async () => {
    const { carryStates } = await import("./sessions");
    const before = [{ title: "Read it", by: "claude" as const }, { title: "Draft it", by: "claude" as const }];
    expect(carryStates(before, { 1: { state: "done" }, 2: { state: "done" } }, [{ title: "Draft it", by: "claude" }, { title: "Draft it again, shorter", by: "claude" }])).toEqual({ 1: { state: "done" } });
    expect(carryStates(null, { 1: { state: "done" } }, [{ title: "Read it", by: "claude" }])).toEqual({});
  });
});

describe("tickets handed to Orb", () => {
  it("reads a ticket block and hides it from the chat", async () => {
    const { parseSends, readableReply } = await import("./sessions");
    const body = "project: ABC\ntype: Task\nepic: ABC-12\ncomponent: Web\n\nAdd an export button to the report page.";
    const [ticket] = parseSends([{ header: "[orb] ticket step 5: Add the export button", body }]);
    expect(ticket).toMatchObject({ kind: "ticket", step: 5, to: "Add the export button", text: body });
    expect(readableReply(`Here it is.\n[orb] ticket step 5: Add the export button\n${body}\n[orb] end\n[orb] step 5 waiting: review and create the ticket`)).toBe("Here it is.");
  });

  it("files it as reviewed, in its epic, and tells every session how to hand one over", async () => {
    const { createTicketPrompt } = await import("./prompts");
    const { SESSION_DISPLAY } = await import("./claude");
    const p = createTicketPrompt("Add the export button", "project: ABC\ntype: Task\nepic: ABC-12\n\nAdd an export button to the report page.");
    expect(p).toMatch(/jira_create_issue exactly once/);
    expect(p).toMatch(/"epicKey"/);
    expect(p).toMatch(/exactly as written/);
    expect(SESSION_DISPLAY).toMatch(/\[orb\] ticket step N: /);
    expect(SESSION_DISPLAY).toMatch(/Filing it is your step, not mine/);
  });
});

describe("docs handed to Orb", () => {
  it("reads a doc that isn't a plan step", () => {
    const [doc] = parseSends([{ header: "[orb] doc: Launch Test Plan", body: "# Test plan\n- Install the build\n- Check the filter" }]);
    expect(doc).toMatchObject({ kind: "doc", to: "Launch Test Plan", text: "# Test plan\n- Install the build\n- Check the filter" });
    expect(doc.step).toBeUndefined();
  });
});

describe("events handed to Orb", () => {
  const block = { header: "[orb] event step 2: Filter sync", body: "when: 2026-11-04 14:00-14:30\nwho: ana@example.com, ben@example.com\nmeet: yes\n\nWalk through the publisher filter." };
  it("reads an invite for a plan step", () => {
    const [ev] = parseSends([block]);
    expect(ev).toMatchObject({ kind: "event", step: 2, to: "Filter sync" });
    expect(ev.text).toContain("who: ana@example.com, ben@example.com");
  });
  it("keeps the invite out of the chat's text", () => {
    expect(readableReply(`I found a time.\n${block.header}\n${block.body}\n[orb] end\nReview it when you can.`)).toBe("I found a time.\n\nReview it when you can.");
  });
});

describe("Orb's notes to Claude", () => {
  it("are left out of your messages in the chat", async () => {
    const { readableMessages } = await import("./sessions");
    const [m] = readableMessages([{ role: "user", text: "Should the test plan be a doc or a sheet?\n\n(From Orb: you can make Google Docs here, through me.)" }]);
    expect(m.text).toBe("Should the test plan be a doc or a sheet?");
  });
});

describe("the chat's order during a turn", () => {
  const u = (text: string) => ({ role: "user" as const, text });
  const a = (text: string) => ({ role: "assistant" as const, text });
  it("keeps Claude's previous reply above your new message while the transcript catches up", async () => {
    const { chatView } = await import("./sessions");
    const before = [u("one"), a("reply one")];
    const v = chatView(before, { base: 2, text: "two" }, { working: true, live: null, held: null });
    expect(v.shown.map((m) => m.text)).toEqual(["one", "reply one", "two"]);
  });
  it("counts a previous reply that lands late as before the turn", async () => {
    const { chatView } = await import("./sessions");
    // Sent while the transcript still lacked "reply one".
    const v = chatView([u("one"), a("reply one")], { base: 1, text: "two" }, { working: true, live: "thinking about two", held: null });
    expect(v.shown.map((m) => m.text)).toEqual(["one", "reply one", "two"]);
    expect(v.reply).toBe("thinking about two");
  });
  it("holds back the transcript's partial reply while the live one streams", async () => {
    const { chatView } = await import("./sessions");
    const v = chatView([u("one"), a("reply one"), u("two"), a("rep")], { base: 2, text: "two" }, { working: true, live: "reply two so far", held: null });
    expect(v.shown.map((m) => m.text)).toEqual(["one", "reply one", "two"]);
    expect(v.reply).toBe("reply two so far");
  });
  it("keeps your message and the last live text after the turn until the transcript has them", async () => {
    const { chatView } = await import("./sessions");
    const v = chatView([u("one"), a("reply one")], { base: 2, text: "two" }, { working: false, live: null, held: "reply two" });
    expect(v.shown.map((m) => m.text)).toEqual(["one", "reply one", "two"]);
    expect(v.reply).toBe("reply two");
    expect(v.done).toBe(false);
  });
  it("lets go once the transcript has the whole turn", async () => {
    const { chatView } = await import("./sessions");
    const v = chatView([u("one"), a("reply one"), u("two"), a("reply two")], { base: 2, text: "two" }, { working: false, live: null, held: "reply two" });
    expect(v.shown.map((m) => m.text)).toEqual(["one", "reply one", "two", "reply two"]);
    expect(v.reply).toBeNull();
    expect(v.done).toBe(true);
  });
  it("handles a turn Orb started, with no message of yours", async () => {
    const { chatView } = await import("./sessions");
    const v = chatView([u("one"), a("reply one")], { base: 2, text: null }, { working: true, live: "carrying on", held: null });
    expect(v.shown.map((m) => m.text)).toEqual(["one", "reply one"]);
    expect(v.reply).toBe("carrying on");
  });
});

describe("where a message goes", () => {
  it("uses the session's words for it, and the conversation kind from a permalink otherwise", async () => {
    const { parseSends, sendDestination } = await import("./sessions");
    const [named] = parseSends([{ header: "[orb] send to https://example.slack.com/archives/G0123/p1700000000000100 (group DM with Ana, Ben)", body: "Hi" }]);
    expect(named.to).toBe("https://example.slack.com/archives/G0123/p1700000000000100");
    expect(sendDestination(named)).toBe("the thread in group DM with Ana, Ben");
    expect(sendDestination({ to: "https://example.slack.com/archives/D0456/p1700000000000100" })).toBe("the thread in a DM");
    expect(sendDestination({ to: "https://example.slack.com/archives/C0789/p1700000000000100" })).toBe("the thread in a channel");
    expect(sendDestination({ to: "#launch-team" })).toBe("#launch-team");
  });
});

describe("a chat adopted as a task's", () => {
  it("gives the steps and how to report them, hidden from the chat", async () => {
    const { adoptAsTaskNote } = await import("./openInClaude");
    const { withoutOrbNotes } = await import("./sessions");
    const note = adoptAsTaskNote("Reply to Sam", ["Read the thread", "[Me] Send the reply"]);
    expect(note).toContain("1. Read the thread");
    expect(note).toContain("[orb] step N done");
    expect(withoutOrbNotes(`Carry on\n\n${note}`)).toBe("Carry on");
  });
});
