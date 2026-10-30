/**
 * A compact index of every open task the user has, from all sources, under canonical ids. Refreshes
 * get it so that new work matching an existing task refines that task instead of duplicating it.
 */
import { canonicalId, type Aliases } from "./registry";
import type { TaskState } from "./tasks";

export interface IndexEntry {
  id: string;
  title: string;
  /** The project's name, for project tasks and the user's own tasks filed under one. */
  project?: string;
  /** The first part of the description, enough to tell similar tasks apart. */
  gist?: string;
}

export interface IndexSource {
  id: string;
  title: string;
  description?: string | null;
  project?: string | null;
}

/** How much of a description to include; the index goes into every refresh prompt. */
const GIST_CHARS = 140;
/** Most entries to send; the user's open list rarely gets this long. */
const MAX_ENTRIES = 120;

function gist(text: string | null | undefined): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > GIST_CHARS ? `${t.slice(0, GIST_CHARS - 1)}…` : t;
}

/** One entry per open canonical task; the first source listed for a task supplies its title. */
export function buildIndex(sources: IndexSource[], states: Map<string, TaskState>, aliases: Aliases): IndexEntry[] {
  const seen = new Map<string, IndexEntry>();
  for (const t of sources) {
    const id = canonicalId(t.id, aliases);
    const st = states.get(id) ?? states.get(t.id);
    if (st?.done || st?.dismissed || seen.has(id)) continue;
    seen.set(id, { id, title: t.title, ...(t.project ? { project: t.project } : {}), ...(gist(t.description) ? { gist: gist(t.description) } : {}) });
  }
  return [...seen.values()].slice(0, MAX_ENTRIES);
}

/**
 * The refinements a refresh reported that Orb should record: the target must be an open task in the
 * index, and not the same task (by canonical id) as the one refining it.
 */
export function acceptedRefinements(
  tasks: { id: string; refines?: string | null }[],
  index: IndexEntry[],
  aliases: Aliases,
): { id: string; target: string }[] {
  const open = new Set(index.map((e) => e.id));
  return tasks.flatMap((t) => {
    if (!t.refines) return [];
    const target = canonicalId(t.refines, aliases);
    if (!open.has(target) || target === canonicalId(t.id, aliases)) return [];
    return [{ id: t.id, target }];
  });
}
