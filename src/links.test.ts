import { describe, expect, it } from "vitest";
import { collectLinks, fallbackTitle, linkKind } from "./links";

describe("links", () => {
  it("knows each product from its URL", () => {
    expect(linkKind("https://unity.slack.com/archives/C1/p123")).toBe("slack");
    expect(linkKind("https://mail.google.com/mail/u/0/#all/abc")).toBe("gmail");
    expect(linkKind("https://docs.google.com/document/d/1/edit")).toBe("docs");
    expect(linkKind("https://docs.google.com/spreadsheets/d/1")).toBe("sheets");
    expect(linkKind("https://docs.google.com/presentation/d/1")).toBe("slides");
    expect(linkKind("https://drive.google.com/file/d/1")).toBe("drive");
    expect(linkKind("https://unity3d.atlassian.net/browse/CPS-6931")).toBe("jira");
    expect(linkKind("https://unity3d.atlassian.net/wiki/spaces/X/pages/1")).toBe("confluence");
    expect(linkKind("https://github.com/o/r/pull/7")).toBe("github");
    expect(linkKind("https://example.com/x")).toBe("web");
    expect(linkKind("not a url")).toBe("web");
  });

  it("names untitled links", () => {
    expect(fallbackTitle("https://unity3d.atlassian.net/browse/CPS-6931")).toBe("CPS-6931");
    expect(fallbackTitle("https://github.com/o/repo/pull/7")).toBe("repo#7");
    expect(fallbackTitle("https://www.example.com/x")).toBe("example.com");
    expect(fallbackTitle("https://unity.slack.com/archives/C1/p1")).toBe("Slack thread");
  });

  it("puts the source first, dedupes, and keeps a given title", () => {
    const links = collectLinks(
      [
        { url: "https://unity.slack.com/archives/C1/p1" },
        { url: "https://unity3d.atlassian.net/browse/CPS-1", title: "Export ticket" },
        { url: "https://unity.slack.com/archives/C1/p1", title: "Ben's ask" },
        { url: null },
      ],
      ["See https://unity3d.atlassian.net/browse/CPS-1, and https://docs.google.com/document/d/9/edit."],
    );
    expect(links.map((l) => l.url)).toEqual([
      "https://unity.slack.com/archives/C1/p1",
      "https://unity3d.atlassian.net/browse/CPS-1",
      "https://docs.google.com/document/d/9/edit",
    ]);
    expect(links[0].title).toBe("Ben's ask");
    expect(links[1].title).toBe("Export ticket");
    expect(links[2].title).toBe("Doc");
  });
});

describe("link titles", () => {
  it("replaces titles that only name a channel or URL", () => {
    const links = collectLinks([
      { url: "https://unity.slack.com/archives/C1/p1", title: "#tmp-asset-pricing" },
      { url: "https://unity.slack.com/archives/C1/p2", title: "tmp-asset-pricing" },
      { url: "https://unity.slack.com/archives/C1/p3", title: "https://unity.slack.com/archives/C1/p3" },
      { url: "https://unity.slack.com/archives/C1/p4", title: "Pricing decision thread" },
    ]);
    expect(links.map((l) => l.title)).toEqual(["Slack thread", "Slack thread", "Slack thread", "Pricing decision thread"]);
  });
});

describe("withoutChannels", () => {
  it("drops channel names from titles", async () => {
    const { withoutChannels } = await import("./links");
    expect(withoutChannels("Pricing thread in #tmp-asset-pricing")).toBe("Pricing thread");
    expect(withoutChannels("#asset-store-eng: launch date")).toBe("launch date");
    expect(withoutChannels("Ben's ask on #general")).toBe("Ben's ask");
    expect(withoutChannels("CPS-6931 export ticket")).toBe("CPS-6931 export ticket");
    expect(collectLinks([{ url: "https://unity.slack.com/archives/C1/p1", title: "#tmp-asset-pricing" }])[0].title).toBe("Slack thread");
  });
});
