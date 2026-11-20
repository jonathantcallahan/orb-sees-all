import { describe, expect, it } from "vitest";
import { answerAsk, askInChat, asksFor, askSummary, clearAsks, dropAsk, noAutoMode, setNoAutoMode } from "./chatAsks";
import type { ChatAsk } from "./claude";

const ask = (id: string, rules: string[] = [], extra: Partial<ChatAsk> = {}): ChatAsk => ({ id, tool: "Bash", input: { command: `echo ${id}` }, rules, ...extra });

describe("asks waiting in a chat", () => {
  it("shows each ask until it's answered, and hands the answer back", async () => {
    const answer = askInChat("t1", ask("a"));
    const shown = asksFor("t1");
    expect(shown.map((a) => a.id)).toEqual(["a"]);
    // The same list until something changes, as React's store hook needs.
    expect(asksFor("t1")).toBe(shown);
    answerAsk("t1", "a", "allow");
    expect(await answer).toBe("allow");
    expect(asksFor("t1")).toEqual([]);
  });

  it("allows the chat's other asks that an Always covers, and leaves the rest", async () => {
    const first = askInChat("t2", ask("a", ["Bash(git status:*)"]));
    const same = askInChat("t2", ask("b", ["Bash(git status:*)"]));
    const other = askInChat("t2", ask("c", ["Bash(rm -rf build)"]));
    answerAsk("t2", "a", "always");
    expect(await first).toBe("always");
    expect(await same).toBe("allow");
    expect(asksFor("t2").map((a) => a.id)).toEqual(["c"]);
    answerAsk("t2", "c", "deny");
    expect(await other).toBe("deny");
  });

  it("refuses and clears what's still waiting when the turn stops, or an ask is withdrawn", async () => {
    const one = askInChat("t3", ask("a"));
    const two = askInChat("t3", ask("b"));
    dropAsk("t3", "a");
    expect(await one).toBe("deny");
    expect(asksFor("t3").map((a) => a.id)).toEqual(["b"]);
    clearAsks("t3");
    expect(await two).toBe("deny");
    expect(asksFor("t3")).toEqual([]);
  });

  it("notes a turn running without auto mode, until it's done", () => {
    setNoAutoMode("t4", true);
    expect(noAutoMode("t4")).toBe(true);
    setNoAutoMode("t4", false);
    expect(noAutoMode("t4")).toBe(false);
  });

  it("says what Claude wants to do: a command in full, a file, a connector by name", () => {
    expect(askSummary(ask("a", [], { description: "List apps", input: { command: "ls /Applications" } }))).toEqual({
      eyebrow: "Claude wants to run a command",
      title: "List apps",
      code: "ls /Applications",
    });
    expect(askSummary(ask("b", [], { tool: "Edit", input: { file_path: "/repo/a.ts" } })).title).toBe("/repo/a.ts");
    expect(askSummary(ask("c", [], { tool: "mcp__claude_ai_Google_Drive__search_files", input: { query: "plan" } }))).toMatchObject({
      eyebrow: "Claude wants to use Google Drive",
      title: "search files",
    });
  });
});
