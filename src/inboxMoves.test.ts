import { describe, expect, it } from "vitest";
import { inboxItemFromUpdate, withMovedUpdates } from "./inboxMoves";
import type { QuickReply } from "./schema";

describe("an update moved to the inbox", () => {
  it("keeps the update's key, so it leaves Updates, and reads as from its project", () => {
    const item = inboxItemFromUpdate({
      key: "update:https://acme.slack.com/archives/C1/p1",
      label: "Checkout",
      text: "Sam asked whether the launch moves to Friday",
      link: "https://acme.slack.com/archives/C1/p1",
      date: "2026-11-09T15:00:00Z",
    });
    expect(item).toEqual({
      id: "update:https://acme.slack.com/archives/C1/p1",
      source: "slack",
      from: "Checkout",
      summary: "Sam asked whether the launch moves to Friday",
      where: null,
      received: "2026-11-09T15:00:00Z",
      link: "https://acme.slack.com/archives/C1/p1",
    });
  });

  it("is an email when the news came from email", () => {
    expect(inboxItemFromUpdate({ key: "update:n1", label: "Email: Q4 plan", text: "Plan is out" }).source).toBe("email");
    expect(inboxItemFromUpdate({ key: "update:n2", label: "News", text: "x", link: "https://mail.google.com/mail/u/0/#inbox/abc" }).source).toBe("email");
    expect(inboxItemFromUpdate({ key: "update:n3", label: "#general", text: "x" }).source).toBe("slack");
  });

  it("joins the refresh's inbox once, after what the refresh found", () => {
    const reply = (id: string): QuickReply => ({ id, source: "slack", from: "Sam", summary: id });
    const merged = withMovedUpdates([reply("a"), reply("update:b")], [reply("update:b"), reply("update:c")]);
    expect(merged.map((r) => r.id)).toEqual(["a", "update:b", "update:c"]);
  });
});
