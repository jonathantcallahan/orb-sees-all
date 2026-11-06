import { describe, expect, it } from "vitest";
import { activeChannels, newRelatedChannels, planDiscovery, type ProjectChannel } from "./projects";
import { discoveryPrompt, projectPrompt } from "./prompts";

const link = (channel_id: string, project_id: string, name: string, role: ProjectChannel["role"] = "primary", origin: ProjectChannel["origin"] = "discovered"): ProjectChannel => ({
  channel_id,
  project_id,
  name,
  role,
  origin,
  reason: null,
});

describe("planDiscovery", () => {
  it("tracks new #tmp- projects and suggests others", () => {
    const plan = planDiscovery(
      [
        { project_id: null, name: "Refunds", reason: "Refund flow", channels: [{ channel_id: "C1", name: "tmp-refunds", role: "primary" }] },
        { project_id: null, name: "Search v2", reason: "Search rewrite", channels: [{ channel_id: "C2", name: "search-v2", role: "primary" }] },
      ],
      [],
      new Set(),
    );
    expect(plan.newProjects).toEqual([
      { id: "C1", name: "tmp-refunds", tracked: true, reason: "Refund flow" },
      { id: "C2", name: "search-v2", tracked: false, reason: "Search rewrite" },
    ]);
    expect(plan.links.map((l) => [l.channel_id, l.project_id, l.role])).toEqual([
      ["C1", "C1", "primary"],
      ["C2", "C2", "primary"],
    ]);
  });

  it("keys a multi-channel project by its #tmp- channel and links the rest", () => {
    const plan = planDiscovery(
      [
        {
          project_id: null,
          name: "Refunds",
          reason: "r",
          channels: [
            { channel_id: "C9", name: "refunds-eng", role: "primary" },
            { channel_id: "C1", name: "tmp-refunds", role: "related" },
          ],
        },
      ],
      [],
      new Set(),
    );
    expect(plan.newProjects.map((p) => p.id)).toEqual(["C1"]);
    expect(plan.links.map((l) => [l.channel_id, l.role])).toEqual([
      ["C1", "primary"],
      ["C9", "related"],
    ]);
  });

  it("adds new channels to the existing project and leaves known links alone", () => {
    const known = [link("C1", "C1", "tmp-refunds"), link("C5", "C4", "pricing", "related")];
    const plan = planDiscovery(
      [
        {
          project_id: null,
          name: "Refunds",
          reason: "r",
          channels: [
            { channel_id: "C1", name: "tmp-refunds-v2", role: "primary" },
            { channel_id: "C5", name: "pricing", role: "related" },
            { channel_id: "C6", name: "refunds-legal", role: "related" },
          ],
        },
      ],
      known,
      new Set(["C1", "C4"]),
    );
    expect(plan.newProjects).toEqual([]);
    expect(plan.links.map((l) => [l.channel_id, l.project_id, l.role])).toEqual([["C6", "C1", "related"]]);
    expect(plan.renames).toEqual([{ channel_id: "C1", name: "tmp-refunds-v2" }]);
  });

  it("skips channels the user unlinked", () => {
    const plan = planDiscovery(
      [{ project_id: "C1", name: "Refunds", reason: "r", channels: [{ channel_id: "C7", name: "refunds-chat", role: "related" }] }],
      [link("C1", "C1", "tmp-refunds"), link("C7", "C1", "refunds-chat", "excluded", "user")],
      new Set(["C1"]),
    );
    expect(plan.links).toEqual([]);
  });
});

describe("project channels", () => {
  it("lists linked channels primary first, without unlinked ones", () => {
    const channels = [link("C2", "C1", "refunds-eng", "related"), link("C1", "C1", "tmp-refunds"), link("C3", "C1", "x", "excluded", "user")];
    expect(activeChannels({ channels }).map((c) => c.channel_id)).toEqual(["C1", "C2"]);
  });

  it("keeps only related channels no project has yet", () => {
    const found = [
      { channel_id: "C2", name: "a", reason: "" },
      { channel_id: "C3", name: "b", reason: "" },
      { channel_id: "C3", name: "b", reason: "" },
    ];
    expect(newRelatedChannels(found, [link("C2", "C9", "a", "excluded", "user")]).map((c) => c.channel_id)).toEqual(["C3"]);
  });
});

describe("project prompts", () => {
  it("read every linked channel and carry the profile forward", () => {
    const text = projectPrompt({
      channels: [
        { channel_id: "C1", name: "tmp-refunds" },
        { channel_id: "C2", name: "refunds-eng" },
      ],
      userId: "U1",
      previous: null,
      profile: { goal: "Ship refunds", context: [], aliases: ["RFD"], people: [], resources: [], milestones: [], decisions: [] },
      lastRefreshedAt: null,
      repoState: null,
      now: new Date(2026, 9, 30),
    });
    expect(text).toContain("#tmp-refunds (C1), #refunds-eng (C2)");
    expect(text).toContain('"goal":"Ship refunds"');
    expect(text).toContain('the query "RFD" -in:<#C1> -in:<#C2> after:');
  });

  it("discovery passes known projects and skipped channels", () => {
    const text = discoveryPrompt({ known: [{ project_id: "C1", name: "Refunds", aliases: [], channels: ["tmp-refunds"] }], skip: ["random-chat"] });
    expect(text).toContain('"project_id":"C1"');
    expect(text).toContain('["random-chat"]');
  });
});

describe("send targets", () => {
  it("tells threads, IDs, channels and people apart", async () => {
    const { slackTarget } = await import("./projects");
    expect(slackTarget("https://x.slack.com/archives/C1/p1700000000000100")).toEqual({ kind: "thread", channelId: "C1", threadTs: "1700000000.000100" });
    expect(slackTarget("C0123ABCD")).toEqual({ kind: "conversation", id: "C0123ABCD" });
    expect(slackTarget("D0123ABCD")).toEqual({ kind: "conversation", id: "D0123ABCD" });
    expect(slackTarget("@U0123ABCD")).toEqual({ kind: "user", id: "U0123ABCD" });
    expect(slackTarget("<@U0123ABCD>")).toEqual({ kind: "user", id: "U0123ABCD" });
    expect(slackTarget("U0123ABCD")).toEqual({ kind: "user", id: "U0123ABCD" });
    expect(slackTarget("#refunds")).toEqual({ kind: "channel", name: "refunds" });
    expect(slackTarget("tmp-asset-library-plugin")).toEqual({ kind: "channel", name: "tmp-asset-library-plugin" });
    expect(slackTarget("Ana Lee")).toEqual({ kind: "person", name: "Ana Lee" });
    expect(slackTarget("@Ana Lee")).toEqual({ kind: "person", name: "Ana Lee" });
    expect(slackTarget("@ezhao")).toEqual({ kind: "person", name: "ezhao" });
    // The whole string the chat once wrote, if it ever arrives unsplit.
    expect(slackTarget("Ana Lee (DM with Ana Lee)")).toEqual({ kind: "person", name: "Ana Lee (DM with Ana Lee)" });
    expect(slackTarget("DM with Ana Lee")).toEqual({ kind: "person", name: "Ana Lee" });
  });

  it("looks a person up before sending them a DM, and never passes a name as a channel ID", async () => {
    const { sendToChannelPrompt } = await import("./prompts");
    const person = sendToChannelPrompt("Ana Lee", "Here's the sheet");
    expect(person).toContain('slack_search_users for "Ana Lee"');
    expect(person).toContain("don't post");
    expect(person).not.toContain('channel_id "Ana Lee"');
    expect(sendToChannelPrompt("@U0123ABCD", "Hi")).toContain('"U0123ABCD" as the channel_id');
    expect(sendToChannelPrompt("C0123ABCD", "Hi")).toContain('channel_id "C0123ABCD"');
    expect(sendToChannelPrompt("#refunds", "Hi")).toContain("slack_search_channels");
    expect(sendToChannelPrompt("#refunds", "Hi")).toContain("<<<MESSAGE\nHi\nMESSAGE>>>");
  });
});
