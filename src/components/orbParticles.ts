/**
 * The particles the orb gives off while it's working: small motes that appear only above the tips
 * of its waves, a clear gap off the surface, drifting outward and swirling a little as each one
 * pulses in and out of being. They read the look's own surface (orbSurface), so they follow its
 * waves exactly. uWorking (0 to 1) fades the whole effect in and out.
 */
import * as THREE from "three";
import { NOISE } from "./orbNoise";
import { FERRO, RIPPLE, type OrbUniforms } from "./orbEffects";

const COUNT = 4800;

/**
 * A look whose motes rise inside its glass rather than off its outside (Kitten's, off its cross):
 * the render layer they're drawn on, so the glass shows them bent, and their gap (see
 * buildParticles). They're against the glass rather than the page, so they keep their colors for a
 * dark page whatever the page is.
 */
export interface OrbMotes {
  layer: number;
  gap: [number, number];
  /** How much larger they are than the other looks' motes. */
  size: number;
  /** How much brighter, past white, so they stand out against the lit glass behind them. */
  boost: number;
}

const vertex = (surface: string) => /* glsl */ `
uniform float uTime;
uniform float uStress;
uniform float uWorking;
uniform float uPixelRatio;
uniform vec2 uTip;
uniform vec2 uGap;
uniform float uSize;
uniform float uLightPage;
attribute vec3 seed;
varying float vAlpha;
${NOISE}
${RIPPLE}
${FERRO}
${surface}
// Rotates v about a unit axis by angle a (Rodrigues).
vec3 turn(vec3 v, vec3 axis, float a) {
  return v * cos(a) + cross(axis, v) * sin(a) + axis * dot(axis, v) * (1.0 - cos(a));
}
void main() {
  vAlpha = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 0.0;
  if (uWorking < 0.01) return;

  // Each mote has its own lifecycle: it appears, drifts outward and fades, over a few seconds.
  float life = fract(uClock * (0.18 + 0.22 * seed.y) + seed.x);
  // A slow swirl around its own axis, so the motes curl rather than rise straight.
  vec3 axis = normalize(vec3(sin(seed.x * 37.0), cos(seed.y * 23.0), sin(seed.z * 19.0)));
  vec3 d = turn(normalize(position), axis, 0.12 * sin(uClock * 0.7 + seed.x * 6.2831) + 0.18 * life);

  float h = orbSurface(d);
#ifdef MOTE_WHERE
  // Where the look says (Ephedra's lightest areas), instead of its wave tips: how deep into one it
  // is, 0 at its edge to 1 in its middle. Each mote shows only once it's deeper in than a threshold
  // of its own, so the clouds thin out toward a light area's edges (fewer motes, not fainter ones)
  // and are fullest in its middle. Her clouds are sparse: about three motes in ten aren't hers at
  // all, left out before any of the work.
  if (fract(seed.y * 17.3 + seed.x * 5.1) < 0.3) return;
  float where = orbMoteWhere(d);
  float threshold = fract(seed.x * 13.1 + seed.z * 7.3);
  float tip = smoothstep(threshold, threshold + 0.08, where);
#else
  // Only above a wave's tip: where the surface stands higher than the surface around it.
  vec3 a = normalize(cross(d, abs(d.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(d, a);
  float around = 0.25 * (orbSurface(normalize(d + a * 0.14)) + orbSurface(normalize(d - a * 0.14)) + orbSurface(normalize(d + b * 0.14)) + orbSurface(normalize(d - b * 0.14)));
  float tip = smoothstep(uTip.x, uTip.y, h - around);
  float where = tip;
#endif

#ifdef MOTE_OSCILLATE
  // Ephedra's: a bump of motes over each light area, as if her surface rose there for a while. At
  // the area's edge they touch the surface; toward its middle they stand higher, smoothly, since
  // where eases in from the edge and out at the middle. The bump swells and settles on a slow beat
  // its neighbors share, so it keeps its shape as it moves, and each mote sits a little above or
  // below it, a haze of dots rather than a shell. So its top isn't one even line, about one mote in
  // ten pops up above it, a different few each life and some higher than others, rising and settling
  // back as it fades in and out.
  float swell = 0.4 + 0.6 * (0.5 + 0.5 * sin(uClock * 0.8 + dot(d, vec3(2.1, 1.3, 1.7)) * 1.6));
  float cycle = floor(uClock * (0.18 + 0.22 * seed.y) + seed.x);
  float pick = fract(sin(mod(cycle, 997.0) * 12.9898 + seed.z * 78.233) * 43758.5453);
  float pop = smoothstep(0.9, 1.0, pick) * sin(life * 3.14159);
  vec3 p = d * (h + uGap.x + uGap.y * where * (swell * (0.9 + 0.2 * seed.y) + 1.2 * pop));
#else
  // A clear gap off the surface, widening as the mote drifts out.
  vec3 p = d * (h + uGap.x + uGap.y * life);
#endif
  // In and out of being: a soft swell over its life, with a quicker flicker on top.
  float pulse = sin(life * 3.14159);
  pulse *= pulse * (0.65 + 0.35 * sin(uClock * 9.0 + seed.z * 40.0));
  vAlpha = tip * pulse * uWorking;
  if (vAlpha < 0.01) return;

  vec4 view = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * view;
  // A little larger on a light page, where a dark speck this small would read as faint gray.
  gl_PointSize = (1.4 + 1.4 * seed.z) * uSize * uPixelRatio * (0.7 + 0.3 * pulse) * (1.0 + 0.35 * uLightPage);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uBoost;
uniform float uLightPage;
varying float vAlpha;
void main() {
  // A soft round dot with a brighter center; on a light page, a deeper one instead (a white center
  // would vanish into the page) and more solid.
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  a = min(1.0, a * a * vAlpha * (1.0 + 0.8 * uLightPage));
  vec3 core = mix(vec3(1.0), uColor * 0.6, uLightPage);
  // Premultiplied, so the motes show over the orb and over a light or dark page alike.
  // Boosted past white inside glass, so they stand out against it.
  gl_FragColor = vec4(mix(uColor, core, 0.35 * (1.0 - r)) * a * uBoost, a);
}
`;

/**
 * The particle layer for a look: `surface` is its orbSurface GLSL, `color` its mote color, `tip`
 * how far (low, high) a point must stand above the surface around it to count as a wave tip, since
 * the looks' waves differ in depth, and `lightPage` 1 while the page is light (see FRAGMENT). In
 * `opts`: `gap`, how far off the surface a mote appears and how much farther it drifts over its life;
 * `size` and `boost`, how much larger and brighter the motes are than usual; `where`, that the
 * look's surface says where motes rise (its orbMoteWhere, 0 to 1) instead of its wave tips;
 * `oscillate`, that they make a bump over where they rise (gap: its base, and its height where
 * `where` is 1) that swells and settles, instead of drifting off.
 */
export function buildParticles(
  surface: string,
  uniforms: OrbUniforms & { uWorking: { value: number } },
  color: THREE.Color,
  pixelRatio: number,
  tip: [number, number],
  lightPage: { value: number },
  opts: { gap?: [number, number]; size?: number; boost?: number; where?: boolean; oscillate?: boolean } = {},
) {
  const gap = opts.gap ?? [0.14, 0.16];
  const positions = new Float32Array(COUNT * 3);
  const seeds = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    // Evenly spread directions (a Fibonacci sphere), each with its own random seed.
    const y = 1 - (2 * (i + 0.5)) / COUNT;
    const r = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    positions.set([Math.cos(phi) * r, y, Math.sin(phi) * r], i * 3);
    seeds.set([Math.random(), Math.random(), Math.random()], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 3));
  // The motes move in the shader; keep three from culling them by their resting box.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
  const material = new THREE.ShaderMaterial({
    defines: { ...(opts.where ? { MOTE_WHERE: "" } : {}), ...(opts.oscillate ? { MOTE_OSCILLATE: "" } : {}) },
    vertexShader: vertex(surface),
    fragmentShader: FRAGMENT,
    uniforms: { ...uniforms, uColor: { value: color }, uLightPage: lightPage, uPixelRatio: { value: pixelRatio }, uTip: { value: new THREE.Vector2(...tip) }, uGap: { value: new THREE.Vector2(...gap) }, uSize: { value: opts.size ?? 1 }, uBoost: { value: opts.boost ?? 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 5;
  return {
    points,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
