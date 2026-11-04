/**
 * Spotting likely duplicates among open tasks, locally and cheaply, so the user can merge them.
 * Refreshes already avoid most duplicates (taskIndex.ts); this catches the rest, like a task you
 * typed in yourself that a refresh also found.
 */

export interface DuplicateCandidate {
  id: string;
  title: string;
}

interface Comparable {
  id: string;
  title: string;
  description?: string | null;
}

const STOP = new Set(
  "the a an to for of and on in with from by at is be it this that your my our we you i me on up out about into get got any all can will".split(" "),
);

function words(text: string | null | undefined): Set<string> {
  return new Set(
    (text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      // Fold simple plurals so "numbers" and "number" match.
      .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Title overlap that alone suggests the same task. */
const TITLE_MATCH = 0.5;
/** A looser title overlap, confirmed by overlapping descriptions. */
const TITLE_HINT = 0.3;
const DESCRIPTION_MATCH = 0.35;

/** How alike two tasks are, 0 to 1; above TITLE_MATCH (or a hint plus description overlap) is a likely duplicate. */
export function similarity(a: Comparable, b: Comparable): number {
  const title = jaccard(words(a.title), words(b.title));
  if (title >= TITLE_MATCH) return title;
  if (title >= TITLE_HINT && jaccard(words(a.description), words(b.description)) >= DESCRIPTION_MATCH) return TITLE_MATCH;
  return title;
}

/** Whether two tasks look like the same work, by the same test findDuplicates uses. */
export const sameWork = (a: Comparable, b: Comparable) => similarity(a, b) >= TITLE_MATCH;

/** The key for a pair of task ids, in either order (the same as notDuplicateKey in db.ts). */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * The merges to make from the merge pass's sets of same work (SameWork), as keep/drop pairs. Each
 * id must be an open task, by canonical id; a pair the user said isn't a duplicate stays apart; the
 * user's own task is the one kept when the set has one (their words, plan and session stay); two
 * tasks that each have a Claude session stay apart, so neither session is lost; a task is merged at
 * most once per pass; and with `focus` (tasks just added), only sets that include one of them count.
 */
export function acceptedMerges(
  groups: { keep: string; drop: string[]; why?: string | null }[],
  known: { open: Set<string>; mine: Set<string>; notDuplicates: Set<string>; sessions: Set<string>; aliases: Map<string, string>; focus?: Set<string> },
): { keep: string; drop: string; why: string | null }[] {
  const canon = (id: string) => known.aliases.get(id) ?? id;
  const taken = new Set<string>();
  const out: { keep: string; drop: string; why: string | null }[] = [];
  for (const g of groups) {
    const ids = [...new Set([g.keep, ...g.drop].map(canon))].filter((id) => known.open.has(id) && !taken.has(id));
    if (ids.length < 2) continue;
    if (known.focus && !ids.some((id) => known.focus!.has(id))) continue;
    const wanted = canon(g.keep);
    const keep = ids.some((id) => known.mine.has(id)) && !known.mine.has(wanted) ? ids.find((id) => known.mine.has(id))! : ids.includes(wanted) ? wanted : ids[0];
    for (const drop of ids) {
      if (drop === keep || known.notDuplicates.has(pairKey(keep, drop))) continue;
      if (known.sessions.has(keep) && known.sessions.has(drop)) continue;
      out.push({ keep, drop, why: g.why?.trim() || null });
      taken.add(drop);
    }
    if (out.some((m) => m.keep === keep)) taken.add(keep);
  }
  return out;
}

/**
 * For each task, the most similar other open task, when they look like the same work. Pairs the
 * user marked "not a duplicate" are skipped (keys from notDuplicateKey in db.ts).
 */
export function findDuplicates(tasks: Comparable[], notDuplicates: Set<string>): Map<string, DuplicateCandidate> {
  const key = pairKey;
  const best = new Map<string, { score: number; other: Comparable }>();
  for (let i = 0; i < tasks.length; i++)
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (a.id === b.id || notDuplicates.has(key(a.id, b.id))) continue;
      const score = similarity(a, b);
      if (score < TITLE_MATCH) continue;
      for (const [self, other] of [
        [a, b],
        [b, a],
      ] as const)
        if (score > (best.get(self.id)?.score ?? 0)) best.set(self.id, { score, other });
    }
  return new Map([...best].map(([id, { other }]) => [id, { id: other.id, title: other.title }]));
}
