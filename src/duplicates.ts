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

/**
 * For each task, the most similar other open task, when they look like the same work. Pairs the
 * user marked "not a duplicate" are skipped (keys from notDuplicateKey in db.ts).
 */
export function findDuplicates(tasks: Comparable[], notDuplicates: Set<string>): Map<string, DuplicateCandidate> {
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
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
