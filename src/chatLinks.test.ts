import { describe, expect, it } from "vitest";
import { chatPieces } from "./chatLinks";

describe("chat text with links", () => {
  it("leaves text without links as words, markdown marks dropped", () => {
    expect(chatPieces("This is **done**, see `the log`.")).toEqual([{ text: "This is done, see the log." }]);
  });

  it("makes a bare url a link, without the stop or bracket after it", () => {
    expect(chatPieces("The ticket: https://jira.example.com/browse/PAY-1.")).toEqual([
      { text: "The ticket: " },
      { text: "https://jira.example.com/browse/PAY-1", href: "https://jira.example.com/browse/PAY-1" },
      { text: "." },
    ]);
    expect(chatPieces("(https://example.com/a), and")).toEqual([
      { text: "(" },
      { text: "https://example.com/a", href: "https://example.com/a" },
      { text: "), and" },
    ]);
  });

  it("keeps brackets that belong to the url, and its underscores and stars", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(chatPieces(`See ${url} for more`)).toEqual([{ text: "See " }, { text: url, href: url }, { text: " for more" }]);
    const slack = "https://example.slack.com/archives/C0/p17?thread_ts=17.1&cid=C0";
    expect(chatPieces(`**${slack}**`)).toEqual([{ text: slack, href: slack }]);
    const snake = "https://example.com/_a_/b";
    expect(chatPieces(snake)).toEqual([{ text: snake, href: snake }]);
  });

  it("shows a Markdown link by its words", () => {
    expect(chatPieces("PR is up: [#6364](https://github.com/o/r/pull/6364) now")).toEqual([
      { text: "PR is up: " },
      { text: "#6364", href: "https://github.com/o/r/pull/6364" },
      { text: " now" },
    ]);
    expect(chatPieces("[**the doc**](https://docs.google.com/document/d/1) and [Wiki](https://en.wikipedia.org/wiki/A_(b))")).toEqual([
      { text: "the doc", href: "https://docs.google.com/document/d/1" },
      { text: " and " },
      { text: "Wiki", href: "https://en.wikipedia.org/wiki/A_(b)" },
    ]);
  });

  it("shows a link to a file by its name, with the path to hover", () => {
    expect(chatPieces("Defined in [flags.ts:6](apps/web/src/[locale]/flags.ts:6).")).toEqual([
      { text: "Defined in " },
      { text: "flags.ts:6", title: "apps/web/src/[locale]/flags.ts:6" },
      { text: "." },
    ]);
  });

  it("reads Slack's <url|words> and <url>, and mail links", () => {
    expect(chatPieces("<https://example.com/x|the thread> or <https://example.com/y>")).toEqual([
      { text: "the thread", href: "https://example.com/x" },
      { text: " or " },
      { text: "https://example.com/y", href: "https://example.com/y" },
    ]);
    expect(chatPieces("[Email me](mailto:a@example.com)")).toEqual([{ text: "Email me", href: "mailto:a@example.com" }]);
  });

  it("doesn't link other schemes", () => {
    expect(chatPieces("[run](javascript:alert(1)) [app](claude://x)")).toEqual([
      { text: "run", title: "javascript:alert(1)" },
      { text: " " },
      { text: "app", title: "claude://x" },
    ]);
  });

  it("keeps what the user typed as it is, with its links", () => {
    expect(chatPieces("check *this* https://example.com/a_b_", false)).toEqual([
      { text: "check *this* " },
      { text: "https://example.com/a_b", href: "https://example.com/a_b" },
      { text: "_" },
    ]);
  });
});
