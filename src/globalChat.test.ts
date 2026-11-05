import { describe, expect, it } from "vitest";
import { notesPrompt, setStandingNotes } from "./claude";
import { globalChatPrompt } from "./openInClaude";
import { currentSends, parseActions, readableMessages, readableReply, rememberedLessons, unsentMessages } from "./sessions";

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
    const { GLOBAL_ACTION_DOCS } = await import("./openInClaude");
    const { GlobalAction } = await import("./schema");
    const types = GlobalAction.options.map((o) => o.shape.type.value);
    expect(types).toContain("watch_topic");
    expect(types).toContain("add_task_context");
    for (const t of types) expect(GLOBAL_ACTION_DOCS).toContain(`"type": "${t}"`);
    expect(globalChatPrompt("global:x", "hi")).toContain(GLOBAL_ACTION_DOCS);
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
