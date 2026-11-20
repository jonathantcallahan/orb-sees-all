import { describe, expect, it } from "vitest";
import { TDD_OUTLINE, tddDraftPrompt } from "./prompts";
import { TddDraft } from "./schema";

const input = {
  name: "Store credit",
  purpose: "Let sellers offer store credit instead of refunds.",
  context: ["Split off from Gift cards and credit."],
  people: [{ name: "Raj Das", role: "eng" }],
  path: [{ what: "Build the catalog attributes", status: "next", owners: [], track: "Backend" }],
  ship: { what: "Store credit live", date: null },
  epics: [{ key: "PAY-8483", title: "Store Credit UI" }],
  channels: [{ channel_id: "C1", name: "tmp-gift-cards-and-credit" }],
  resources: [{ title: "Merged TDD", link: "https://docs.google.com/document/d/abc" }],
  decisions: [],
};

describe("drafting a TDD", () => {
  it("reads the project's epics, channels, docs and meetings, and follows the team's own TDD when there is one", () => {
    const p = tddDraftPrompt(input);
    expect(p).toContain("parent in (PAY-8483)");
    expect(p).toContain("#tmp-gift-cards-and-credit (C1)");
    expect(p).toContain("Merged TDD: https://docs.google.com/document/d/abc");
    expect(p).toContain("Granola");
    expect(p).toContain("Follow its section headings");
    expect(p).toContain(TDD_OUTLINE.join("; "));
  });

  it("writes only what the sources support, with what isn't decided as open questions", () => {
    const p = tddDraftPrompt(input);
    expect(p).toContain("Never invent APIs, tables, numbers, dates or owners");
    expect(p).toContain('Open question: …');
    expect(p).toContain('"Store credit TDD"');
    expect(p).toContain("don't create the doc yourself, or send, post or change anything anywhere");
  });

  it("drafts a project with no epics or channel from a Slack search", () => {
    const p = tddDraftPrompt({ ...input, epics: [], channels: [] });
    expect(p).toContain("It has no Jira epics linked.");
    expect(p).toContain("search Slack for its name instead");
    expect(p).not.toContain("parent in ()");
  });

  it("reads a draft with or without its sources", () => {
    expect(TddDraft.parse({ title: "T", markdown: "# T" }).sources).toEqual([]);
  });
});

describe("working on a TDD draft in its chat", async () => {
  const { tddChatNote, tddChatPrompt } = await import("./openInClaude");
  const { readableMessages } = await import("./sessions");
  const topic = {
    key: "tddchat:C1",
    name: "Store credit",
    purpose: "Let sellers offer store credit.",
    epics: [{ key: "PAY-8483", title: "Store Credit UI" }],
    channels: [{ channel_id: "C1", name: "tmp-gift-cards-and-credit" }],
    sources: [{ title: "PAY-8483", link: "https://x.atlassian.net/browse/PAY-8483" }],
  };

  it("opens with the project and what the draft drew on, and shows only my first message in the chat", () => {
    const p = tddChatPrompt(topic, "  Add the open questions from the sync  ");
    expect(p.startsWith("Orb task: tddchat:C1\n")).toBe(true);
    expect(p).toContain('Jira epics: PAY-8483 "Store Credit UI"');
    expect(p).toContain("#tmp-gift-cards-and-credit (C1)");
    expect(p).toContain("- PAY-8483: https://x.atlassian.net/browse/PAY-8483");
    expect(readableMessages([{ role: "user", text: p }])).toEqual([{ role: "user", text: "Add the open questions from the sync" }]);
  });

  it("edits only the draft's file, checks facts against the sources, and never creates the doc itself", () => {
    const note = tddChatNote("/w/drafts/C1.md");
    expect(note).toContain("Markdown file /w/drafts/C1.md. It's the only file you may change.");
    expect(note).toContain("Read it again before you edit");
    expect(note).toContain("Never invent APIs");
    expect(note).toContain("Don't create the doc in Drive");
  });

  it("lets the chat read and change the draft's file, and no other", async () => {
    const { draftFileRules } = await import("./jobs");
    expect(draftFileRules("/Users/me/Library/Application Support/com.orb.app/work/drafts/C1.md")).toEqual([
      "Read(//Users/me/Library/Application Support/com.orb.app/work/drafts/C1.md)",
      "Edit(//Users/me/Library/Application Support/com.orb.app/work/drafts/C1.md)",
      "Write(//Users/me/Library/Application Support/com.orb.app/work/drafts/C1.md)",
    ]);
  });
});
