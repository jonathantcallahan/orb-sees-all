import { describe, expect, it } from "vitest";
import type { Feedback } from "./db";
import { asUserHasIt, describeFeedback } from "./feedback";
import { foldProfile, mergeProfile, projectContext, projectName } from "./projects";
import { distillPrompt, learningSection, planPrompt, projectPrompt } from "./prompts";
import type { ProjectProfile } from "./schema";

const profile = (p: Partial<ProjectProfile>): ProjectProfile => ({ goal: "", context: [], aliases: [], people: [], resources: [], milestones: [], decisions: [], ...p });

const fb = (f: Partial<Feedback>): Feedback => ({
  id: 1,
  at: "2026-11-02T10:00:00Z",
  kind: "dismiss",
  subject: "task",
  subject_id: "t1",
  project_id: null,
  before: null,
  after: null,
  reason: null,
  reason_source: null,
  source: "ui",
  distilled: false,
  ...f,
});

describe("project knowledge builds up", () => {
  it("keeps what a refresh no longer mentions, newest first, and never loses a known goal", () => {
    const prev = profile({
      goal: "Ship refunds",
      people: [{ name: "Ana", role: "PM" }],
      decisions: [{ what: "Use Stripe", date: "2026-10-01", link: "l1" }],
    });
    const next = profile({ goal: "", people: [{ name: "Ben", role: "eng" }], decisions: [{ what: "Launch Nov 17", date: "2026-10-20", link: "l2" }] });
    const merged = mergeProfile(prev, next);
    expect(merged.goal).toBe("Ship refunds");
    expect(merged.people.map((p) => p.name)).toEqual(["Ben", "Ana"]);
    expect(merged.decisions.map((d) => d.link)).toEqual(["l2", "l1"]);
  });

  it("always counts the user's own names among the aliases", () => {
    expect(mergeProfile(null, profile({ aliases: ["RF"] }), ["Refunds"]).aliases).toEqual(["Refunds", "RF"]);
  });

  it("folds a merged-away project in, its name becoming another name", () => {
    const into = profile({ goal: "Checkout", people: [{ name: "Ana", role: "PM" }] });
    const from = profile({ goal: "Old", people: [{ name: "Cy", role: "design" }] });
    const folded = foldProfile(into, from, "Payment sheet");
    expect(folded.goal).toBe("Checkout");
    expect(folded.aliases).toContain("Payment sheet");
    expect(folded.people.map((p) => p.name)).toEqual(["Ana", "Cy"]);
  });

  it("lists the user's context entries first, then Demian's, leaving out removed and repeated ones", () => {
    const p = {
      profile: { ...profile({}), context: ["Covers refunds", "It covers payouts", "Run by Ana"] },
      focus: { project_id: "C1", pinned_name: null, focus: null, in_scope: null, out_of_scope: null, aliases: [], context: ["Run by Ana"], removed: ["It covers payouts"] },
    };
    expect(projectContext(p)).toEqual([
      { text: "Run by Ana", by: "you" },
      { text: "Covers refunds", by: "demian" },
    ]);
  });

  it("names a project the user's way first", () => {
    const p = { name: "tmp-refunds", snapshot: { name: "Asset refunds" } as never };
    expect(projectName(p)).toBe("Asset refunds");
    expect(projectName({ ...p, focus: { pinned_name: "Refunds v2" } })).toBe("Refunds v2");
  });
});

describe("corrections reach the prompts", () => {
  const learning = {
    focus: { name: "Refunds v2", context: ["Self-serve refunds for publishers", "Not part of it: Chargebacks"], removed: ["It covers payouts"] },
    corrections: ["Set \"Reply to Kim\" to low priority (Demian had high). Why: vendor ask"],
    dismissed: [{ title: "Fill in the offsite survey", gist: null, why: "Not work" }],
    lessons: ["Rate vendor asks as medium unless an exec is waiting"],
  };

  it("gives a project refresh the user's focus, corrections, dismissals and lessons", () => {
    const prompt = projectPrompt({
      channels: [{ channel_id: "C1", name: "tmp-refunds" }],
      userId: "U1",
      previous: null,
      profile: null,
      lastRefreshedAt: null,
      repoState: null,
      now: new Date("2026-11-02T10:00:00Z"),
      excluded: ["C9"],
      learning,
    });
    expect(prompt).toContain('The user calls it "Refunds v2"');
    expect(prompt).toContain("Not part of it: Chargebacks");
    expect(prompt).toContain("- It covers payouts");
    expect(prompt).toContain("Why: vendor ask");
    expect(prompt).toContain("Fill in the offsite survey");
    expect(prompt).toContain("Rate vendor asks as medium");
    // The name search leaves out unlinked channels too.
    expect(prompt).toContain("-in:<#C9>");
  });

  it("gives a plan the corrections and lessons but not the dismissed tasks", () => {
    const prompt = planPrompt({ title: "T", description: null, link: null, requester: null, source: "slack", userId: null, learning });
    expect(prompt).toContain("Rate vendor asks");
    expect(prompt).not.toContain("offsite survey");
  });

  it("adds nothing when nothing's been learned", () => {
    expect(learningSection({ corrections: [], dismissed: [], lessons: [] }, "project")).toBe("");
    expect(learningSection(undefined, "tasks")).toBe("");
  });

  it("describes each kind of correction plainly, with why", () => {
    expect(describeFeedback(fb({ kind: "dismiss", before: { title: "Survey" } }))).toContain('Dismissed "Survey"');
    expect(
      describeFeedback(fb({ kind: "priority_change", before: { title: "Reply to Kim", priority: "high" }, after: { priority: "low" }, reason: "vendor ask" })),
    ).toBe('Set "Reply to Kim" to low priority (Demian had high). Why: vendor ask');
    expect(describeFeedback(fb({ kind: "plan_change", before: { task: { title: "Notes" }, steps: ["A", "B"] }, after: { steps: ["A", "C"] } }))).toContain("[A; B] to [A; C]");
    expect(describeFeedback(fb({ kind: "project_focus" }))).toBeNull();
  });

  it("uses the user's own description and priority for a task", () => {
    const t = { id: "t1", description: "Model's", assessment: { priority: "high" } };
    expect(asUserHasIt(t, { t1: "Mine" }, { t1: "low" })).toEqual({ id: "t1", description: "Mine", assessment: { priority: "low" } });
    expect(asUserHasIt(t, {}, {})).toBe(t);
  });

  it("asks distilling to keep the user's own lessons and infer missing reasons", () => {
    const prompt = distillPrompt({
      feedback: [{ id: 3, kind: "dismiss", at: "", project: null, before: { title: "Survey" }, after: null, reason: null }],
      lessons: [{ scope: "priority", text: "Mine", evidence: [], origin: "user" }],
      projects: [],
    });
    expect(prompt).toContain('origin "user"');
    expect(prompt).toContain('"id":3');
    expect(prompt).toContain("reasons");
  });
});
