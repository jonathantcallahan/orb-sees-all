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

const vertex = (surface: string) => /* glsl */ `
uniform float uTime;
uniform float uStress;
uniform float uWorking;
uniform float uPixelRatio;
uniform vec2 uTip;
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

  // Only above a wave's tip: where the surface stands higher than the surface around it.
  float h = orbSurface(d);
  vec3 a = normalize(cross(d, abs(d.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(d, a);
  float around = 0.25 * (orbSurface(normalize(d + a * 0.14)) + orbSurface(normalize(d - a * 0.14)) + orbSurface(normalize(d + b * 0.14)) + orbSurface(normalize(d - b * 0.14)));
  float tip = smoothstep(uTip.x, uTip.y, h - around);

  // A clear gap off the surface, widening as the mote drifts out.
  vec3 p = d * (h + 0.14 + 0.16 * life);
  // In and out of being: a soft swell over its life, with a quicker flicker on top.
  float pulse = sin(life * 3.14159);
  pulse *= pulse * (0.65 + 0.35 * sin(uClock * 9.0 + seed.z * 40.0));
  vAlpha = tip * pulse * uWorking;
  if (vAlpha < 0.01) return;

  vec4 view = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * view;
  gl_PointSize = (1.4 + 1.4 * seed.z) * uPixelRatio * (0.7 + 0.3 * pulse);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  // A soft round dot with a brighter center.
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  a *= a * vAlpha;
  // Premultiplied, so the motes show over the orb and over a light or dark page alike.
  gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.35 * (1.0 - r)) * a, a);
}
`;

/**
 * The particle layer for a look: `surface` is its orbSurface GLSL, `color` its mote color, and `tip`
 * how far (low, high) a point must stand above the surface around it to count as a wave tip, since
 * the looks' waves differ in depth.
 */
export function buildParticles(
  surface: string,
  uniforms: OrbUniforms & { uWorking: { value: number } },
  color: THREE.Color,
  pixelRatio: number,
  tip: [number, number],
) {
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
    vertexShader: vertex(surface),
    fragmentShader: FRAGMENT,
    uniforms: { ...uniforms, uColor: { value: color }, uPixelRatio: { value: pixelRatio }, uTip: { value: new THREE.Vector2(...tip) } },
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
