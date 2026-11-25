import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./db", () => ({}));

import { jiraClient, type Send } from "./jira";
import { changeIssue, commentBody, readEpicChildren, readIssuesByKey, readSprintEpics, upcomingSprint } from "./jiraEpics";

let sites = 0;

/** A Jira that answers each request with `answer` (or 404 when it returns undefined), on a site of its own (fields are kept by site). */
function fakeJira(answer: (method: string, path: string, body: any) => unknown) {
  const sent: { method: string; path: string; body: any }[] = [];
  const send: Send = async (method, path, body) => {
    sent.push({ method, path, body });
    const out = answer(method, path, body);
    if (out instanceof Error) return { status: 400, body: { errorMessages: [out.message] }, retry_after: 0 };
    return out === undefined ? { status: 404, body: { errorMessages: [`No ${method} ${path}`] }, retry_after: 0 } : { status: 200, body: out, retry_after: 0 };
  };
  return { jira: jiraClient(`https://site${++sites}.atlassian.net`, "me@example.com", send), sent };
}

const FIELDS = [
  { id: "customfield_10020", name: "Sprint", schema: { type: "array", custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
  { id: "customfield_10349", name: "Estimate (T-shirt)", schema: { type: "option" } },
  { id: "customfield_10276", name: "T-Shirt Size", schema: { type: "option" } },
];
const status = (key: "done" | "indeterminate" | "new", name: string = key) => ({ name, statusCategory: { key } });
const epicParent = (key: string) => ({ key, fields: { issuetype: { name: "Epic", hierarchyLevel: 1 } } });
const person = (name: string) => ({ displayName: name, avatarUrls: { "48x48": `https://avatars/${name}` } });
const SPRINT_24 = { id: 24, name: "Sprint 24", state: "active", startDate: "2026-11-17T00:00:00.000Z", endDate: "2026-12-01T00:00:00.000Z" };

const empty = { issues: [], isLast: true };

describe("upcomingSprint", () => {
  const s = (id: number, name: string, startDate?: string) => ({ id, name, state: "future", startDate });

  it("takes the future sprint that starts soonest", () => {
    expect(upcomingSprint([s(3, "Sprint 26", "2026-12-15"), s(2, "Sprint 25", "2026-12-01"), s(9, "Backlog")], null)?.id).toBe(2);
  });

  it("goes by number after the sprint under way when none has a start date, never a bucket", () => {
    const future = [s(9, "Ready for refinement"), s(3, "Sprint 26"), s(2, "Sprint 25"), s(1, "Sprint 23")];
    expect(upcomingSprint(future, { id: 7, name: "Sprint 24" })?.id).toBe(2);
    expect(upcomingSprint([s(9, "Backlog")], { id: 7, name: "Sprint 24" })).toBeNull();
  });
});

describe("readSprintEpics", () => {
  const sprintIssues = [
    // Two of epic A-10's, one done and sized M, one in progress sized L; one in no epic; one in epic A-20, sized only in the older field.
    { key: "A-1", fields: { parent: epicParent("A-10"), status: status("done"), statuscategorychangedate: "2026-11-20T10:00:00.000+0000", assignee: person("Ann"), issuetype: { name: "Story" }, customfield_10349: { value: "M" } } },
    { key: "A-2", fields: { parent: epicParent("A-10"), status: status("indeterminate"), assignee: null, issuetype: { name: "Bug" }, customfield_10349: { value: "L" } } },
    { key: "A-3", fields: { status: status("new"), assignee: person("Bo"), issuetype: { name: "Task" }, customfield_10349: { value: "S" } } },
    { key: "A-4", fields: { parent: epicParent("A-20"), status: status("new"), assignee: person("Bo"), issuetype: { name: "Story" }, customfield_10276: { value: "XL" } } },
    // An epic in the sprint itself.
    { key: "A-30", fields: { status: status("new"), issuetype: { name: "Epic", hierarchyLevel: 1 } } },
  ];
  const answer = (_method: string, path: string, body: any) => {
    if (path === "/rest/api/3/field") return FIELDS;
    if (path !== "/rest/api/3/search/jql") return undefined;
    const jql: string = body.jql;
    if (jql.includes("sprint in openSprints() AND sprint not in futureSprints()"))
      return jql.includes("sprint not in (24)") ? empty : { issues: [{ key: "A-1", fields: { customfield_10020: [{ id: 3, name: "Sprint 3", state: "closed" }, SPRINT_24] } }], isLast: true };
    if (jql.endsWith("AND sprint = 24")) return { issues: sprintIssues, isLast: true };
    // What the epics are under, read a level at a time: A-10 is under an initiative, which is under a theme.
    if (jql.startsWith("key in (") && body.fields.length === 1) {
      const keys: string[] = jql.slice("key in (".length, jql.indexOf(")")).split(", ");
      const above: Record<string, object> = {
        "A-1000": { key: "A-1000", fields: { parent: { key: "A-5000", fields: { issuetype: { name: "Theme" }, summary: "Revenue" } } } },
        "A-5000": { key: "A-5000", fields: {} },
      };
      return { issues: keys.flatMap((k) => (above[k] ? [above[k]] : [])), isLast: true };
    }
    if (jql.startsWith("key in ("))
      return {
        issues: [
          {
            key: "A-10",
            fields: {
              summary: "Checkout",
              status: status("indeterminate", "In Progress"),
              duedate: "2026-12-12",
              assignee: person("Cy"),
              parent: { key: "A-1000", fields: { issuetype: { name: "Initiative" }, summary: "Payments" } },
            },
          },
        ],
        isLast: true,
      };
    if (jql.startsWith("parent in (")) {
      // All of A-10's issues: the sprint's two and one more, done and sized S.
      const done = { key: "A-9", fields: { parent: { key: "A-10" }, status: status("done"), customfield_10349: { value: "S" } } };
      return { issues: [done, ...sprintIssues.slice(0, 2).map((i) => ({ key: i.key, fields: { ...i.fields, parent: { key: "A-10" } } })), { key: "A-4", fields: { parent: { key: "A-20" }, status: status("new") } }], isLast: true };
    }
    return undefined;
  };

  it("reads the sprint, its epics with their issues, counts and sizes, and the issues in no epic", async () => {
    const { jira } = fakeJira(answer);
    const read = await readSprintEpics(jira, "A", "current", undefined);
    expect(read.sprint).toEqual({ name: "Sprint 24", start: SPRINT_24.startDate, end: SPRINT_24.endDate });
    // The size field is the one most of the sprint's issues have a size in.
    expect(read.size_field).toBe("customfield_10349");
    const a10 = read.epics.find((e) => e.key === "A-10")!;
    expect(a10).toMatchObject({ title: "Checkout", status: "In Progress", category: "in_progress", due: "2026-12-12", assignee: "Cy", link: `${jira.site}/browse/A-10` });
    expect(a10.issues).toEqual([
      { key: "A-1", category: "done", done_at: "2026-11-20T10:00:00.000+0000", assignee: "Ann", avatar: "https://avatars/Ann", type: "Story", size: "M" },
      { key: "A-2", category: "in_progress", done_at: null, assignee: null, avatar: null, type: "Bug", size: "L" },
    ]);
    expect(a10.progress).toEqual({ done: 2, started: 1, total: 3 });
    // What it's under, from the top down, for its breadcrumb.
    expect(a10.parents).toEqual([
      { key: "A-5000", type: "Theme", title: "Revenue", link: `${jira.site}/browse/A-5000` },
      { key: "A-1000", type: "Initiative", title: "Payments", link: `${jira.site}/browse/A-1000` },
    ]);
    expect(a10.sized?.sort()).toEqual(["L:in_progress", "M:done", "S:done"]);
    // An epic that can't be read keeps its key as its title; an epic in the sprint is listed with no issues.
    expect(read.epics.find((e) => e.key === "A-20")).toMatchObject({ title: "A-20", parents: null, progress: { done: 0, started: 0, total: 1 } });
    expect(read.epics.find((e) => e.key === "A-30")).toMatchObject({ issues: [] });
    expect(read.strays.map((i) => i.key)).toEqual(["A-3"]);
    expect(read.unparented).toBe(1);
  });

  it("reads sizes from the field it's given", async () => {
    const { jira } = fakeJira(answer);
    const read = await readSprintEpics(jira, "A", "current", "customfield_10276");
    expect(read.size_field).toBe("customfield_10276");
    expect(read.epics.find((e) => e.key === "A-20")!.issues[0].size).toBe("XL");
    expect(read.epics.find((e) => e.key === "A-10")!.issues[0].size).toBeNull();
  });

  it("finds no sprint when none is under way", async () => {
    const { jira } = fakeJira((_m, p) => (p === "/rest/api/3/field" ? FIELDS : p === "/rest/api/3/search/jql" ? empty : undefined));
    expect(await readSprintEpics(jira, "A", "current", null)).toMatchObject({ sprint: null, epics: [], strays: [] });
  });

  it("refuses a project key that isn't one", async () => {
    const { jira } = fakeJira(() => undefined);
    await expect(readSprintEpics(jira, "A) OR (1=1", "current", null)).rejects.toThrow(/Not a Jira project key/);
  });
});

describe("readEpicChildren and readIssuesByKey", () => {
  const issue = {
    key: "A-1",
    fields: {
      summary: "Pay",
      status: status("done", "Done"),
      issuetype: { name: "Story" },
      duedate: "2026-12-01",
      assignee: person("Ann"),
      created: "2026-11-01T00:00:00.000+0000",
      statuscategorychangedate: "2026-11-20T00:00:00.000+0000",
      customfield_10349: { value: "XS" },
    },
  };
  const card = {
    key: "A-1",
    title: "Pay",
    status: "Done",
    category: "done",
    type: "Story",
    due: "2026-12-01",
    size: "XS",
    assignee: "Ann",
    avatar: "https://avatars/Ann",
    created: "2026-11-01T00:00:00.000+0000",
    done_at: "2026-11-20T00:00:00.000+0000",
  };

  it("reads an epic's issues, each for its card", async () => {
    const { jira, sent } = fakeJira((_m, p) => (p === "/rest/api/3/search/jql" ? { issues: [issue], isLast: true } : undefined));
    const read = await readEpicChildren(jira, "A-10", "customfield_10349");
    expect(read).toEqual({ issues: [{ ...card, link: `${jira.site}/browse/A-1` }], error: null, size_field: "customfield_10349" });
    expect(sent[0].body.jql).toBe("parent = A-10 ORDER BY status ASC, updated DESC");
  });

  it("reads issues by their keys, leaving out anything that isn't a key", async () => {
    const { jira, sent } = fakeJira((_m, p) => (p === "/rest/api/3/search/jql" ? { issues: [issue], isLast: true } : undefined));
    const read = await readIssuesByKey(jira, ["A-1", "A-1", "nope"], null);
    expect(read.issues[0]).toMatchObject({ key: "A-1", size: null });
    expect(sent[0].body.jql).toBe("key in (A-1) ORDER BY status ASC, updated DESC");
  });

  it("still finds the others when Jira refuses a key that's gone", async () => {
    const keysIn = (jql: string) => jql.slice("key in (".length, jql.indexOf(")")).split(", ");
    const { jira } = fakeJira((_m, p, body) => {
      if (p !== "/rest/api/3/search/jql") return undefined;
      const keys = keysIn(body.jql);
      if (keys.includes("A-3")) return new Error("An issue with key 'A-3' does not exist for field 'key'.");
      return { issues: keys.map((key) => ({ ...issue, key })), isLast: true };
    });
    const read = await readIssuesByKey(jira, ["A-1", "A-2", "A-3", "A-4", "A-5"], null);
    expect(read.issues.map((i) => i.key).sort()).toEqual(["A-1", "A-2", "A-4", "A-5"]);
  });
});

describe("readSprintEpics with an epic Jira won't show", () => {
  it("keeps the other epics' titles and counts, and has none for that one", async () => {
    const keysIn = (jql: string, list: string) => jql.slice(jql.indexOf(list) + list.length, jql.indexOf(")", jql.indexOf(list))).split(", ");
    const { jira } = fakeJira((_m, path, body) => {
      if (path === "/rest/api/3/field") return FIELDS;
      if (path !== "/rest/api/3/search/jql") return undefined;
      const jql: string = body.jql;
      if (jql.includes("sprint in openSprints()")) return jql.includes("sprint not in (24)") ? empty : { issues: [{ key: "A-1", fields: { customfield_10020: [SPRINT_24] } }], isLast: true };
      if (jql.endsWith("AND sprint = 24"))
        return {
          issues: [
            { key: "A-1", fields: { parent: epicParent("A-10"), status: status("new"), assignee: null, issuetype: { name: "Story" } } },
            { key: "A-2", fields: { parent: epicParent("B-9"), status: status("new"), assignee: null, issuetype: { name: "Story" } } },
          ],
          isLast: true,
        };
      const list = jql.startsWith("key in (") ? "key in (" : "parent in (";
      const keys = keysIn(jql, list);
      // B-9 is in a project this account can't see: any search naming it is turned down.
      if (keys.includes("B-9")) return new Error("The issue key 'B-9' for field 'key' is invalid.");
      if (list === "key in (") return { issues: keys.map((key) => ({ key, fields: { summary: `Epic ${key}`, status: status("new") } })), isLast: true };
      return { issues: [{ key: "A-1", fields: { parent: { key: "A-10" }, status: status("new") } }], isLast: true };
    });
    const read = await readSprintEpics(jira, "A", "current", null);
    expect(read.epics.find((e) => e.key === "A-10")).toMatchObject({ title: "Epic A-10", progress: { done: 0, started: 0, total: 1 } });
    expect(read.epics.find((e) => e.key === "B-9")).toMatchObject({ title: "B-9", progress: null, issues: [{ key: "A-2" }] });
  });
});

describe("changeIssue", () => {
  const after = {
    key: "A-1",
    fields: {
      summary: "Pay",
      status: status("indeterminate", "In Progress"),
      issuetype: { name: "Story" },
      assignee: person("Ann"),
      duedate: null,
      parent: null,
      customfield_10020: [{ id: 25, name: "Sprint 25", state: "future" }, { id: 3, name: "Sprint 3", state: "closed" }],
    },
  };

  it("makes each change once and reads the issue before and after", async () => {
    const { jira, sent } = fakeJira((method, path) => {
      if (path === "/rest/api/3/field") return FIELDS;
      if (path.startsWith("/rest/api/3/issue/A-1?fields=status,parent")) return { key: "A-1", fields: { status: status("new"), parent: epicParent("A-10") } };
      if (path === "/rest/api/3/issue/A-1/transitions" && method === "GET") return { transitions: [{ id: "11", to: { name: "To Do" } }, { id: "21", to: { name: "In Progress" } }] };
      if (path === "/rest/api/3/issue/A-1/transitions") return null;
      if (path.startsWith("/rest/api/3/user/assignable/search")) return [{ accountId: "acc-ann", displayName: "Ann" }, { accountId: "acc-anna", displayName: "Anna" }];
      if (path === "/rest/api/3/issue/A-1" && method === "PUT") return null;
      if (path === "/rest/agile/1.0/backlog/issue") return null;
      if (path === "/rest/api/3/issue/A-1/comment") return {};
      if (path.startsWith("/rest/api/3/issue/A-1?fields=summary")) return after;
      return undefined;
    });
    const out = await changeIssue(jira, { key: "a-1", status: "in progress", assignee: "Ann", due: "none", epic: "none", sprint: "Backlog", comment: "Moved back.\n\nSee the thread." });
    expect(out.sent).toBe(true);
    expect(out.changed).toEqual(["status", "assignee", "due", "epic", "sprint", "comment"]);
    expect(out.not_changed).toEqual([]);
    expect(out.before).toEqual({ category: "todo", epic: "A-10" });
    expect(out.issue).toMatchObject({ key: "A-1", status: "In Progress", category: "in_progress", epic: null, sprints: ["Sprint 25"], link: `${jira.site}/browse/A-1` });
    expect(sent.find((s) => s.path === "/rest/api/3/issue/A-1/transitions" && s.method === "POST")!.body).toEqual({ transition: { id: "21" } });
    expect(sent.find((s) => s.method === "PUT")!.body).toEqual({ fields: { assignee: { accountId: "acc-ann" }, duedate: null, parent: null } });
    expect(sent.find((s) => s.path === "/rest/agile/1.0/backlog/issue")!.body).toEqual({ issues: ["A-1"] });
  });

  it("says what it couldn't change and why, and doesn't chain transitions", async () => {
    const { jira, sent } = fakeJira((method, path, body) => {
      if (path === "/rest/api/3/field") return FIELDS;
      if (path === "/rest/api/3/issue/A-1/transitions") return { transitions: [{ id: "11", to: { name: "In Progress" } }] };
      // Together the fields are refused; alone, the priority is.
      if (method === "PUT") return body.fields.priority ? new Error("Priority 'Urgent' doesn't exist") : null;
      if (path.startsWith("/rest/api/3/issue/A-1?fields=")) return after;
      return undefined;
    });
    const out = await changeIssue(jira, { key: "A-1", status: "Done", summary: "Pay faster", priority: "Urgent" });
    expect(out.changed).toEqual(["summary"]);
    expect(out.not_changed).toEqual(["status", "priority"]);
    expect(out.error).toMatch(/can't move to "Done".*In Progress/);
    expect(out.error).toMatch(/Priority 'Urgent' doesn't exist/);
    expect(sent.filter((s) => s.path.endsWith("/transitions") && s.method === "POST")).toHaveLength(0);
  });

  it("moves it into an open sprint by name", async () => {
    const { jira, sent } = fakeJira((_method, path) => {
      if (path === "/rest/api/3/field") return FIELDS;
      if (path === "/rest/api/3/search/jql") return { issues: [{ key: "A-5", fields: { customfield_10020: [{ id: 25, name: "Sprint 25", state: "future" }] } }], isLast: true };
      if (path === "/rest/agile/1.0/sprint/25/issue") return null;
      if (path.startsWith("/rest/api/3/issue/A-1?fields=")) return after;
      return undefined;
    });
    const out = await changeIssue(jira, { key: "A-1", sprint: "sprint 25" });
    expect(out.changed).toEqual(["sprint"]);
    expect(sent.find((s) => s.path === "/rest/api/3/search/jql")!.body.jql).toBe('sprint = "sprint 25"');
  });
});

describe("commentBody", () => {
  it("keeps paragraphs and lines", () => {
    expect(commentBody("One\ntwo\n\nThree")).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "One" }, { type: "hardBreak" }, { type: "text", text: "two" }] },
        { type: "paragraph", content: [{ type: "text", text: "Three" }] },
      ],
    });
  });
});
