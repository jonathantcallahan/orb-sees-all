/**
 * T-shirt sizes and the story points they stand for, on Fibonacci's scale: XS 1, S 2, M 3, L 5, XL 8,
 * XXL 13. Jira holds each issue's size in a field of the project's own (found by the first sprint read
 * and kept as a setting, see sizeFieldSetting); the Epics area counts points from them beside tickets.
 * Kept pure so it can be tested.
 */
export const SIZE_POINTS = { XS: 1, S: 2, M: 3, L: 5, XL: 8, XXL: 13 } as const;
export type Size = keyof typeof SIZE_POINTS;

/** A size as Jira gives it ("M", " xl "), or null for none or anything else. */
export function sizeOf(value: string | null | undefined): Size | null {
  const k = value?.trim().toUpperCase().replace(/\s+/g, "");
  return k && k in SIZE_POINTS ? (k as Size) : null;
}

/** A size's points; null for an issue with no size. */
export const pointsOf = (value: string | null | undefined): number | null => {
  const s = sizeOf(value);
  return s ? SIZE_POINTS[s] : null;
};

/** Points: how many are done, in progress and in all, from the issues that have a size; how many don't. */
export interface Points {
  done: number;
  started: number;
  total: number;
  unsized: number;
}

type Category = "done" | "in_progress" | "todo";

/** Some issues' points, from each one's size and category. */
export function pointsTally(issues: { category: Category; size?: string | null }[]): Points {
  const out: Points = { done: 0, started: 0, total: 0, unsized: 0 };
  for (const i of issues) {
    const p = pointsOf(i.size);
    if (p === null) {
      out.unsized += 1;
      continue;
    }
    out.total += p;
    if (i.category === "done") out.done += p;
    else if (i.category === "in_progress") out.started += p;
  }
  return out;
}

/**
 * An epic's points over all its issues, from the sprint read's list of its sized ones ("M:done",
 * "L:in_progress"…) and how many issues it has in all; null when the read has no such list (sizes
 * weren't read, or reading them failed).
 */
export function epicPoints(sized: string[] | null | undefined, issues: number | null | undefined): Points | null {
  if (!sized) return null;
  const tally = pointsTally(
    sized.map((s) => {
      const [size, category] = s.split(":").map((x) => x.trim());
      return { size, category: category === "done" || category === "in_progress" ? category : "todo" };
    }),
  );
  return { ...tally, unsized: Math.max(0, (issues ?? 0) - sized.filter((s) => pointsOf(s.split(":")[0]) !== null).length) };
}

/** More than this many points in a sprint is too much for one person. */
export const OVERLOAD_POINTS = 13;

/**
 * The setting that holds the Jira field a project keeps T-shirt sizes in ("customfield_10001"), once a
 * sprint read has found one; unset until then, and again when that field turns out to hold none of the
 * sprint's sizes, so the next read looks again. (The first version could keep a field that more of the
 * project's old issues had than its current ones; this one is chosen from the sprint's own issues.)
 */
export const sizeFieldSetting = (project: string) => `epics_size_field_v2:${project}`;

/** Which way sizes were read: a sprint read from before this is read again (see oldRead). */
export const SIZES_READ = 2;

/** A field as JQL names it: a custom field by its number ("cf[10001]"), any other by its name. */
export function sizeFieldJql(field: string): string {
  const m = field.match(/^customfield_(\d+)$/);
  return m ? `cf[${m[1]}]` : `"${field.replace(/"/g, "")}"`;
}
