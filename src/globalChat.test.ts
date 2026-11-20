import { describe, expect, it } from "vitest";
import { notesPrompt, setStandingNotes } from "./claude";
import { actionDocsVersion, globalActionDocs, globalChatPrompt, hasOldActionDocs, updatedActionDocs } from "./openInClaude";
import { changedParts, currentSends, parseActions, readableMessages, readableReply, rememberedLessons, sentHashes, turnNote, unsentMessages, withoutOrbNotes } from "./sessions";

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

describe("handed-off messages", () => {
  const send = (to: string, body: string) => ({ header: `[orb] send to ${to}`, body });
  it("drops drafts from before the plan changed", () => {
    const sends = currentSends([send("#a", "old draft"), { header: "[orb] plan", body: "1. New step" }, send("#b", "new draft")]);
    expect(sends.map((s) => s.text)).toEqual(["new draft"]);
  });
  it("keeps only the latest draft for a destination, and none set aside", () => {
    const sends = currentSends([send("#a", "first"), send("#a", "second"), send("#b", "other")]);
    const open = unsentMessages(sends, { startedAt: 0, dismissedKeys: [sends[2].key] });
    expect(open.map((s) => s.text)).toEqual(["second"]);
  });
});

describe("remembered preferences", () => {
  it("reads a session's [orb] remember lines as scoped lessons", () => {
    expect(
      rememberedLessons([
        "[orb] step 2 done",
        "[orb] remember plans: Don't add tasks for hypothetical future work",
        "[orb] remember: Keep plans short",
      ]),
    ).toEqual([
      { scope: "plans", text: "Don't add tasks for hypothetical future work" },
      { scope: "plans", text: "Keep plans short" },
    ]);
  });
});

describe("one list of changes for the chat and #demian messages", () => {
  it("documents every change the planner can apply, the new ones included", async () => {
    const { globalActionDocs } = await import("./openInClaude");
    const { GlobalAction } = await import("./schema");
    const types = GlobalAction.options.map((o) => o.shape.type.value);
    expect(types).toContain("watch_topic");
    expect(types).toContain("add_task_context");
    // With Watched topics on, every change; off (the default), all but watching a topic.
    for (const t of types) expect(globalActionDocs(true)).toContain(`"type": "${t}"`);
    for (const t of types.filter((t) => t !== "watch_topic")) expect(globalActionDocs(false)).toContain(`"type": "${t}"`);
    expect(globalActionDocs(false)).not.toContain('"type": "watch_topic"');
    expect(globalChatPrompt("global:x", "hi")).toContain(globalActionDocs());
  });

  it("changes existing tasks rather than adding more, and finds them by title when it has to", async () => {
    const { GLOBAL_TASK_RULES } = await import("./openInClaude");
    const { GlobalAction } = await import("./schema");
    expect(globalChatPrompt("global:x", "hi")).toContain(GLOBAL_TASK_RULES);
    expect(GLOBAL_TASK_RULES).toMatch(/Never ask me whether I applied a card/);
    expect(GLOBAL_TASK_RULES).toMatch(/don't write \[orb\] plan or \[orb\] step lines here/);
    expect(GlobalAction.safeParse({ type: "set_task_status", title: "Get the URL", status: "blocked" }).success).toBe(true);
    expect(GlobalAction.safeParse({ type: "update_task", task_id: "manual:1", title: "Get the URL", new_title: "Check the account settings" }).success).toBe(true);
    expect(GlobalAction.safeParse({ type: "set_task_plan", task_id: "manual:1", steps: [{ title: "Ask Sam", by: "claude" }] }).success).toBe(true);
    expect(GlobalAction.safeParse({ type: "set_task_plan", task_id: "manual:1", steps: [] }).success).toBe(false);
    expect(GlobalAction.safeParse({ type: "set_task_project", task_id: "slack:3", title: "Review the spec", project_id: "C1" }).success).toBe(true);
    // Moving a task means changing it, never copying it or pointing at another one.
    expect(GLOBAL_TASK_RULES).toMatch(/trust what I say about it/);
    expect(GLOBAL_TASK_RULES).toMatch(/Only mark a task done when I've said it's done/);
  });

  it("reads the new changes", async () => {
    const { GlobalAction } = await import("./schema");
    expect(GlobalAction.safeParse({ type: "watch_topic", text: "Legal sign-off by Friday" }).success).toBe(true);
    expect(GlobalAction.safeParse({ type: "add_task_context", task_id: "m1", text: "Ana prefers Thursday" }).success).toBe(true);
    expect(GlobalAction.safeParse({ type: "add_task_context", task_id: "m1", text: "" }).success).toBe(false);
  });
});

describe("a chat begun with an older list of changes", () => {
  it("is given the current list", () => {
    expect(hasOldActionDocs(undefined)).toBe(true);
    expect(hasOldActionDocs({})).toBe(true);
    expect(hasOldActionDocs({ openedDocs: "older" })).toBe(true);
    expect(hasOldActionDocs({ openedDocs: actionDocsVersion() })).toBe(false);
  });

  it("is told the list replaces what it said before about what can't be done", () => {
    const docs = updatedActionDocs();
    expect(docs).toContain(globalActionDocs());
    expect(docs).toMatch(/replaces the one in the chat's first message/);
    expect(docs).toMatch(/anything said earlier in this chat/);
  });
});

describe("what a resumed chat is told with each turn", () => {
  const parts = [
    { key: "notes", text: "Standing notes" },
    { key: "docs", text: "" },
    { key: "planner", text: "Projects: Gift cards" },
  ];

  it("is everything, for a chat that never noted what it was told", () => {
    // A chat begun before this was kept, like one that ran for weeks on its first system prompt.
    expect(changedParts(parts, undefined).map((p) => p.key)).toEqual(["notes", "planner"]);
  });

  it("is only what changed since the last turn", () => {
    const sent = sentHashes(parts);
    expect(changedParts(parts, sent)).toEqual([]);
    const later = parts.map((p) => (p.key === "planner" ? { ...p, text: "Projects: Gift cards, Store credit" } : p));
    expect(changedParts(later, sent).map((p) => p.key)).toEqual(["planner"]);
    // A part that comes back after a turn without it is told again.
    const back = sentHashes(parts.filter((p) => p.key !== "notes"));
    expect(changedParts(parts, back).map((p) => p.key)).toEqual(["notes"]);
  });

  it("goes under the user's message as a note the chat doesn't show", () => {
    const note = turnNote(changedParts(parts, undefined));
    expect(note).toContain("Projects: Gift cards");
    expect(note).toMatch(/go by this one/);
    const message = ["Split gift cards and store credit", note].join("\n\n");
    expect(withoutOrbNotes(message)).toBe("Split gift cards and store credit");
    expect(turnNote([])).toBe("");
  });
});
