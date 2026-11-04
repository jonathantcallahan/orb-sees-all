import { describe, expect, it } from "vitest";
import { emptySelfDmState, SELF_DM_DEFAULT, selfDmEvery, selfDmOldest, selfDmReplies, takeFromPoll } from "./selfDm";
import { selfDmActionsPrompt, selfDmPrompt, selfDmReplyPrompt } from "./prompts";

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
    const { state } = takeFromPoll({ ...emptySelfDmState(), tries: 2 }, { latest_ts: ts(5), messages: [] }, ts(600), now);
    expect(state.tries).toBe(0);
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
    // The read only reads: messages are answered separately, once Demian has acted on them.
    expect(p).not.toContain("slack_add_reaction");
    expect(p).not.toContain("slack_send_message");
    expect(p).toContain("call it again with that cursor");
  });

  it("works out the changes with the planner's ids and the same changes as the chat, checking for a task already there", () => {
    const p = selfDmActionsPrompt([msg("1793000000.000100", "Book the venue #demian")], "What my planner shows right now: …");
    expect(p).toContain('"type": "add_task"');
    expect(p).toContain('"type": "watch_topic"');
    expect(p).toContain('"type": "add_task_context"');
    expect(p).toContain("What my planner shows right now");
    expect(p).toContain("don't add a second one");
    expect(p).toContain('"ts":"1793000000.000100"');
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
