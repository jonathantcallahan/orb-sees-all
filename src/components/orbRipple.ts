/**
 * The ripple the orb sends across its surface when a task is done: three rings spreading from a
 * point, fading as they travel. Shared by every orb look's vertex shader.
 */
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

/** The uniforms every orb look shares with the animation loop. (A type, not an interface, so it fits three's uniforms map.) */
export type OrbUniforms = {
  uTime: { value: number };
  uStress: { value: number };
  /** Seconds since the latest ripple began; NO_RIPPLE when none is running. */
  uRippleAge: { value: number };
  /** Where on the surface (a unit direction) the latest ripple began. */
  uRippleOrigin: { value: import("three").Vector3 };
};

/** Long enough ago that no ripple shows. */
export const NO_RIPPLE = 1e3;
