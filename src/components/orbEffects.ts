/**
 * Surface effects every orb look shares in its vertex shader: the ripple a finished task sends
 * across it, and the ferrofluid spikes it grows toward the cursor over an overdue task.
 */

/** Three rings spreading from a point, fading as they travel. */
export const RIPPLE = /* glsl */ `
uniform float uRippleAge;
uniform vec3 uRippleOrigin;
// Height of the ripple at a surface direction: rings spreading out from uRippleOrigin, about three
// crests deep, fading away over about three seconds. Zero when no ripple is running.
float ripple(vec3 n) {
  // Arc distance from the origin, from the chord: unlike acos it's smooth at the origin itself,
  // so the surface there doesn't pinch into a starburst.
  float angle = 2.0 * asin(clamp(length(normalize(n) - uRippleOrigin) * 0.5, 0.0, 1.0));
  // How far behind the leading ring this point is, in radians of arc.
  float behind = uRippleAge * 1.2 - angle;
  if (behind <= 0.0) return 0.0;
  float rings = sin(behind * 9.0) * smoothstep(0.0, 0.2, behind) * (1.0 - smoothstep(1.2, 2.1, behind));
  return rings * exp(-uRippleAge * 0.8);
}
`;

/**
 * Ferrofluid spikes: sharp cones rising on the side facing uSpikeDir, like ferrofluid reaching for
 * a magnet. Each spike sits on a point (from cellular noise on the sphere) that wanders over time,
 * so they rearrange; overlapping cones merge into one taller spike rather than the nearer one
 * winning, so spikes that drift together combine; and a slow noise field gathers them into
 * clusters that move across the surface. Each twitches on its own fast beat: the chittering.
 * uSpike (0 to 1) grows them in and out. Needs NOISE (snoise) included before it.
 */
export const FERRO = /* glsl */ `
uniform float uSpike;
uniform vec3 uSpikeDir;
uniform float uClock;
vec3 ferroHash(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}
// The spikes around p, blended: each nearby cell's spike point wanders on its own slow orbit, and
// their cones combine (root of the sum of squares), so close spikes fuse into a taller one.
float ferroField(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float sum = 0.0;
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
      for (int z = -1; z <= 1; z++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 h = ferroHash(i + g);
        vec3 wander = 0.5 + 0.4 * sin(uClock * (0.5 + h.yzx * 0.7) + h * 6.2831);
        vec3 r = g + wander - f;
        float d = length(r);
        // A spike swells out of the surface: a broad mound that meets it at a tangent (no edge,
        // no crease), rising into a narrower cone with a sharp tip, so it reads as grown from the
        // surface rather than pushed out from inside.
        float s = clamp(d / 0.62, 0.0, 1.0);
        float mound = (1.0 - s * s) * (1.0 - s * s);
        float tip = pow(clamp(1.0 - d / 0.34, 0.0, 1.0), 1.5);
        float cone = 0.42 * mound + 0.58 * tip;
        // Each spike twitches on its own beat.
        float beat = dot(i + g, vec3(12.9, 78.2, 37.7));
        cone *= 0.72 + 0.28 * sin(uClock * 41.0 + beat) * sin(uClock * 17.0 + beat * 1.7);
        sum += cone * cone;
      }
  return sqrt(sum);
}
// Height of the spikes at a surface direction, 0 to about 1.
float ferro(vec3 n) {
  if (uSpike <= 0.001) return 0.0;
  n = normalize(n);
  // Rising toward the cursor, flat on the far side.
  float facing = smoothstep(-0.15, 0.8, dot(n, uSpikeDir));
  // Clusters: a slow field that crowds spikes together in drifting patches and thins them between.
  float crowd = smoothstep(-0.35, 0.45, snoise(n * 1.6 + vec3(0.0, uClock * 0.25, uClock * 0.18)));
  return min(ferroField(n * 6.5), 1.3) * facing * mix(0.25, 1.0, crowd) * uSpike;
}
`;

/** The uniforms every orb look shares with the animation loop. (A type, not an interface, so it fits three's uniforms map.) */
export type OrbUniforms = {
  uTime: { value: number };
  uStress: { value: number };
  /** Seconds since the latest ripple began; NO_RIPPLE when none is running. */
  uRippleAge: { value: number };
  /** Where on the surface (a unit direction) the latest ripple began. */
  uRippleOrigin: { value: import("three").Vector3 };
  /** How far the ferrofluid spikes have grown in, 0 to 1. */
  uSpike: { value: number };
  /** Which way (a unit direction in the orb's own space) the spikes point: toward the cursor. */
  uSpikeDir: { value: import("three").Vector3 };
  /** Real seconds, unaffected by stress or reduced motion, for the chittering. */
  uClock: { value: number };
};

/** Long enough ago that no ripple shows. */
export const NO_RIPPLE = 1e3;
