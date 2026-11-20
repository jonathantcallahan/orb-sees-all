import { describe, expect, it } from "vitest";
import { parseMarkdown, pieceKeys, tableCells } from "./markdown";

const doc = `> **Draft.** Demian wrote this.

# [TDD] Notifications

## Overview

The shop's receipts were never
migrated ([PAY-1](https://x.atlassian.net/browse/PAY-1)).

**Done means:**
- Users pick an in-app channel.
- Marketing email:
  - is gated on opt-in
  - goes through Postbox
1. First
2. Second

| Term | Meaning |
| --- | --- |
| RNS | Receipt Notification \\| Service |

---

\`\`\`
code here
\`\`\``;

describe("reading a Markdown doc", () => {
  it("reads headings, quotes, paragraphs (joining wrapped lines), nested lists, tables, rules and code", () => {
    const blocks = parseMarkdown(doc);
    expect(blocks.map((b) => b.kind)).toEqual(["quote", "heading", "heading", "para", "para", "list", "list", "table", "rule", "code"]);
    expect(blocks[1]).toEqual({ kind: "heading", level: 1, text: "[TDD] Notifications" });
    expect(blocks[3]).toEqual({ kind: "para", text: "The shop's receipts were never migrated ([PAY-1](https://x.atlassian.net/browse/PAY-1))." });
    const list = blocks[5];
    if (list.kind !== "list") throw new Error("not a list");
    expect(list.ordered).toBe(false);
    expect(list.items.map((i) => i.text)).toEqual(["Users pick an in-app channel.", "Marketing email:"]);
    const nested = list.items[1].children[0];
    expect(nested.kind === "list" && nested.items.map((i) => i.text)).toEqual(["is gated on opt-in", "goes through Postbox"]);
    const ordered = blocks[6];
    expect(ordered.kind === "list" && ordered.ordered && ordered.items.length).toBe(2);
    expect(blocks[7]).toEqual({ kind: "table", head: ["Term", "Meaning"], rows: [["RNS", "Receipt Notification | Service"]] });
    expect(blocks[9]).toEqual({ kind: "code", text: "code here" });
  });

  it("keeps a list going over blank lines between its items, and carries an indented line on its item", () => {
    const blocks = parseMarkdown("- one\n\n- two\n  still two\n\nAfter.");
    expect(blocks).toEqual([
      { kind: "list", ordered: false, start: 1, items: [{ text: "one", children: [] }, { text: "two still two", children: [] }] },
      { kind: "para", text: "After." },
    ]);
  });

  it("splits a table row into cells", () => {
    expect(tableCells("| a | b \\| c |")).toEqual(["a", "b | c"]);
  });

  it("tells which pieces a change touched: an edited item, a new row, a new paragraph", () => {
    const before = pieceKeys(doc);
    const after = doc.replace("goes through Postbox", "goes through the Postbox API").replace("| RNS |", "| Relay | The platform |\n| RNS |") + "\n\nOpen question: who owns it?";
    const changed = [...pieceKeys(after)].filter((k) => !before.has(k));
    expect(changed).toEqual(["li:goes through the Postbox API", "tr:Relay|The platform", "para:Open question: who owns it?"]);
  });
});
