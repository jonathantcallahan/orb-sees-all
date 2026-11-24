import { describe, expect, it, vi } from "vitest";
import { setAreaOn } from "./features";
import { afterMissedRead, emptySelfDmState, parseSelfDmState, SELF_DM_DEFAULT, SELF_DM_MISSES, selfDmEvery, selfDmOldest, selfDmReplies, takeFromPoll, unreadReason, type SelfDmState } from "./selfDm";
import { SelfDmPoll } from "./schema";
import { SELF_DM_READ_TOOL, selfDmActionsPrompt, selfDmPrompt, selfDmReplyPrompt } from "./prompts";
import { TOOLS } from "./claude";

const now = new Date("2026-11-04T17:00:00Z");
const nowS = now.getTime() / 1000;
const ts = (agoS: number) => (nowS - agoS).toFixed(6);
const msg = (t: string, text: string) => ({ ts: t, text });

describe("instructions from the user's own DM", () => {
  it("reads the saved interval: unset is the default, and the old every-30-seconds is every 5 minutes", () => {
    expect(selfDmEvery(null)).toBe(SELF_DM_DEFAULT);
    expect(selfDmEvery("off")).toBe("off");
    expect(selfDmEvery("300")).toBe("300");
    expect(selfDmEvery("30")).toBe("300");
  });

  it("looks back a day on the first check, then only after the newest message seen", () => {
    expect(selfDmOldest(emptySelfDmState(), now)).toBe((nowS - 86400).toFixed(6));
    expect(selfDmOldest({ ...emptySelfDmState(), cursor: "1793000000.000100" }, now)).toBe("1793000000.000100");
  });

  it("keeps only messages that really carry the tag, are new and haven't been taken", () => {
    const oldest = ts(600);
    const taken = ts(300);
    const { messages } = takeFromPoll(
      { ...emptySelfDmState(), seen: [taken] },
      {
        latest_ts: ts(10),
        messages: [
          msg(ts(100), "Book the venue #demian"),
          msg(ts(90), "Draft: hey can you book the venue?"),
          msg(taken, "Already added #Demian"),
          msg(ts(900), "Too old #demian"),
          msg((nowS + 3600).toFixed(6), "From the future #demian"),
          msg(ts(80), "  #demian "),
        ],
      },
      oldest,
      now,
    );
    expect(messages.map((m) => m.text)).toEqual(["Book the venue #demian"]);
  });

  it("takes the tag as Slack links it once there's a #demian channel, and hands it on as typed", () => {
    const forwarded = "\nForwarded message from Sam (https://example.slack.com/archives/C1/p1): Are there submission requirements for NuGet?";
    const { messages } = takeFromPoll(
      emptySelfDmState(),
      {
        latest_ts: ts(10),
        messages: [
          msg(ts(100), `<#C0DEMIAN42|demian> look into this${forwarded}`),
          msg(ts(90), "<#C0DEMIAN42|Demian> book the venue"),
          msg(ts(80), "<#C0123ABCD|general> book the venue"),
          msg(ts(70), " <#C0DEMIAN42|demian> "),
        ],
      },
      ts(600),
      now,
    );
    expect(messages.map((m) => m.text)).toEqual([`#demian look into this${forwarded}`, "#demian book the venue"]);
  });

  it("moves the cursor to the newest message read, even when nothing was tagged", () => {
    const { state } = takeFromPoll(emptySelfDmState(), { latest_ts: ts(5), messages: [] }, ts(600), now, 0.004);
    expect(state.cursor).toBe(ts(5));
    expect(state.runs).toBe(1);
    expect(state.usd).toBeCloseTo(0.004);
    // A made-up or missing ts leaves it where it was.
    const again = takeFromPoll(state, { latest_ts: "soon", messages: [] }, ts(5), now);
    expect(again.state.cursor).toBe(ts(5));
    expect(again.state.runs).toBe(2);
    // An empty first read pins the start, so later checks don't look back a day each time.
    expect(takeFromPoll(emptySelfDmState(), { latest_ts: null, messages: [] }, ts(86400), now).state.cursor).toBe(ts(86400));
  });

  it("starts a fresh count of failed tries once a check gets through", () => {
    const { state } = takeFromPoll({ ...emptySelfDmState(), tries: 2, misses: 2 }, { latest_ts: ts(5), messages: [] }, ts(600), now);
    expect(state.tries).toBe(0);
    expect(state.misses).toBe(0);
  });

  it("logs a check that couldn't read the DM only once the reads keep failing, and once per error", () => {
    // A Slack connector still connecting, or the network just back: the next check usually gets through.
    let state: SelfDmState = { ...emptySelfDmState(), cursor: ts(600) };
    const errors: (string | null)[] = [];
    for (const error of ["Slack wasn't reachable", "Slack wasn't reachable", "Slack wasn't reachable", "Slack wasn't reachable", "ENOTFOUND"]) {
      const missed = afterMissedRead(state, error);
      errors.push(missed.log);
      state = missed.state;
    }
    expect(SELF_DM_MISSES).toBe(3);
    expect(errors).toEqual([null, null, "Slack wasn't reachable", null, "ENOTFOUND"]);
    // It reads from the same place next time, and Settings calls it failing only once it's logged.
    expect(state.cursor).toBe(ts(600));
    expect(afterMissedRead(emptySelfDmState(), "x").state.lastError).toBeNull();
    expect(state.lastError).toBe("ENOTFOUND");
  });

  it("reads a state saved before misses were counted", () => {
    expect(parseSelfDmState('{"cursor":"1","tries":1}').misses).toBe(0);
  });

  it("reads a reply that says Slack wasn't reachable", () => {
    expect(SelfDmPoll.parse({ unreachable: "The Slack connector never connected", latest_ts: null, messages: [] }).unreachable).toMatch(/never connected/);
    expect(SelfDmPoll.parse({ latest_ts: null, messages: [] }).unreachable).toBeUndefined();
  });

  it("ticks a message when anything was done, with a line per change, failures included", () => {
    const [r] = selfDmReplies([{ ts: "1", changes: [{ ok: true, line: 'Added "Book venue" to your tasks (id m-123).' }, { ok: false, line: "Couldn't rename it: Unknown project" }], question: null }]);
    expect(r).toEqual({ ts: "1", emoji: "white_check_mark", text: 'Added "Book venue" to your tasks.\nCouldn\'t rename it: Unknown project' });
  });

  it("asks when nothing was done: the question, else what failed, else that it couldn't tell", () => {
    const [asked, failed, unclear] = selfDmReplies([
      { ts: "1", changes: [], question: "Which project do you mean?" },
      { ts: "2", changes: [{ ok: false, line: "Couldn't merge them: Unknown project" }], question: null },
      { ts: "3", changes: [], question: null },
    ]);
    expect(asked).toEqual({ ts: "1", emoji: "question", text: "Which project do you mean?" });
    expect(failed).toEqual({ ts: "2", emoji: "question", text: "Couldn't merge them: Unknown project" });
    expect(unclear.emoji).toBe("question");
    expect(unclear.text).toMatch(/couldn't tell/);
  });

  it("asks for one read after the cursor and nothing but tagged messages", () => {
    const p = selfDmPrompt("U123", "1793000000.000100");
    expect(p).toContain('channel_id "U123"');
    expect(p).toContain('oldest "1793000000.000100"');
    expect(p).toContain("ONLY if its own text contains the tag #demian");
    expect(p).toContain("<#C0123ABCD|demian>: that is the same tag");
    expect(p).toContain("When it forwards another message, include that too");
    // The read only reads: messages are answered separately, once Demian has acted on them.
    expect(p).not.toContain("slack_add_reaction");
    expect(p).not.toContain("slack_send_message");
    expect(p).toContain("call it again with that cursor");
  });

  it("names the one Slack tool it may use, and says to wait for the connector rather than guess", () => {
    const p = selfDmPrompt("U123", "1793000000.000100");
    expect(TOOLS.selfDmRead).toEqual([SELF_DM_READ_TOOL]);
    expect(p).toContain(`Call ${SELF_DM_READ_TOOL} with`);
    expect(p).toContain("never another server's Slack tool");
    expect(p).toContain(`ToolSearch ("select:${SELF_DM_READ_TOOL}")`);
    expect(p).toContain('"unreachable": string|null');
  });

  it("works out the changes with the planner's ids and the same changes as the chat, checking for a task already there", () => {
    const p = selfDmActionsPrompt([msg("1793000000.000100", "Book the venue #demian")], "What my planner shows right now: …");
    expect(p).toContain('"type": "add_task"');
    expect(p).toContain('"type": "add_task_context"');
    expect(p).toContain("What my planner shows right now");
    expect(p).toContain("don't add a second one");
    expect(p).toContain('"ts":"1793000000.000100"');
  });

  it("leaves watching a topic out while Watched topics is off (the default), and has it once it's on", () => {
    const ask = () => selfDmActionsPrompt([msg("1793000000.000100", "Watch for legal's sign-off by Friday #demian")], "What my planner shows right now: …");
    expect(ask()).not.toContain('"type": "watch_topic"');
    expect(ask()).not.toContain("is watch_topic");
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) });
    try {
      setAreaOn("watched", true);
      expect(ask()).toContain('"type": "watch_topic"');
      expect(ask()).toContain("is watch_topic");
      setAreaOn("watched", false);
      expect(ask()).not.toContain('"type": "watch_topic"');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers only in the user's own DM, posting the text as written", () => {
    const p = selfDmReplyPrompt("U123", [{ ts: "1793000000.000100", emoji: "white_check_mark", text: "Added it." }]);
    expect(p).toContain('slack_add_reaction once with channel_id "U123"');
    expect(p).toContain('slack_send_message once with channel_id "U123", thread_ts');
    expect(p).toContain("exactly as written");
    expect(p).toContain("nowhere else");
    expect(p.match(/channel_id "(\w+)"/g)?.every((c) => c === 'channel_id "U123"')).toBe(true);
  });
});

describe("unreadReason", () => {
  it("keeps the first sentence or two of a reply that says in words why the DM wasn't read", () => {
    expect(
      unreadReason("I couldn't read the DM. The Slack read was denied because this session is running in don't-ask mode.\n\nI haven't tried another route."),
    ).toBe("I couldn't read the DM. The Slack read was denied because this session is running in don't-ask mode.");
    expect(unreadReason("The Slack connector timed out")).toBe("The Slack connector timed out");
  });

  it("says so when the reply is empty, and keeps a long one short", () => {
    expect(unreadReason("  ")).toBe("Claude didn't say what it found");
    const long = unreadReason(`${"word ".repeat(80)}end.`);
    expect(long.length).toBe(240);
    expect(long.endsWith("…")).toBe(true);
  });
});
