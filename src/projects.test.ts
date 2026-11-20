import { describe, expect, it } from "vitest";
import { activeChannels, newRelatedChannels, planDiscovery, projectPriority, roleParts, type ProjectChannel } from "./projects";
import { discoveryPrompt, projectPrompt } from "./prompts";

const link = (channel_id: string, project_id: string, name: string, role: ProjectChannel["role"] = "primary", origin: ProjectChannel["origin"] = "discovered"): ProjectChannel => ({
  channel_id,
  project_id,
  name,
  role,
  origin,
  reason: null,
});

/** Predictable new ids, in order. */
const ids = () => {
  let n = 0;
  return () => String(++n).padStart(12, "0");
};

describe("planDiscovery", () => {
  it("tracks new #tmp- projects and suggests others", () => {
    const plan = planDiscovery(
      [
        { project_id: null, name: "Refunds", reason: "Refund flow", channels: [{ channel_id: "C1", name: "tmp-refunds", role: "primary" }] },
        { project_id: null, name: "Search v2", reason: "Search rewrite", channels: [{ channel_id: "C2", name: "search-v2", role: "primary" }] },
      ],
      [],
      new Set(),
      [],
      ids(),
    );
    // Each gets an id of Demian's own, not its channel's.
    expect(plan.newProjects).toEqual([
      { id: "p:000000000001", name: "Refunds", tracked: true, reason: "Refund flow" },
      { id: "p:000000000002", name: "Search v2", tracked: false, reason: "Search rewrite" },
    ]);
    expect(plan.links.map((l) => [l.channel_id, l.project_id, l.role])).toEqual([
      ["C1", "p:000000000001", "primary"],
      ["C2", "p:000000000002", "primary"],
    ]);
  });

  it("makes a multi-channel project's #tmp- channel its main one and links the rest", () => {
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
      [],
      ids(),
    );
    expect(plan.newProjects.map((p) => p.id)).toEqual(["p:000000000001"]);
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

  it("reads several people as a group DM", async () => {
    const { slackTarget } = await import("./projects");
    // As a chat wrote it, with the first @ left off.
    expect(slackTarget("U0123ABCD, @U0456EFGH, @W0789IJKL")).toEqual({ kind: "group", ids: ["U0123ABCD", "U0456EFGH", "W0789IJKL"], names: [] });
    expect(slackTarget("<@U0123ABCD>, <@U0456EFGH>")).toEqual({ kind: "group", ids: ["U0123ABCD", "U0456EFGH"], names: [] });
    expect(slackTarget("Ana Lee, Ben Ross and @U0123ABCD")).toEqual({ kind: "group", ids: ["U0123ABCD"], names: ["Ana Lee", "Ben Ross"] });
    expect(slackTarget("group DM with Ana, Ben")).toEqual({ kind: "group", ids: [], names: ["Ana", "Ben"] });
    // Not a list of people.
    expect(slackTarget("q-and-a")).toEqual({ kind: "channel", name: "q-and-a" });
    expect(slackTarget("#refunds, #support").kind).not.toBe("group");
  });

  it("opens the group DM before sending to several people", async () => {
    const { sendToChannelPrompt } = await import("./prompts");
    const ids = sendToChannelPrompt("U0123ABCD, @U0456EFGH", "Hi");
    expect(ids).toContain("slack_create_conversation");
    expect(ids).toContain('"U0123ABCD", "U0456EFGH"');
    expect(ids).not.toContain("slack_search_users");
    expect(ids).toContain("slack_send_message exactly once");
    const named = sendToChannelPrompt("Ana Lee, @U0456EFGH", "Hi");
    expect(named).toContain('slack_search_users for "Ana Lee"');
    expect(named).toContain("and the ones you found");
  });
});

describe("a project's priority", () => {
  const snapshot = { priority: { level: "P2", reason: "Planned work" } } as never;

  it("is the one you set, else the refresh's, else none", () => {
    expect(projectPriority({ snapshot, priority_choice: null })).toEqual({ level: "P2", reason: "Planned work", byYou: false });
    expect(projectPriority({ snapshot, priority_choice: { level: "P0", at: "2026-11-19T00:00:00Z" } })).toEqual({ level: "P0", reason: null, byYou: true });
    expect(projectPriority({ snapshot: null, priority_choice: null })).toBeNull();
  });

  it("is passed to the refresh when you set it", () => {
    const ask = (prioritySetByUser: string | null) =>
      projectPrompt({ channels: [{ channel_id: "C1", name: "tmp-refunds" }], userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date(2026, 9, 30), prioritySetByUser });
    expect(ask("P0")).toContain('The user set it to "P0": return that');
    expect(ask(null)).not.toContain("The user set it to");
  });
});

describe("a person's role", () => {
  it("is their title, with anything said after it apart", () => {
    expect(roleParts("eng, 6 issues in PAY-123")).toEqual({ title: "eng", detail: "6 issues in PAY-123" });
    expect(roleParts("PM (payments)")).toEqual({ title: "PM", detail: "payments" });
    expect(roleParts("Engineer - backend")).toEqual({ title: "Engineer", detail: "backend" });
    expect(roleParts("Eng lead")).toEqual({ title: "Eng lead", detail: null });
    expect(roleParts("Co-owner")).toEqual({ title: "Co-owner", detail: null });
    expect(roleParts("")).toEqual({ title: "", detail: null });
  });
});
