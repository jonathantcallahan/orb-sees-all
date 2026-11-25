import { useEffect, useId, useRef } from "react";

/**
 * The lamp in its 240×285 box: a rice paper egg like a Noguchi Akari. It's drawn
 * from the 1A: 43cm by 25–26cm, its shade about 1.44 times as tall as it's wide, a little wider below
 * its middle than above, its sides full. Its washi (mulberry-bark paper) is glued in strips to both
 * sides of fine bamboo ribs (0.6–0.7mm, wound closely around the form), held at each end by a ring.
 */
const CX = 120;
const CY = 152;
const RX = 74;
const RY = 106;
const TOP = CY - RY;
const BOTTOM = CY + RY;
/** How much wider the egg is below its middle than above it, and how full its sides are (1 is an ellipse). */
const EGG = 0.07;
const FULL = 0.8;
/** One turn (four minutes): very slow. Its bob, 2.5 up and down every 9s, is .paper-lamp-body's lamp-bob. */
const SPIN_MS = 240_000;
/** The washi strips around it, whose seams show the turn. */
const STRIPS = 8;
/**
 * How often its seams are drawn again as it turns: ten times a second. A turn that slow moves them a
 * fraction of a pixel between, so drawing them every frame would only cost the machine.
 */
const DRAW_EVERY_MS = 100;

/** The egg's half width at a height, from its top (TOP) to its bottom (BOTTOM). */
function halfWidth(y: number): number {
  const c = Math.max(-1, Math.min(1, (CY - y) / RY));
  return RX * Math.pow(Math.sqrt(1 - c * c), FULL) * (1 - EGG * c);
}

/** The egg's outline, down its right side and back up its left. */
const OUTLINE = (() => {
  const steps = 96;
  const right: string[] = [];
  const left: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const y = TOP + ((BOTTOM - TOP) * i) / steps;
    const w = halfWidth(y);
    right.push(`${(CX + w).toFixed(2)} ${y.toFixed(2)}`);
    left.unshift(`${(CX - w).toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${right.join("L")}L${left.join("L")}Z`;
})();

/**
 * The ribs, showing through the lit paper as fine shadows: close rings around the egg, seen from
 * level with its middle, so those above bow up a little and those below bow down.
 */
const RIBS = Array.from({ length: 32 }, (_, i) => {
  const y = TOP + 8 + i * ((BOTTOM - TOP - 16) / 31);
  const half = halfWidth(y);
  const bow = (y - CY) * 0.09;
  return `M${(CX - half).toFixed(1)} ${y.toFixed(1)}Q${CX} ${(y + bow).toFixed(1)} ${(CX + half).toFixed(1)} ${y.toFixed(1)}`;
});

/** The paper over its top and bottom rings, just inside the egg's ends. */
const rim = (y: number) => {
  const half = halfWidth(y);
  const bow = (y - CY) * 0.09;
  return `M${(CX - half).toFixed(1)} ${y.toFixed(1)}Q${CX} ${(y + bow).toFixed(1)} ${(CX + half).toFixed(1)} ${y.toFixed(1)}`;
};
const RIM_TOP = rim(TOP + 3);
const RIM_BOTTOM = rim(BOTTOM - 3);

/**
 * A seam between washi strips at an angle around the egg (0 facing you): a line from its top ring to its
 * bottom one, where the strips overlap, and how strongly it shows: most facing you, fading toward the
 * edges, and faintly through the paper when it's on the far side.
 */
function seam(angle: number): { d: string; opacity: number } {
  const s = Math.sin(angle);
  const facing = Math.cos(angle);
  const points: string[] = [];
  for (let y = TOP + 4; y <= BOTTOM - 4; y += 6) points.push(`${(CX + halfWidth(y) * s).toFixed(3)} ${y.toFixed(2)}`);
  return { d: `M${points.join("L")}`, opacity: facing > 0 ? 0.05 + 0.09 * facing : 0.035 * -facing };
}

/**
 * What the Today column shows in the orb's place while the Updates area's painting hangs: a rice paper
 * lamp, glowing warm white, turning and bobbing very slowly (still, with reduced
 * motion). Its light on the wall is LampGlow, behind the whole layout.
 *
 * Drawn in layers so that moving it costs next to nothing, and it moves smoothly: the lamp bobs by a CSS
 * animation, which moves its painted layer without painting it again (the paper's blurred bloom is
 * costly to paint); and only its seams and ribs, on a layer of their own, are drawn again as it turns.
 */
export function PaperLamp() {
  const id = useId().replace(/:/g, "");
  const seams = useRef<(SVGPathElement | null)[]>([]);

  // Turned ten times a second (see DRAW_EVERY_MS); held still where motion is reduced.
  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let frame = 0;
    let drawn = -Infinity;
    const draw = (now: number) => {
      if (!still) frame = requestAnimationFrame(draw);
      if (now - drawn < DRAW_EVERY_MS) return;
      drawn = now;
      const t = still ? 0 : now - start;
      const turn = (t / SPIN_MS) * 2 * Math.PI;
      seams.current.forEach((el, i) => {
        if (!el) return;
        const { d, opacity } = seam(turn + (i * 2 * Math.PI) / STRIPS + 0.3);
        el.setAttribute("d", d);
        el.setAttribute("stroke-opacity", opacity.toFixed(3));
      });
    };
    draw(start);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="paper-lamp" aria-hidden>
      <div className="paper-lamp-body">
        {/* The paper and its bloom, painted once. */}
        <svg viewBox="0 0 240 285" preserveAspectRatio="xMidYMid meet">
          <defs>
            {/* The paper, lit from the bulb at its middle: near white there, cream toward its edges. */}
            <radialGradient id={`${id}-paper`} cx="50%" cy="52%" r="58%">
              <stop offset="0" stopColor="#fffdf5" />
              <stop offset="0.4" stopColor="#fbf0d9" />
              <stop offset="0.8" stopColor="#efdbb7" />
              <stop offset="1" stopColor="#dcc199" />
            </radialGradient>
            <filter id={`${id}-bloom`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="8" />
            </filter>
          </defs>
          {/* A faint bloom of light just around the paper, a little low, toward its open bottom. */}
          <path d={OUTLINE} fill="#ffd79a" opacity={0.2} filter={`url(#${id}-bloom)`} transform="translate(0 6)" />
          <path d={OUTLINE} fill={`url(#${id}-paper)`} />
        </svg>
        {/* Its lines, drawn again as it turns. */}
        <svg className="paper-lamp-lines" viewBox="0 0 240 285" preserveAspectRatio="xMidYMid meet">
          {/* The seams between its washi strips, which turn with it. */}
          <g fill="none" stroke="#a88d66" strokeWidth={1.2}>
            {Array.from({ length: STRIPS }, (_, i) => (
              <path
                key={i}
                ref={(el) => {
                  seams.current[i] = el;
                }}
              />
            ))}
          </g>
          <g fill="none" stroke="#8f7a5c" strokeOpacity={0.3} strokeWidth={0.6}>
            {RIBS.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
          {/* The rings at its top and bottom, wrapped in the paper: where it folds over them, a band a
              little denser than the rest, following the egg's curve like a rib. */}
          <g fill="none" stroke="#8f7a5c" strokeOpacity={0.22} strokeWidth={2.2}>
            <path d={RIM_TOP} />
            <path d={RIM_BOTTOM} />
          </g>
        </svg>
      </div>
    </div>
  );
}

/**
 * The lamp's light on the wall, in place of the orb's glow: a wide, soft pool, falling a little below
 * and to the right of the lamp, as from a lamp hung well out from the wall, breathing slowly. Behind
 * the whole layout, so no column's edge cuts it off.
 */
export function LampGlow() {
  return <div className="lamp-glow" aria-hidden />;
}
