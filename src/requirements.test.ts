import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, StoredRequirements } from "./db";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const db = { setProjectKind: vi.fn(), logFeedback: vi.fn(() => Promise.resolve()) };
const jobs = { linkProjectDoc: vi.fn() };
vi.mock("./db", () => db);
vi.mock("./jobs", () => jobs);
vi.mock("./claude", () => ({}));

const { bySection, docKindLabel, guideTitle, missingDoc, projectKind, requirementCounts, requirementRows, requirementsDue, withRequirementsRead } = await import("./projects");
const { projectPrompt, requirementsPrompt } = await import("./prompts");
const { ProjectRefresh, ProjectSnapshot, RequirementsRead } = await import("./schema");
const { applyAction, describeAction } = await import("./globalActions");

const TDD = "https://docs.google.com/document/d/abc/edit";

type P = Pick<Project, "kind_choice" | "snapshot" | "docs" | "requirements">;
const project = (over: Partial<P> = {}): P => ({ kind_choice: null, snapshot: null, docs: null, requirements: null, ...over });
const snapshot = (over: Record<string, unknown>) => ({ ...over }) as unknown as Project["snapshot"];
const linked = (link = TDD) => ({ doc: { link, title: "Google Doc", kind: null, at: "2026-11-14T09:00:00Z" } });
const stored = (over: Partial<StoredRequirements> = {}): StoredRequirements => ({
  link: TDD,
  title: "Refunds TDD",
  kind: "TDD",
  readAt: "2026-11-14T09:00:00Z",
  triedAt: "2026-11-14T09:00:00Z",
  error: null,
  docUpdated: "2026-11-10T12:00:00Z",
  unreadable: null,
  requirements: [
    { id: "R1", text: "Refunds within 14 days are automatic", section: "Refund flow", priority: "must" },
    { id: "R2", text: "Support can override a refund", section: "Support", priority: null },
    { id: "R3", text: "Refunds show in the order history", section: "Refund flow", priority: null },
  ],
  progress: {
    R1: { id: "R1", status: "done", note: "Shipped in 2.3", evidence: [], at: "2026-11-14T10:00:00Z" },
    R2: { id: "R2", status: "at_risk", note: "Waiting on support tooling", evidence: [], at: "2026-11-14T10:00:00Z" },
    R9: { id: "R9", status: "done", note: "A requirement the doc no longer has", evidence: [], at: "2026-11-14T10:00:00Z" },
  },
  progressAt: "2026-11-14T10:00:00Z",
  ...over,
});

describe("projects and workstreams", () => {
  it("takes the user's choice over the refresh's, and is unknown before any refresh", () => {
    expect(projectKind(project())).toBeNull();
    expect(projectKind(project({ snapshot: snapshot({ kind: { value: "workstream", reason: "Ongoing support" } }) }))).toBe("workstream");
    expect(
      projectKind(project({ snapshot: snapshot({ kind: { value: "workstream", reason: null } }), kind_choice: { kind: "project", at: "2026-11-14T09:00:00Z" } })),
    ).toBe("project");
  });

  it("says a doc is missing only for a project without one", () => {
    const asProject = { kind_choice: { kind: "project" as const, at: "x" } };
    expect(missingDoc(project(asProject))).toBe(true);
    expect(missingDoc(project({ ...asProject, docs: linked() }))).toBe(false);
    expect(missingDoc(project({ kind_choice: { kind: "workstream", at: "x" } }))).toBe(false);
    expect(missingDoc(project())).toBe(false);
    // A doc that was removed (null) leaves it missing again.
    expect(missingDoc(project({ ...asProject, docs: { doc: null } }))).toBe(true);
  });


  it("labels the doc kinds it knows", () => {
    expect(docKindLabel("tdd")).toBe("TDD");
    expect(docKindLabel("PRD")).toBe("PRD");
    expect(docKindLabel("spec")).toBe("Spec");
    expect(docKindLabel("other")).toBeNull();
    expect(docKindLabel(null)).toBeNull();
  });
});

describe("requirements", () => {
  it("lays progress over the doc's requirements, leaving out ids the doc no longer has", () => {
    const rows = requirementRows(project({ docs: linked(), requirements: stored() }));
    expect(rows.map((r) => [r.requirement.id, r.progress?.status ?? null])).toEqual([
      ["R1", "done"],
      ["R2", "at_risk"],
      ["R3", null],
    ]);
    expect(requirementCounts(rows)).toMatchObject({ total: 3, done: 1, at_risk: 1, pending: 1, in_progress: 0 });
  });

  it("shows nothing read from another doc than the linked one", () => {
    expect(requirementRows(project({ docs: linked("https://docs.google.com/document/d/new/edit"), requirements: stored() }))).toEqual([]);
    expect(requirementRows(project({ requirements: stored() }))).toEqual([]);
  });

  it("names the doc as read from it, else as it was linked", () => {
    expect(guideTitle(project({ docs: linked(), requirements: stored() }))).toBe("Refunds TDD");
    expect(guideTitle(project({ docs: linked() }))).toBe("Google Doc");
    expect(guideTitle(project())).toBeNull();
  });

  it("groups by section in the doc's order, unsectioned ones first", () => {
    const rows = requirementRows(
      project({
        docs: linked(),
        requirements: stored({ requirements: [...stored().requirements, { id: "R4", text: "Audit log", section: null, priority: null }] }),
      }),
    );
    expect(bySection(rows).map((g) => [g.section, g.rows.map((r) => r.requirement.id)])).toEqual([
      [null, ["R4"]],
      ["Refund flow", ["R1", "R3"]],
      ["Support", ["R2"]],
    ]);
  });

  it("reads the doc when it never was, another was linked, it was tried most of a day ago, or asked to", () => {
    const now = new Date("2026-11-15T09:00:00Z");
    expect(requirementsDue(project(), now)).toBe(false);
    expect(requirementsDue(project({ docs: linked() }), now)).toBe(true);
    expect(requirementsDue(project({ docs: linked("https://docs.google.com/document/d/new/edit"), requirements: stored() }), now)).toBe(true);
    expect(requirementsDue(project({ docs: linked(), requirements: stored() }), now)).toBe(true);
    const recent = stored({ triedAt: "2026-11-15T07:00:00Z" });
    expect(requirementsDue(project({ docs: linked(), requirements: recent }), now)).toBe(false);
    expect(requirementsDue(project({ docs: linked(), requirements: recent }), now, true)).toBe(true);
  });
});

describe("storing a read of the doc", () => {
  const doc = { link: TDD, title: "Google Doc" };
  const at = "2026-11-15T09:00:00Z";
  const read = (over: Record<string, unknown>) => RequirementsRead.parse(over);

  it("keeps the progress of requirements still in the doc, and drops the rest", () => {
    const next = withRequirementsRead(stored(), doc, read({ title: "Refunds TDD v2", updated: "2026-11-15T08:00:00Z", requirements: [{ id: "R1", text: "Refunds within 7 days are automatic" }, { id: "R4", text: "New one" }] }), at);
    expect(next.requirements.map((r) => r.id)).toEqual(["R1", "R4"]);
    expect(Object.keys(next.progress)).toEqual(["R1"]);
    expect(next).toMatchObject({ title: "Refunds TDD v2", readAt: at, triedAt: at, docUpdated: "2026-11-15T08:00:00Z", unreadable: null });
  });

  it("only notes the check when the doc hasn't changed", () => {
    const next = withRequirementsRead(stored({ error: "timed out" }), doc, read({ unchanged: true }), at);
    expect(next).toEqual({ ...stored(), readAt: at, triedAt: at, error: null });
  });

  it("keeps what it had, with the reason, when the doc can't be read", () => {
    const next = withRequirementsRead(stored(), doc, read({ unreadable: "No access to this doc." }), at);
    expect(next.unreadable).toBe("No access to this doc.");
    expect(next.requirements).toHaveLength(3);
  });

  it("starts afresh for another doc", () => {
    const next = withRequirementsRead(stored(), { link: "https://docs.google.com/document/d/new/edit", title: "Google Doc" }, read({ unchanged: true, requirements: [] }), at);
    expect(next).toMatchObject({ link: "https://docs.google.com/document/d/new/edit", title: "Google Doc", requirements: [], progress: {}, progressAt: null });
  });
});

describe("shapes", () => {
  it("reads a doc's requirements, and an unchanged or unreadable doc", () => {
    expect(RequirementsRead.parse({ unchanged: true }).requirements).toEqual([]);
    expect(RequirementsRead.parse({ unreadable: "Confluence pages can't be read here." }).unreadable).toMatch(/Confluence/);
    const read = RequirementsRead.parse({ title: "T", kind: "TDD", requirements: [{ id: "R1", text: "x", section: null, priority: "P0" }] });
    // An unknown rank isn't a reason to throw the read away.
    expect(read.requirements[0].priority).toBeNull();
  });

  it("still reads older snapshots, and doesn't fail a refresh over an odd kind, doc or status", () => {
    const base = {
      description: "d",
      status: "on_track",
      status_reason: "r",
      raci: { role: "accountable", reason: "x" },
      priority: { level: "P1", reason: "x" },
      blockers: [],
      my_tasks: [],
    };
    const old = ProjectSnapshot.parse(base);
    expect(old.kind).toBeUndefined();
    const refresh = ProjectRefresh.parse({
      ...base,
      profile: { goal: "g" },
      kind: { value: "initiative", reason: "?" },
      requirements_progress: [{ id: "R1", status: "shipped", note: "Out in 2.3" }],
    });
    expect(refresh.kind).toBeNull();
    expect(refresh.requirements_progress[0]).toMatchObject({ id: "R1", status: "unclear", evidence: [] });
  });
});

describe("prompts", () => {
  const input = { channels: [{ channel_id: "C1", name: "tmp-refunds" }], userId: "U1", previous: null, profile: null, lastRefreshedAt: null, now: new Date("2026-11-15T09:00:00Z") };

  it("asks a refresh for the kind but never for a doc to suggest, and for no progress without requirements", () => {
    const text = projectPrompt(input);
    expect(text).toContain('"workstream" (an ongoing initiative');
    expect(text).not.toContain("guide_doc");
    expect(text).toContain("requirements_progress: empty");
  });

  it("gives a refresh the requirements and their last progress, and the user's kind", () => {
    const text = projectPrompt({
      ...input,
      kindSetByUser: "project",
      guide: { title: "Refunds TDD", link: TDD, requirements: [{ id: "R1", text: "Refunds within 14 days are automatic" }], progress: [{ id: "R1", status: "in_progress", note: "Behind a flag" }] },
    });
    expect(text).toContain('The user set it to "project": return that.');
    expect(text).toContain("Refunds within 14 days are automatic");
    expect(text).toContain("Behind a flag");
    expect(text).toContain("requirements_progress: one entry for each requirement");
  });

  it("checks a doc's edit time before reading it again, and keeps ids", () => {
    const first = requirementsPrompt({ doc: { title: "Refunds TDD", link: TDD } });
    expect(first).not.toContain("get_file_metadata, modifiedTime). If it hasn't been edited");
    const again = requirementsPrompt({ doc: { title: "Refunds TDD", link: TDD }, previous: { requirements: [{ id: "R1", text: "x" }, { id: "R2", text: "y" }], docUpdated: "2026-11-10T12:00:00Z" } });
    expect(again).toContain("edited at 2026-11-10T12:00:00Z");
    expect(again).toContain("(R3, …)");
  });
});

describe("chat actions", () => {
  const name = (id: string) => (id === "C1" ? "Refunds" : id);
  beforeEach(() => {
    db.setProjectKind.mockClear();
    jobs.linkProjectDoc.mockClear();
  });

  it("says what each does on its card", () => {
    expect(describeAction({ type: "set_project_kind", project_id: "C1", kind: "workstream" }, name, name, () => null)).toBe('Make "Refunds" a workstream');
    expect(describeAction({ type: "set_project_kind", project_id: "C1", kind: "auto" }, name, name, () => null)).toMatch(/Let refreshes decide/);
    expect(describeAction({ type: "set_project_doc", project_id: "C1", link: TDD, title: "Refunds TDD" }, name, name, () => null)).toBe(
      'Use "Refunds TDD" as the requirements doc of "Refunds"',
    );
    expect(describeAction({ type: "set_project_doc", project_id: "C1", link: null }, name, name, () => null)).toBe('Remove the requirements doc of "Refunds"');
  });

  it("sets the kind, or hands it back to refreshes", async () => {
    await applyAction({ type: "set_project_kind", project_id: "C1", kind: "project" });
    await applyAction({ type: "set_project_kind", project_id: "C1", kind: "auto" });
    expect(db.setProjectKind.mock.calls).toEqual([
      ["C1", "project"],
      ["C1", null],
    ]);
  });

  it("links a doc by its link, removes it with none, and ignores what isn't a link", async () => {
    await applyAction({ type: "set_project_doc", project_id: "C1", link: ` ${TDD} `, title: "Refunds TDD" });
    await applyAction({ type: "set_project_doc", project_id: "C1", link: null });
    expect(await applyAction({ type: "set_project_doc", project_id: "C1", link: "the refunds doc" })).toMatch(/isn't a link/);
    expect(jobs.linkProjectDoc.mock.calls).toEqual([
      ["C1", { link: TDD, title: "Refunds TDD", kind: null }],
      ["C1", null],
    ]);
  });
});
