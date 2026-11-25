import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./db", () => ({}));

import {
  categoryOf,
  epicOf,
  fieldText,
  jiraClient,
  JiraError,
  jiraMessage,
  jqlString,
  searchIssues,
  siteOrigin,
  sizeFieldCandidates,
  sprintFieldOf,
  sprintsOf,
  type Send,
} from "./jira";

/** A connection whose requests get these answers, in turn. */
function answering(...answers: { status: number; body?: unknown }[]) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const send: Send = async (method, path, body) => {
    sent.push({ method, path, body });
    const a = answers.shift() ?? { status: 200 };
    return { status: a.status, body: a.body ?? null, retry_after: 0 };
  };
  return { jira: jiraClient("https://example.atlassian.net", "me@example.com", send), sent };
}

describe("siteOrigin", () => {
  it("takes a Jira Cloud site however it's typed", () => {
    expect(siteOrigin("example.atlassian.net")).toBe("https://example.atlassian.net");
    expect(siteOrigin(" https://Example.atlassian.net/browse/ABC-1 ")).toBe("https://example.atlassian.net");
  });

  it("refuses anything that isn't one", () => {
    for (const bad of ["", "http://example.atlassian.net", "https://example.atlassian.net.evil.com", "https://evil.com", "https://a.b.atlassian.net", "https://atlassian.net", "https://example.atlassian.net:444"])
      expect(siteOrigin(bad)).toBeNull();
  });
});

describe("jiraMessage", () => {
  it("says what Jira said", () => {
    expect(jiraMessage(400, { errorMessages: ["The value 'X' does not exist for the field 'sprint'."], errors: {} })).toBe("The value 'X' does not exist for the field 'sprint'. (400)");
    expect(jiraMessage(400, { errorMessages: [], errors: { duedate: "Bad date" } })).toBe("duedate: Bad date (400)");
  });

  it("points at Settings when the token isn't accepted, and says when access is refused", () => {
    expect(jiraMessage(401, null)).toMatch(/Settings › Jira/);
    expect(jiraMessage(403, null)).toMatch(/^Jira refused \(403\)/);
  });

  it("leaves out an HTML error page", () => {
    expect(jiraMessage(503, "<html>Service unavailable</html>")).toBe("Jira answered 503.");
  });
});

describe("jiraClient", () => {
  it("waits and asks again when Jira is too busy", async () => {
    const { jira, sent } = answering({ status: 429 }, { status: 200, body: { ok: true } });
    expect(await jira.get("/rest/api/3/myself")).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
  });

  it("throws Jira's reason with its status", async () => {
    const { jira } = answering({ status: 404, body: { errorMessages: ["Issue does not exist"] } });
    const e = await jira.get("/rest/api/3/issue/ABC-1").catch((x) => x);
    expect(e).toBeInstanceOf(JiraError);
    expect(e.status).toBe(404);
    expect(e.message).toBe("Issue does not exist");
  });
});

describe("searchIssues", () => {
  it("reads every page", async () => {
    const { jira, sent } = answering(
      { status: 200, body: { issues: [{ key: "A-1", fields: {} }], nextPageToken: "p2" } },
      { status: 200, body: { issues: [{ key: "A-2", fields: {} }], isLast: true } },
    );
    expect((await searchIssues(jira, "project = A", ["status"])).map((i) => i.key)).toEqual(["A-1", "A-2"]);
    expect(sent[1].body).toMatchObject({ jql: "project = A", fields: ["status"], nextPageToken: "p2" });
  });

  it("stops at the limit", async () => {
    const { jira, sent } = answering({ status: 200, body: { issues: [{ key: "A-1", fields: {} }], nextPageToken: "p2" } });
    expect(await searchIssues(jira, "project = A", [], 1)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ maxResults: 1 });
  });
});

describe("fields", () => {
  const fields = [
    { id: "customfield_10020", name: "Sprint", schema: { type: "array", custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
    { id: "customfield_1", name: "Estimate (T-shirt)", schema: { type: "option" } },
    { id: "customfield_2", name: "T-Shirt Size", schema: { type: "option" } },
    { id: "customfield_3", name: "Story point estimate", schema: { type: "number" } },
    { id: "customfield_4", name: "Team", schema: { type: "option" } },
  ];

  it("finds the sprint field and the fields that could hold sizes", () => {
    expect(sprintFieldOf(fields)).toBe("customfield_10020");
    expect(sprintFieldOf([])).toBe("customfield_10020");
    expect(sizeFieldCandidates(fields)).toEqual(["customfield_1", "customfield_2"]);
  });

  it("reads a field's value as text", () => {
    expect(fieldText({ value: "M", id: "1" })).toBe("M");
    expect(fieldText("XL")).toBe("XL");
    expect(fieldText([{ value: "S" }])).toBe("S");
    expect(fieldText(null)).toBeNull();
  });

  it("reads a status's category", () => {
    expect(categoryOf({ statusCategory: { key: "done" } })).toBe("done");
    expect(categoryOf({ statusCategory: { key: "indeterminate" } })).toBe("in_progress");
    expect(categoryOf({ statusCategory: { key: "new" } })).toBe("todo");
    expect(categoryOf(undefined)).toBe("todo");
  });

  it("finds an issue's epic from its parent, else its Epic Link", () => {
    expect(epicOf({ parent: { key: "A-9", fields: { issuetype: { name: "Epic", hierarchyLevel: 1 } } } }, null)).toBe("A-9");
    expect(epicOf({ parent: { key: "A-3", fields: { issuetype: { name: "Story", hierarchyLevel: 0 } } } }, null)).toBeNull();
    expect(epicOf({ customfield_10014: "A-7" }, "customfield_10014")).toBe("A-7");
    expect(epicOf({}, "customfield_10014")).toBeNull();
  });

  it("reads an issue's sprints", () => {
    expect(sprintsOf({ s: [{ id: 1, name: "Sprint 1", state: "active" }, null, { name: "x" }] }, "s")).toEqual([{ id: 1, name: "Sprint 1", state: "active" }]);
    expect(sprintsOf({}, "s")).toEqual([]);
  });

  it("quotes text for JQL", () => {
    expect(jqlString('Sprint "24" \\ a')).toBe('"Sprint \\"24\\" \\\\ a"');
  });
});
