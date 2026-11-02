import { describe, expect, it } from "vitest";
import { notesPrompt, setStandingNotes } from "./claude";
import { globalChatPrompt } from "./openInClaude";
import { parseActions, readableMessages, readableReply } from "./sessions";

const block = (body: string) => ({ header: "[orb] action", body });

describe("global chat actions", () => {
  it("reads a proposed change, once, and flags one it can't read", () => {
    const split = '{"type": "split_project", "project_id": "C1", "new_name": "Store assets", "channel_ids": ["C2"]}';
    const actions = parseActions([
      block(split),
      block(split),
      { header: "[orb] send to #x", body: "hi" },
      block("{not json"),
      block('{"type": "launch_rocket"}'),
    ]);
    expect(actions).toHaveLength(3);
    expect(actions[0].action).toMatchObject({ type: "split_project", channel_ids: ["C2"] });
    expect(actions[1].action).toBeNull();
    expect(actions[2].error).toBe("Couldn't read this change");
  });

  it("unwraps a code fence around the JSON", () => {
    const [a] = parseActions([block('```json\n{"type": "add_note", "text": "Refunds is paused"}\n```')]);
    expect(a.action).toEqual({ type: "add_note", text: "Refunds is paused" });
  });

  it("hides action blocks from Claude's message", () => {
    expect(readableReply('Here you go.\n[orb] action\n{"type": "add_note", "text": "a"}\n[orb] end')).toBe("Here you go.");
  });

  it("hides a change block still being written", () => {
    expect(readableReply('I\'d split it off.\n\n[orb] action\n{"type": "split_pro')).toBe("I'd split it off.");
  });

  it("shows the first message as the user wrote it, not the whole opening prompt", () => {
    const prompt = globalChatPrompt("global:1", "Spring launch is two projects");
    const shown = readableMessages([
      { role: "user", text: prompt },
      { role: "assistant", text: "Got it." },
    ]);
    expect(shown[0]).toEqual({ role: "user", text: "Spring launch is two projects" });
  });
});

describe("standing notes", () => {
  it("become a system prompt addition only when there are some", () => {
    setStandingNotes([]);
    expect(notesPrompt()).toBe("");
    setStandingNotes(["Refunds is paused until Q3", "  "]);
    expect(notesPrompt()).toContain("- Refunds is paused until Q3");
    expect(notesPrompt().split("\n- ")).toHaveLength(2);
    setStandingNotes([]);
  });
});
