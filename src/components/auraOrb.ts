/**
 * Ephedra: an aura. A round, luminous orb with a second orb glowing inside it, soft pastel fields
 * (green, blue, pink, peach, yellow) drifting over both, light streaming out from a bright core,
 * and small dark specks that surface, drift a little and fade. A soft halo spills past its edge.
 *
 * - The outer orb is a sphere whose fields come from slowly flowing, domain-warped noise on its
 *   surface, so they turn with it.
 * - The inner orb is found per pixel by following the view ray into the outer one: where the ray
 *   meets the inner sphere, its own fields show (flowing the other way), and its rim, where the ray
 *   grazes it, glows as a soft yellow-white ring.
 * - The core and its rays are drawn around the orb's center as seen: a bright point and a few
 *   streaks of light reaching out toward the edge, flickering slowly.
 * - The specks live in cells on the surface: a few cells at a time carry one, which swells in,
 *   drifts and fades on its own beat.
 * - The halo is a camera-facing disc behind the orb.
 *
 * Calm, the fields are cool pastels; under stress they warm toward pink and peach and everything
 * moves faster. A finished task sends low, wide ripples across the surface, an update's hit swirls the
 * fields, an overdue task darkens and multiplies the specks, and while Orb works the rays brighten.
 */
import * as THREE from "three";
import { NOISE } from "./orbNoise";
import { FERRO, RIPPLE, type OrbUniforms } from "./orbEffects";

/** The orb's radius, about the other orbs' resting size. */
const RADIUS = 1.08;
/** The inner orb's radius, as a fraction of the outer. */
const INNER = 0.56;

/** The surface for the motes: round, with a gentle swell so they rise from its brighter patches. */
const SURFACE = /* glsl */ `
float orbSurface(vec3 n) {
  return ${RADIUS.toFixed(3)} + 0.05 * snoise(normalize(n) * 1.8 + uTime * 0.1);
}
`;

/** Pastel fields, shared by the outer and inner orbs: a soft color for a point and a time. */
const FIELDS = /* glsl */ `
vec3 pastel(float x, float warm) {
  // Cool calm palette and a warmer stressed one, each a loop of soft colors.
  vec3 green = mix(vec3(0.62, 0.90, 0.62), vec3(0.95, 0.80, 0.52), warm);
  vec3 blue = mix(vec3(0.60, 0.80, 0.98), vec3(0.88, 0.66, 0.90), warm);
  vec3 pink = mix(vec3(0.98, 0.70, 0.84), vec3(1.00, 0.56, 0.64), warm);
  vec3 peach = mix(vec3(1.00, 0.82, 0.68), vec3(1.00, 0.68, 0.50), warm);
  vec3 yellow = mix(vec3(0.98, 0.94, 0.58), vec3(1.00, 0.82, 0.46), warm);
  x = fract(x) * 5.0;
  if (x < 1.0) return mix(green, blue, smoothstep(0.0, 1.0, x));
  if (x < 2.0) return mix(blue, pink, smoothstep(0.0, 1.0, x - 1.0));
  if (x < 3.0) return mix(pink, peach, smoothstep(0.0, 1.0, x - 2.0));
  if (x < 4.0) return mix(peach, yellow, smoothstep(0.0, 1.0, x - 3.0));
  return mix(yellow, green, smoothstep(0.0, 1.0, x - 4.0));
}
// The fields at a point: domain-warped noise picks a place on the palette, and how strongly that
// color shows (the rest is milky white).
vec4 field(vec3 p, float t, float seed) {
  // Gently warped and low in frequency, so the colors read as soft washes rather than marbling.
  vec3 w = p + 0.3 * vec3(snoise(p * 0.8 + vec3(seed, t * 0.12, 0.0)), snoise(p * 0.8 + vec3(t * 0.1, seed + 3.7, 1.3)), snoise(p * 0.8 + vec3(2.1, 0.0, seed - t * 0.11)));
  float hue = 0.5 + 0.5 * snoise(w * 0.5 + seed * 1.3 + t * 0.05);
  float strength = smoothstep(-0.8, 0.6, snoise(w * 0.6 + seed * 2.9 - t * 0.07));
  return vec4(pastel(hue * 1.2 + seed * 0.21, smoothstep(0.1, 1.0, uStress)), strength);
}
`;

/**
 * A finished task's ripple on Ephedra: low, wide rings spreading from where it began, like a stone
 * dropped in still water. Unlike the shared ripple it's broad and gentle, and it moves the surface
 * and bends the fields rather than lighting them. Needs RIPPLE (its uniforms) included before it.
 */
const SWELL = /* glsl */ `
// The rings' height at an arc distance from the origin, -1 to 1, fading as they spread.
float swellAt(float angle) {
  float behind = uRippleAge * 0.75 - angle;
  if (behind <= 0.0 || uRippleAge > 8.0) return 0.0;
  return sin(behind * 5.5) * smoothstep(0.0, 0.5, behind) * (1.0 - smoothstep(1.4, 3.2, behind)) * exp(-uRippleAge * 0.55);
}
float swellAngle(vec3 n) {
  return 2.0 * asin(clamp(length(normalize(n) - uRippleOrigin) * 0.5, 0.0, 1.0));
}
`;

const BODY_VERTEX = /* glsl */ `
${RIPPLE}
${SWELL}
varying vec3 vObj;
varying vec3 vEyeObj;
varying vec3 vView;
varying vec3 vCenter;
varying vec3 vNormal;
void main() {
  vObj = position;
  vEyeObj = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  // A finished task's rings lift the surface a little.
  vec3 moved = position * (1.0 + 0.03 * swellAt(swellAngle(position)));
  vec4 view = modelViewMatrix * vec4(moved, 1.0);
  vView = view.xyz;
  vCenter = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * view;
}
`;

const BODY_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uStress;
uniform float uWorking;
varying vec3 vObj;
varying vec3 vEyeObj;
varying vec3 vView;
varying vec3 vCenter;
varying vec3 vNormal;
${NOISE}
${RIPPLE}
${SWELL}
${FERRO}
${FIELDS}

const float R = ${RADIUS.toFixed(3)};
const float RI = ${(RADIUS * INNER).toFixed(3)};

float hash1(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}

// The dark specks on the surface at n: a few cells at a time carry one, which swells in, drifts
// and fades on its own beat. More of them, and darker, while an overdue task agitates the orb.
float specks(vec3 n) {
  vec3 p = n * 7.0;
  vec3 i = floor(p);
  vec3 f = fract(p);
  float s = 0.0;
  float share = mix(0.22, 0.5, uSpike);
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
      for (int z = -1; z <= 1; z++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 h = hash3(i + g);
        if (h.x > share) continue;
        float life = fract(uClock * (0.05 + 0.07 * h.y) + h.z);
        float show = sin(life * 3.14159);
        // Drifts a little across its life.
        vec3 at = g + 0.2 + 0.6 * h + 0.25 * vec3(sin(life * 3.0 + h.y * 6.0), cos(life * 2.0 + h.z * 6.0), sin(life * 2.5)) - f;
        float size = mix(0.06, 0.13, h.y) * show;
        s = max(s, smoothstep(size, size * 0.35, length(at)) * show);
      }
  return s;
}

void main() {
  float t = uTime * mix(0.5, 1.4, uStress);
  vec3 V = normalize(-vView);
  vec3 N = normalize(vNormal);
  float facing = clamp(dot(N, V), 0.0, 1.0);
  vec3 n = normalize(vObj);
  // An update's hit swirls the fields along it.
  vec3 p = n + 0.25 * shock(n) * vec3(n.y, -n.x, 0.0);
  // A finished task's rings bend the fields outward from where they began, like light through water.
  float ringAngle = swellAngle(n);
  float ring = swellAt(ringAngle);
  float ringSlope = (swellAt(ringAngle + 0.03) - ring) / 0.03;
  vec3 away = normalize(n - uRippleOrigin * dot(n, uRippleOrigin) + 1e-4);
  p += away * ring * 0.12;

  // The outer orb: milky white with pastel fields drifting over it.
  vec4 outer = field(p * 1.2, t, 0.0);
  vec3 col = mix(vec3(0.9, 0.91, 0.93), outer.rgb, 0.85 * outer.a);

  // The inner orb, seen through the outer: where the view ray meets it, and its glowing rim.
  vec3 ro = vObj;
  vec3 rd = normalize(vObj - vEyeObj);
  float b = dot(ro, rd);
  float c = dot(ro, ro) - RI * RI;
  float disc = b * b - c;
  if (disc > 0.0) {
    float tHit = -b - sqrt(disc);
    vec3 q = ro + rd * tHit;
    vec3 nq = normalize(q);
    float graze = 1.0 - abs(dot(nq, rd));
    vec4 inner = field(nq * 1.6, -t * 0.8, 4.0);
    col = mix(col, mix(vec3(0.95, 0.94, 0.9), inner.rgb, 0.85 * inner.a), 0.4);
    // Its rim: a soft yellow-white ring.
    col = mix(col, vec3(1.0, 0.96, 0.72), pow(graze, 4.0) * 0.6);
  }

  // The core and its rays, around the center as seen.
  vec2 d = (vView.xy - vCenter.xy) / R;
  float r = length(d);
  float ang = atan(d.y, d.x);
  float core = exp(-r * r * 60.0) * 0.9 + exp(-r * r * 12.0) * 0.25;
  float beams = pow(max(snoise(vec3(ang * 2.2, t * 0.35, 1.0)), 0.0), 2.0) * 0.6;
  float streaks = pow(abs(sin(ang * 9.0 + snoise(vec3(ang * 1.5, t * 0.25, 7.0)) * 2.0)), 36.0);
  float rays = (beams + streaks * 0.8) * smoothstep(1.0, 0.1, r) * smoothstep(0.0, 0.12, r) * (0.55 + 0.45 * uWorking);
  col = mix(col, vec3(1.0, 0.99, 0.95), clamp(core + rays * 0.45, 0.0, 1.0));
  // A few bright points near the middle.
  float sparkle = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    vec2 sp = 0.32 * vec2(sin(t * 0.21 + fk * 2.1), cos(t * 0.17 + fk * 1.7)) * (0.4 + 0.3 * fk);
    sparkle += exp(-dot(d - sp, d - sp) * 900.0) * (0.6 + 0.4 * sin(uClock * 2.0 + fk * 3.0));
  }
  col += vec3(1.0) * sparkle;

  // The rings' slopes catch a little shade and light, so they read as relief, not a glow.
  col *= 1.0 - clamp(ringSlope * 0.06, -0.14, 0.14);

  // The dark specks, on the surface.
  col = mix(col, vec3(0.5, 0.16, 0.22), specks(n) * mix(0.6, 0.85, uSpike));

  // Its edge: brightening toward a cool white glow, then softly gone.
  float rim = pow(1.0 - facing, 2.5);
  col = mix(col, vec3(0.9, 0.96, 1.0), rim * 0.7);
  float alpha = smoothstep(0.0, 0.22, facing);
  gl_FragColor = vec4(min(col, vec3(1.0)), alpha);
}
`;

/** The halo: a camera-facing disc behind the orb, a soft pastel glow past its edge. */
const HALO_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy;
  vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  gl_Position = projectionMatrix * (center + vec4(position.xy, 0.0, 0.0));
}
`;

const HALO_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uStress;
varying vec2 vUv;
const float R = ${RADIUS.toFixed(3)};
void main() {
  float r = length(vUv) / R;
  float ang = atan(vUv.y, vUv.x);
  float glow = exp(-max(r - 0.92, 0.0) * 5.5) * smoothstep(0.85, 0.98, r);
  vec3 cool = mix(vec3(0.82, 0.93, 1.0), vec3(0.95, 0.86, 1.0), 0.5 + 0.5 * sin(ang * 2.0 + uTime * 0.15));
  vec3 warm = vec3(1.0, 0.84, 0.86);
  gl_FragColor = vec4(mix(cool, warm, uStress * 0.6), glow * 0.55);
}
`;

export function buildAuraOrb(uniforms: OrbUniforms) {
  const group = new THREE.Group();
  const shared = { ...uniforms };

  const haloGeometry = new THREE.PlaneGeometry(RADIUS * 3.6, RADIUS * 3.6);
  const haloMaterial = new THREE.ShaderMaterial({
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT,
    uniforms: shared,
    transparent: true,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(haloGeometry, haloMaterial);
  halo.renderOrder = -1;
  halo.frustumCulled = false;
  group.add(halo);

  const bodyGeometry = new THREE.SphereGeometry(RADIUS, 96, 64);
  const bodyMaterial = new THREE.ShaderMaterial({
    vertexShader: BODY_VERTEX,
    fragmentShader: BODY_FRAGMENT,
    uniforms: shared,
    transparent: true,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(bodyGeometry, bodyMaterial));

  return {
    group,
    surface: SURFACE,
    dispose: () => {
      haloGeometry.dispose();
      haloMaterial.dispose();
      bodyGeometry.dispose();
      bodyMaterial.dispose();
    },
  };
}
