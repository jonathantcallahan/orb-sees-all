import { describe, expect, it } from "vitest";
import { doneToday, tallyStrokes, tallyWidth } from "./tally";

describe("the tally of tasks done today", () => {
  const at = (d: number, h: number) => new Date(2026, 10, d, h).toISOString();

  it("counts each task finished today once, and none from other days or not done", () => {
    const tasks = [
      { id: "a", done: true, doneAt: at(24, 9) },
      { id: "a", done: true, doneAt: at(24, 9) },
      { id: "b", done: true, doneAt: at(24, 23) },
      { id: "c", done: true, doneAt: at(23, 23) },
      { id: "d", done: false, doneAt: null },
      { id: "e", done: true, doneAt: null },
    ];
    expect(doneToday(tasks, "2026-11-24")).toBe(2);
    expect(doneToday(tasks, "2026-11-25")).toBe(0);
  });

  it("draws a stroke a mark, the fifth struck across the four", () => {
    expect(tallyStrokes(0)).toEqual([]);
    const seven = tallyStrokes(7);
    expect(seven).toHaveLength(7);
    // The fifth runs from low left to high right, across the group.
    const [x0, y0, , , x1, y1] = seven[4].match(/-?[\d.]+/g)!.map(Number);
    expect(x0).toBeLessThan(1);
    expect(x1).toBeGreaterThan(15);
    expect(y0).toBeGreaterThan(y1 + 6);
    // The sixth starts the next group, further right.
    expect(Number(seven[5].match(/^M(-?[\d.]+)/)![1])).toBeGreaterThan(20);
  });

  it("scrawls each stroke the same way every time", () => {
    expect(tallyStrokes(9)).toEqual(tallyStrokes(9));
    expect(tallyStrokes(9).slice(0, 4)).toEqual(tallyStrokes(4));
    expect(new Set(tallyStrokes(4)).size).toBe(4);
  });

  it("is as wide as its marks", () => {
    expect(tallyWidth(0)).toBe(0);
    expect(tallyWidth(1)).toBe(5);
    expect(tallyWidth(4)).toBe(17);
    expect(tallyWidth(5)).toBe(19);
    expect(tallyWidth(6)).toBe(27);
    expect(tallyWidth(10)).toBe(41);
  });
});
