/**
 * Unread dots: a task, project or watched topic that Demian found something new about shows a green
 * dot beside its name until you open it.
 *
 * What counts as new is kept as a set of facts per item, each a short key for something Demian
 * found: a task's sources and refreshed description and double check, a project's status and recent
 * updates, a topic's updates. An item is unread when it has a fact you haven't seen, or when it's
 * new since dots began and you didn't add it yourself. Opening it marks its facts seen.
 *
 * Facts are keys, not the text, so a refresh rewording what it already said isn't news; and a fact
 * that drops out (a project's updates are only the latest ones) doesn't count either.
 */
import type { Aliases } from "./registry";
import { canonicalId } from "./registry";
import type { Project } from "./db";
import { projectStatus } from "./projects";
import type { TaskState } from "./tasks";
import type { WatchedTopic } from "./watched";

export interface UnreadInput {
  /** Visible, tracked projects. */
  projects: Project[];
  /** Slack and email tasks. */
  adhoc: { id: string }[];
  /** Your own tasks. */
  manual: { id: string }[];
  watched: WatchedTopic[];
  taskAliases: Aliases;
  refinedDescriptions: Record<string, string>;
  taskChecks: Record<string, { at: string }>;
  taskStates: Map<string, TaskState>;
}

/** A short, stable key for a piece of text. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Every item's facts, by id (a task's canonical id, a project's channel id, a topic's id), and which
 * ids are yours: tasks you added, and every project and topic (you track and watch them), which
 * aren't news when they appear, only when something is found about them later. Finished and
 * dismissed tasks, and finished topics, are left out: they never show a dot.
 */
export function updateFacts(d: UnreadInput): { facts: Map<string, string[]>; mine: Set<string> } {
  const facts = new Map<string, string[]>();
  const mine = new Set<string>();
  const closed = (id: string) => {
    const s = d.taskStates.get(id);
    return !!s && (s.done || s.dismissed);
  };
  // Every other id folded into each task: a refresh's refinement, or a merge.
  const refs = new Map<string, string[]>();
  for (const [ref, to] of d.taskAliases) refs.set(to, [...(refs.get(to) ?? []), ref]);
  const task = (id: string, yours: boolean) => {
    const cid = canonicalId(id, d.taskAliases);
    if (closed(cid) || facts.has(cid)) return;
    if (yours) mine.add(cid);
    const refined = d.refinedDescriptions[cid];
    const check = d.taskChecks[cid];
    facts.set(cid, [
      ...[cid, ...(refs.get(cid) ?? [])].sort().map((r) => `s:${r}`),
      ...(refined ? [`r:${hash(refined)}`] : []),
      ...(check ? [`c:${check.at}`] : []),
    ]);
  };
  for (const t of d.manual) task(t.id, true);
  for (const p of d.projects) for (const t of p.snapshot?.my_tasks ?? []) task(t.id, false);
  for (const t of d.adhoc) task(t.id, false);
  for (const p of d.projects) {
    const status = projectStatus(p);
    mine.add(p.channel_id);
    facts.set(p.channel_id, [
      ...(status ? [`p:${status}`] : []),
      ...(p.snapshot?.recent_updates ?? []).map((u) => `u:${u.link ?? u.date ?? hash(u.summary)}`),
    ]);
  }
  for (const t of d.watched) {
    if (d.taskStates.get(t.id)?.done) continue;
    mine.add(t.id);
    facts.set(t.id, t.history.map((h) => `w:${h.at}`));
  }
  return { facts, mine };
}

/**
 * The ids to show a dot on: an item with a fact not in what you've seen, or one you've never seen at
 * all that isn't yours. Before dots began (`started` false) nothing is unread.
 */
export function unreadIds(facts: Map<string, string[]>, mine: Set<string>, seen: Record<string, string[]>, started: boolean): Set<string> {
  const out = new Set<string>();
  if (!started) return out;
  for (const [id, list] of facts) {
    const known = seen[id];
    if (known ? list.some((f) => !known.includes(f)) : !mine.has(id)) out.add(id);
  }
  return out;
}

/** The most facts kept per item: old ones go first. */
const SEEN_KEPT = 200;

/** What's seen of an item after opening it: everything seen before plus its current facts. */
export function seenAfter(prior: string[] | undefined, current: string[]): string[] {
  const all = [...(prior ?? []).filter((f) => !current.includes(f)), ...current];
  return all.slice(-SEEN_KEPT);
}

/**
 * Items to record as seen without opening them: everything when dots begin (so what you have now
 * starts read), and after that your own items the first time they show up (so a later change to
 * them still gets a dot).
 */
export function toRecord(facts: Map<string, string[]>, mine: Set<string>, seen: Record<string, string[]>, started: boolean): string[] {
  return [...facts.keys()].filter((id) => !seen[id] && (!started || mine.has(id)));
}
