/**
 * Task identity across sources. A task keeps the id it was first seen with; any other id for the
 * same work (a later message in the thread, the same ask from another source, a merged task) is an
 * alias of it. These helpers fold aliases into one task so each piece of work shows once.
 */

export type Aliases = Map<string, string>;

/** The canonical id for any task id or source ref. */
export function canonicalId(id: string, aliases: Aliases): string {
  return aliases.get(id) ?? id;
}

export interface Foldable {
  id: string;
  link?: string | null;
  due?: string | null;
  blocking?: boolean;
  recommended?: boolean;
}

export type Folded<T> = T & {
  /** Original ids folded into this task, its own included. */
  aliasIds: string[];
  /** Source links of the tasks folded into this one. */
  aliasLinks: string[];
};

const earlier = (a: string | null | undefined, b: string | null | undefined) => (!a ? b : !b ? a : a < b ? a : b);

/**
 * Folds tasks that resolve to the same canonical id into one, across all the lists given. The task
 * whose own id is the canonical one stays (or, if it's gone, the first alias seen), keeps its place
 * in its list, and takes the canonical id; the rest are dropped from their lists. The kept task
 * gathers the others' links, the earliest due date, and is blocking or recommended if any of them is.
 */
export function foldTasks<T extends Foldable>(lists: T[][], aliases: Aliases): Folded<T>[][] {
  const groups = new Map<string, T[]>();
  for (const list of lists)
    for (const t of list) {
      const id = canonicalId(t.id, aliases);
      groups.set(id, [...(groups.get(id) ?? []), t]);
    }
  const primaryOf = new Map<string, T>();
  for (const [id, members] of groups) primaryOf.set(id, members.find((t) => t.id === id) ?? members[0]);

  return lists.map((list) =>
    list.flatMap((t) => {
      const id = canonicalId(t.id, aliases);
      if (primaryOf.get(id) !== t) return [];
      const members = groups.get(id)!;
      const others = members.filter((m) => m !== t);
      return [
        {
          ...t,
          id,
          due: others.reduce((d, m) => earlier(d, m.due), t.due),
          blocking: members.some((m) => m.blocking) || undefined,
          recommended: members.some((m) => m.recommended) || undefined,
          aliasIds: members.map((m) => m.id),
          aliasLinks: others.map((m) => m.link).filter((l): l is string => !!l),
        } as Folded<T>,
      ];
    }),
  );
}
