/**
 * The user's corrections, recorded so Demian learns from them. Every place the user changes what
 * Demian found (a description, a priority, a dismissal, a merge, a plan, a message, a project) calls
 * recordCorrection, which logs it and offers an optional "Why?" (WhyPrompt). Reasons left blank are
 * inferred later, when the corrections are distilled into lessons (distillLessons in jobs).
 */
import * as db from "./db";
import { sameWork } from "./duplicates";
import type { CardTask } from "./components/TaskCard";

export const WHY_EVENT = "feedback:why";

export interface WhyRequest {
  id: number;
  /** What was just changed, in a few words ("Dismissed "Review the SIT plan""), shown in the prompt. */
  label: string;
}

/** Logs a correction and, unless it came with a reason, offers the optional "Why?". */
export async function recordCorrection(f: db.NewFeedback, label: string): Promise<number> {
  const id = await db.logFeedback(f);
  if (!f.reason && id) window.dispatchEvent(new CustomEvent<WhyRequest>(WHY_EVENT, { detail: { id, label } }));
  return id;
}

/** What a task was, for a correction's "before": enough to recognize it again if it comes back. */
export function taskSnapshot(t: Pick<CardTask, "title" | "description" | "link" | "project" | "source">) {
  return { title: t.title, description: t.description ?? null, link: t.link ?? null, source: t.source, project: t.project?.name ?? null };
}

const quote = (s: string, max = 48) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;
export const label = {
  dismiss: (title: string) => `Dismissed ${quote(title)}`,
  priority: (title: string, to: string) => `${quote(title)} set to ${to}`,
  description: (title: string) => `Edited the description of ${quote(title)}`,
  merge: (title: string) => `Merged into ${quote(title)}`,
  notDuplicate: (title: string) => `${quote(title)} isn't a duplicate`,
  plan: (title: string) => `Changed the plan for ${quote(title)}`,
  message: (to: string) => `Edited the message to ${to}`,
  unlink: (channel: string) => `Unlinked #${channel}`,
};

// ---- what Demian has learned, for the prompts

/** Where a lesson applies; each prompt reads the scopes that fit it (see lessonsFor). */
export const LESSON_SCOPES = ["global", "projects", "tasks", "priority", "plans", "writing"] as const;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);
const short = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** One correction as a line for a prompt: what the user changed, and why if known. */
export function describeFeedback(f: db.Feedback): string | null {
  const title = str(field(f.before, "title")) || str(field(field(f.before, "task"), "title")) || str(field(field(f.before, "kept"), "title"));
  const why = f.reason ? ` Why: ${short(f.reason, 240)}` : "";
  const line = (() => {
    switch (f.kind) {
      case "description_edit":
        return `Rewrote the description of "${title}" to: "${short(str(field(f.after, "description")), 300)}".`;
      case "priority_change": {
        const to = str(field(f.after, "priority")) || "automatic";
        const was = str(field(f.before, "priority"));
        return `Set "${title}" to ${to} priority${was && was !== to ? ` (Demian had ${was})` : ""}.`;
      }
      case "dismiss":
        return `Dismissed "${title}" as not a task for them.`;
      case "task_merge":
        return `Merged "${str(field(field(f.before, "folded"), "title"))}" into "${title}": the same work.`;
      case "not_duplicate":
        return `"${title}" and "${str(field(field(f.before, "looked_like"), "title"))}" are separate tasks, not duplicates.`;
      case "plan_change": {
        const steps = (k: "before" | "after") => ((field(f[k], "steps") as string[] | undefined) ?? []).join("; ");
        return `Changed the plan for "${title}" from [${short(steps("before"), 300)}] to [${short(steps("after"), 300)}].`;
      }
      case "message_edit":
        return `Rewrote a drafted message before sending. Draft: "${short(str(field(f.before, "text")), 200)}". Sent: "${short(str(field(f.after, "text")), 200)}".`;
      case "channel_unlink":
        return `Unlinked #${str(field(f.before, "channel"))} from "${str(field(f.before, "project"))}": it isn't part of this project.`;
      case "project_focus":
        return null; // The focus itself is given separately.
      default: {
        const summary = str(field(f.after, "summary"));
        return summary ? `${summary}.` : null;
      }
    }
  })();
  return line ? `${line}${why}` : null;
}

/** Lessons for a prompt: the given scopes, plus any for the project. */
export async function lessonsFor(scopes: string[], projectId?: string | null): Promise<string[]> {
  const want = new Set(["global", ...scopes, ...(projectId ? [`project:${projectId}`] : [])]);
  return (await db.listLessons()).filter((l) => want.has(l.scope)).map((l) => l.text);
}

/** Dismissed tasks, with what they were, so a refresh doesn't raise the same ask again. */
export async function dismissedFor(projectId: string | null): Promise<{ title: string; gist: string | null; why: string | null }[]> {
  const all = await db.listFeedback({ ...(projectId ? { projectId } : {}), limit: 400 });
  return all
    .filter((f) => f.kind === "dismiss" && (projectId ? true : !f.project_id))
    .slice(0, 40)
    .map((f) => ({ title: str(field(f.before, "title")), gist: short(str(field(f.before, "description")), 120) || null, why: f.reason }))
    .filter((d) => d.title);
}

export interface Learning {
  /** The user's own description of the project. */
  focus?: { name: string | null; focus: string | null; out_of_scope: string | null } | null;
  /** The user's past corrections about this project (or the task list), newest first. */
  corrections: string[];
  /** Tasks the user dismissed; not to be raised again. */
  dismissed: { title: string; gist: string | null; why: string | null }[];
  /** Standing guidance distilled from all the user's corrections. */
  lessons: string[];
}

/** Everything learned that a project refresh (projectId) or the task list refresh (null) should know. */
export async function learningFor(projectId: string | null, scopes: string[]): Promise<Learning> {
  const [feedback, dismissed, lessons, focus] = await Promise.all([
    db.listFeedback({ ...(projectId ? { projectId } : {}), limit: 60 }),
    dismissedFor(projectId),
    lessonsFor(scopes, projectId),
    projectId ? db.listFocus().then((m) => m.get(projectId) ?? null) : Promise.resolve(null),
  ]);
  const corrections = feedback
    .filter((f) => f.kind !== "dismiss" && f.kind !== "message_edit" && (projectId ? true : !f.project_id))
    .map(describeFeedback)
    .filter((l): l is string => !!l)
    .slice(0, 25);
  return {
    focus: focus && (focus.pinned_name || focus.focus || focus.out_of_scope) ? { name: focus.pinned_name, focus: focus.focus, out_of_scope: focus.out_of_scope } : null,
    corrections,
    dismissed,
    lessons,
  };
}

/** What a plan should learn from: how the user has reworked plans before, and the plan and writing lessons. */
export async function planLearning(): Promise<Learning> {
  const [feedback, lessons] = await Promise.all([db.listFeedback({ limit: 200 }), lessonsFor(["plans", "writing"])]);
  return {
    corrections: feedback
      .filter((f) => f.kind === "plan_change" || f.kind === "message_edit")
      .slice(0, 12)
      .map(describeFeedback)
      .filter((l): l is string => !!l),
    dismissed: [],
    lessons,
  };
}

/** A task as the user has it: their edited description and their priority over what a refresh wrote. */
export function asUserHasIt<T extends { id: string; description?: string | null; assessment?: { priority?: string | null } | null }>(
  t: T,
  descriptions: Record<string, string>,
  priorities: Record<string, string>,
): T {
  const description = descriptions[t.id];
  const priority = priorities[t.id];
  if (!description && !priority) return t;
  return {
    ...t,
    ...(description ? { description } : {}),
    ...(priority && t.assessment ? { assessment: { ...t.assessment, priority } } : {}),
  };
}

/**
 * A safety net after a refresh: a new task that looks like one the user dismissed (the same ask,
 * raised again in another message) is dismissed too, and noted as such.
 */
export async function keepDismissed(tasks: { id: string; title: string; description?: string | null }[], projectId: string | null) {
  const [dismissed, states] = await Promise.all([dismissedFor(projectId), db.getTaskStates()]);
  if (!dismissed.length) return;
  for (const t of tasks) {
    if (states.has(t.id)) continue;
    const match = dismissed.find((d) => sameWork(t, { id: "", title: d.title, description: d.gist }));
    if (!match) continue;
    await db.setTaskState(t.id, { dismissed: true });
    await db.logFeedback({
      kind: "dismiss",
      subject: "task",
      subject_id: t.id,
      project_id: projectId,
      before: { title: t.title, description: t.description ?? null },
      reason: `Same as "${match.title}", which you dismissed`,
      reason_source: "inferred",
    });
  }
}
