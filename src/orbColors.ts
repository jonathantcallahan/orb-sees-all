/**
 * The mood colors each orb look casts around the app (the mist along the bottom), so the wisps
 * match whichever orb you've picked. Each runs calm → restless → stressed.
 */
import type { OrbLook } from "./components/PressureBlob";

export type Rgb = [number, number, number];

interface MoodPalette {
  /** Dense mist, blended into the page background. */
  deep: [Rgb, Rgb, Rgb];
  /** Thin wisps, mostly pale. */
  wisp: [Rgb, Rgb, Rgb];
}

const PALETTES: Record<OrbLook, MoodPalette> = {
  // The Glass core's cool ramp: cyan-blue, then blue-violet, then violet-magenta.
  glass: {
    deep: [
      [0.12, 0.45, 0.95],
      [0.3, 0.3, 0.9],
      [0.72, 0.26, 0.68],
    ],
    wisp: [
      [0.6, 0.88, 1.0],
      [0.72, 0.7, 1.0],
      [0.95, 0.66, 0.9],
    ],
  },
  // The Glass core's ramp, a little brighter through clear glass.
  crystal: {
    deep: [
      [0.15, 0.5, 0.98],
      [0.32, 0.34, 0.95],
      [0.75, 0.3, 0.72],
    ],
    wisp: [
      [0.65, 0.92, 1.0],
      [0.76, 0.74, 1.0],
      [0.98, 0.72, 0.9],
    ],
  },
  // Oren's mist is blue: clear sea blue, deepening toward indigo.
  film: {
    deep: [
      [0.1, 0.42, 0.95],
      [0.14, 0.34, 0.9],
      [0.28, 0.26, 0.85],
    ],
    wisp: [
      [0.55, 0.82, 1.0],
      [0.55, 0.74, 1.0],
      [0.66, 0.66, 1.0],
    ],
  },
  // Ophelia's mist is white: milky when calm, warming only faintly toward rose under stress.
  porcelain: {
    deep: [
      [1.0, 1.0, 1.0],
      [1.0, 0.98, 0.97],
      [1.0, 0.93, 0.92],
    ],
    wisp: [
      [1.0, 1.0, 1.0],
      [1.0, 0.99, 0.98],
      [1.0, 0.96, 0.95],
    ],
  },
};

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A palette's color at a stress level: calm to restless over the first half, restless to stressed over the second. */
function at(stops: [Rgb, Rgb, Rgb], stress: number): Rgb {
  return mix(mix(stops[0], stops[1], smooth(0, 0.5, stress)), stops[2], smooth(0.5, 1, stress));
}

export function mistColors(look: OrbLook, stress: number): { deep: Rgb; wisp: Rgb } {
  const p = PALETTES[look];
  return { deep: at(p.deep, stress), wisp: at(p.wisp, stress) };
}

export const toCss = (c: Rgb) => `rgb(${c.map((v) => Math.round(v * 255)).join(" ")})`;
