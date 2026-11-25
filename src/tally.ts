import { localDate } from "./scheduler";

/**
 * The tally after the Tasks column's title: a mark for each task finished today, in fives (four
 * upright strokes, the fifth struck across them), drawn as if by hand. Kept pure so it can be tested.
 */

/** How many tasks were finished today (local time): each task once, however many lists it's in. */
export function doneToday(tasks: { id: string; done: boolean; doneAt?: string | null }[], today: string): number {
  const ids = new Set<string>();
  for (const t of tasks) if (t.done && t.doneAt && localDate(new Date(t.doneAt)) === today) ids.add(t.id);
  return ids.size;
}

/** A tally's height, and how far apart its strokes and its groups of five are. */
export const TALLY_HEIGHT = 16;
const STEP = 4;
const GROUP = 22;
const FIRST = 2;

/** A small seeded random number generator (mulberry32): the same seed, the same numbers, so a mark keeps its scrawl. */
function seeded(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (v: number) => Number(v.toFixed(2));

/**
 * The tally's strokes for `count` marks, as SVG paths, in the order they're drawn. Each upright leans
 * and bows a little, starts and stops a little differently and sometimes flicks at its foot; each
 * fifth is struck across its four, rising to the right. Each stroke's wobble comes from its place, so
 * it's the same every time it's drawn.
 */
export function tallyStrokes(count: number): string[] {
  const strokes: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = seeded(i * 9973 + 17);
    const j = (a: number, b: number) => a + (b - a) * r();
    const group = Math.floor(i / 5);
    const gx = group * GROUP;
    if (i % 5 === 4) {
      // The fifth: struck across the four, from low on the left to high on the right.
      const x0 = gx + j(-1.2, 0.2);
      const y0 = j(11.6, 13.4);
      const x1 = gx + FIRST + 3 * STEP + j(2.2, 3.6);
      const y1 = j(2.6, 4.4);
      strokes.push(`M${n(x0)} ${n(y0)}Q${n((x0 + x1) / 2 + j(-1, 1))} ${n((y0 + y1) / 2 + j(-1.2, 1.2))} ${n(x1)} ${n(y1)}`);
      continue;
    }
    const x = gx + FIRST + (i % 5) * STEP + j(-0.5, 0.5);
    const top = j(1.4, 3.2);
    const bottom = j(13, 14.8);
    const lean = j(-0.9, 0.7);
    const x0 = x + lean;
    const x1 = x - lean * 0.3;
    let d = `M${n(x0)} ${n(top)}Q${n((x0 + x1) / 2 + j(-0.8, 0.8))} ${n((top + bottom) / 2)} ${n(x1)} ${n(bottom)}`;
    // Now and then a little flick at its foot, as the pen lifts.
    if (r() < 0.45) d += `q${n(j(0.2, 0.5))} ${n(j(0.3, 0.7))} ${n(j(0.6, 1.3))} ${n(j(0, 0.5))}`;
    strokes.push(d);
  }
  return strokes;
}

/** How wide a tally of `count` marks is drawn. */
export function tallyWidth(count: number): number {
  if (count <= 0) return 0;
  const full = Math.floor(count / 5);
  const rest = count % 5;
  const last = rest === 0 ? (full - 1) * GROUP + FIRST + 3 * STEP + 4 : full * GROUP + FIRST + (rest - 1) * STEP + 2;
  return Math.ceil(last + 1);
}
