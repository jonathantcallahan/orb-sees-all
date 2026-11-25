import { describe, expect, it } from "vitest";
import { epicChatKey, epicChatText, personChatKey, personChatText, sprintChatSubject, sprintsChatKey, sprintsChatText } from "./sprintChat";
import type { StoredEpicChildren, StoredSprintEpics } from "./db";

const issue = (key: string, category: "done" | "in_progress" | "todo", assignee: string | null) => ({ key, category, assignee, avatar: null });
const sprint: StoredSprintEpics = {
  sprint: { name: "Sprint 24", start: "2026-11-22T09:00:00Z", end: "2026-12-06T09:00:00Z" },
  epics: [
    {
      key: "PAY-1",
      title: "Refunds",
      status: "In Progress",
      category: "in_progress",
      link: "https://example.atlassian.net/browse/PAY-1",
      due: "2026-12-12",
      assignee: "Cy",
      avatar: null,
      parents: [],
      issues: [issue("PAY-2", "done", "Ana"), issue("PAY-3", "in_progress", "Ben")],
      progress: { done: 4, started: 2, total: 9 },
    },
  ],
  unparented: 1,
  strays: [issue("PAY-9", "todo", "Ana")],
  at: "2026-11-24T12:00:00Z",
};
const sprints = { "PAY:current": sprint };

describe("the Epics area's chats", () => {
  it("say what they're about from their keys", () => {
    expect(sprintChatSubject(epicChatKey("PAY-1"))).toEqual({ kind: "epic", epic: "PAY-1" });
    expect(sprintChatSubject(personChatKey("PAY", "Ana Lopez"))).toEqual({ kind: "person", project: "PAY", name: "Ana Lopez" });
    expect(sprintChatSubject(personChatKey("PAY", null))).toEqual({ kind: "person", project: "PAY", name: null });
    expect(sprintChatSubject(sprintsChatKey("PAY"))).toEqual({ kind: "sprints", project: "PAY" });
    expect(sprintChatSubject("global:sprints:")).toBeNull();
    expect(sprintChatSubject("global:project:C123")).toBeNull();
    expect(sprintChatSubject("global:1764000000000")).toBeNull();
    expect(epicChatKey("PAY-1").startsWith("global:")).toBe(true);
  });

  it("tell an epic's chat its status, due date, counts and issues", () => {
    const children: Record<string, StoredEpicChildren> = {
      "PAY-1": { issues: [{ key: "PAY-2", title: "Refund API", status: "Done", category: "done", assignee: "Ana", link: "https://example.atlassian.net/browse/PAY-2" }, { key: "PAY-4", title: "Refund emails", status: "To Do", category: "todo" }], at: "2026-11-24T11:00:00Z" },
    };
    const text = epicChatText("PAY-1", sprints, children)!;
    expect(text).toContain('Jira epic PAY-1, "Refunds"');
    expect(text).toContain("Status: In Progress; due 2026-12-12; assigned to Cy");
    expect(text).toContain("4 of 9 done, 2 in progress");
    expect(text).toContain("In Sprint 24: PAY-2, PAY-3");
    expect(text).toContain("- PAY-2 [Done] Refund API; Ana (in a sprint shown)");
    expect(text).toContain("- PAY-4 [To Do] Refund emails; unassigned");
    expect(epicChatText("PAY-1", sprints, {})).toContain("haven't been read in full yet");
    expect(epicChatText("PAY-7", sprints, {})).toBeNull();
  });

  it("tell a person's chat their issues in each sprint, with their epics", () => {
    const text = personChatText("PAY", "Ana", sprints, {})!;
    expect(text).toContain("Ana in the Jira project PAY's sprints");
    expect(text).toContain("The current sprint, Sprint 24: 2 issues for Ana, 1 done and 0 in progress:");
    expect(text).toContain("- PAY-2 [done]; Ana (epic PAY-1, Refunds)");
    expect(text).toContain("- PAY-9 [to do]; Ana (in no epic)");
    expect(personChatText("PAY", "Cy", sprints, {})).toBeNull();
  });

  it("tell the area's chat each sprint's epics, issues and who has them", () => {
    const upcoming: StoredSprintEpics = { sprint: null, epics: [], unparented: 0, strays: [], at: "2026-11-24T12:00:00Z" };
    const children: Record<string, StoredEpicChildren> = {
      "PAY-1": { issues: [{ key: "PAY-3", title: "Refund UI", status: "In Review", category: "in_progress", assignee: "Ben" }], at: "2026-11-24T11:00:00Z" },
    };
    const text = sprintsChatText("PAY", { ...sprints, "PAY:upcoming": upcoming }, children, Date.parse("2026-11-24T12:00:00Z"))!;
    expect(text).toContain("the Jira project PAY's sprints");
    expect(text).toContain("The current sprint, Sprint 24, 2026-11-22 to 2026-12-06: 3 issues, 1 done and 1 in progress.");
    expect(text).toContain('Epic PAY-1, "Refunds" (In Progress, due 2026-12-12, assigned to Cy; all its issues 4 of 9 done, 2 in progress)');
    expect(text).toContain("- PAY-3 [In Review] Refund UI; Ben");
    expect(text).toContain("In no epic:\n- PAY-9 [to do]; Ana");
    expect(text).toContain("Who has them: Ana, 2 (1 done, 0 in progress); Ben, 1 (0 done, 1 in progress)");
    expect(text).toContain("No upcoming sprint is planned yet.");
    expect(sprintsChatText("OPS", sprints, {})).toBeNull();
  });
});
