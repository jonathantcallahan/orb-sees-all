/**
 * Penelope: a blob of mostly clear frosted glass with faint pools of dye laid into it (a
 * green-yellow, peach-pink, the faintest baby blue), like a cast glass panel with color floating
 * in it. Her shape is her own: a few large, smooth lobes (see SURFACE).
 *
 * It's drawn as a volume, not a surface: each pixel follows its ray into the glass and adds up what
 * happens along the way. It's solid: nothing behind it shows through; the light inside is simulated.
 *
 * - Each pool's dye absorbs some colors more than others (Beer–Lambert, a separate rate per
 *   channel), and scatters light in its own color, so thin dye reads pastel and a dense middle
 *   saturated. Under stress each pool runs warmer: green-yellow to yellow, peach-pink to rose, blue to
 *   lavender.
 * - The glass itself is nearly clear and a little milky, so it reads cool white between the pools.
 * - Light comes in mostly from above and behind.
 * - The frost: the ray is bent a little at the surface by a fine, fixed grain (it turns with the
 *   blob rather than shimmering), what lies deeper is seen more spread out, and the surface's own
 *   reflection is broad and soft. A thin cool line marks the outline, as on a cut glass edge.
 *
 * Inside, the dye reacts too: a finished task sends a pulse of light out from the middle, an update
 * read sloshes the pools along the hit, an overdue task makes them tighten and flicker, and stress
 * makes them churn faster.
 */
import * as THREE from "three";
import { NOISE } from "./orbNoise";
import { FERRO, RIPPLE, type OrbUniforms } from "./orbEffects";
import { SHELL_NORMAL } from "./glassOrb";

/** The dye cloud's size is measured against this: about the blob's resting radius. */
const SIZE = 1.1;
/**
 * Penelope's own shape: a body with a few large, smooth, rounded lobes swelling out of it, rather
 * than the glass orbs' many small folds. Four lobes, each a broad dome on the sphere, drift slowly
 * over it and swell and shrink on their own beats; they may reach well out from the body. Stress
 * makes them bigger and livelier. The shared effects (a finished task's ripple, an update's hit and
 * the ferrofluid spikes) work as on every orb. Read by the vertex shader and the motes (orbSurface).
 */
const SURFACE = /* glsl */ `
const vec3 LOBE_HOME[4] = vec3[4](vec3(0.7, 0.55, 0.3), vec3(-0.65, 0.2, 0.55), vec3(0.1, -0.8, -0.35), vec3(-0.2, 0.45, -0.85));
float shellRadius(vec3 n, float t) {
  float r = 0.84;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    // Each lobe wanders around its home, slowly.
    vec3 d = normalize(LOBE_HOME[i] + 0.45 * vec3(sin(t * 0.21 + fi * 1.7), sin(t * 0.17 + fi * 2.9), sin(t * 0.19 + fi * 4.1)));
    // A broad dome: smooth all the way down to the body, no edge or crease.
    float dome = exp((dot(n, d) - 1.0) * 4.2);
    float size = mix(0.46, 0.62, uStress) * (0.75 + 0.25 * sin(t * 0.33 + fi * 2.3));
    r += size * dome;
  }
  return (r + 0.14 * ripple(n) + 0.1 * shock(n) + 0.6 * ferro(n)) * squash(n);
}
float orbSurface(vec3 n) {
  return shellRadius(normalize(n), uTime * mix(0.32, 1.0, uStress));
}
`;

/** The shape for the vertex shader: uniforms, the shared effects, Penelope's surface, and a point on it. */
const SHAPE = /* glsl */ `
uniform float uTime;
uniform float uStress;
${NOISE}
${RIPPLE}
${FERRO}
${SURFACE}
vec3 shellPoint(vec3 n, float t) {
  n = normalize(n);
  return n * shellRadius(n, t);
}
`;

const VERTEX = /* glsl */ `
${SHAPE}
varying vec3 vObj;
varying vec3 vNormalObj;
varying vec3 vEye;
void main() {
  ${SHELL_NORMAL}
  vObj = shellPos;
  vNormalObj = objectNormal;
  // The camera in the blob's own space, so the ray can be followed through it.
  vEye = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(shellPos, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uStress;
uniform float uWorking;
uniform mat3 uViewToObj;
varying vec3 vObj;
varying vec3 vNormalObj;
varying vec3 vEye;
${NOISE}
${RIPPLE}
${FERRO}

const float H = ${SIZE.toFixed(3)};
const float IOR = 1.49; // cast acrylic

// How far a ray from inside goes before it leaves. The molten surface is close enough to a sphere
// through the point where the ray came in (radius rad) for the soft cloud inside.
float exitDistance(vec3 o, vec3 d, float rad) {
  float b = dot(o, d);
  return max(-b + sqrt(max(b * b - dot(o, o) + rad * rad, 0.0)), 0.0);
}

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// The pools of dye drifting in the glass, each its own color: a green-yellow, a faint
// peach-pink and the faintest baby blue, the way color is laid into a cast glass panel, with most
// of the glass left clear. All three drift slowly, slosh together along the hit of an update read,
// and shift warmer under stress.
const int CLOUDS = 3;
// Where each pool sits at rest, in the blob's own space: yellow high on one side, peach-pink low
// across from it, blue faint at the top of the other side.
const vec3 HOME[3] = vec3[3](vec3(0.4, 0.38, 0.16), vec3(-0.28, -0.44, 0.12), vec3(-0.44, 0.44, -0.16));
// Their sizes (as fractions of the blob's radius) and how dense each is: the yellow strongest,
// the peach-pink faint, the blue fainter still.
const float SIZE_OF[3] = float[3](0.14, 0.18, 0.16);
const float DENSITY[3] = float[3](3.2, 0.7, 0.4);

vec3 cloudCenter(int i) {
  float t = uTime * mix(0.25, 0.8, uStress) + float(i) * 2.1;
  vec3 drift = 0.07 * vec3(sin(t * 0.7), sin(t * 0.53 + 1.7), sin(t * 0.61 + 3.1));
  float slosh = uShockAge < 5.0 ? sin(uShockAge * 5.0) * exp(-uShockAge * 1.6) * smoothstep(0.0, 0.15, uShockAge) : 0.0;
  return HOME[i] + drift + uShockDir * (0.22 * slosh + 0.5 * uSquash);
}
// How each pool's dye absorbs, per channel (Beer–Lambert): what it lets through is its color. Calm,
// then stressed, when each runs warmer: green-yellow to a full yellow (never orange), peach-pink
// to rose, blue to lavender.
vec3 cloudAbsorb(int i, float s) {
  if (i == 0) return mix(vec3(0.55, 0.02, 2.6), vec3(0.2, 0.12, 2.8), s);
  if (i == 1) return mix(vec3(0.02, 0.35, 0.4), vec3(0.04, 1.6, 0.9), s);
  return mix(vec3(0.4, 0.2, 0.06), vec3(0.4, 0.7, 0.05), s);
}
// The color each pool scatters, so it glows rather than only staining.
vec3 cloudPigment(int i, float s) {
  if (i == 0) return mix(vec3(0.7, 1.0, 0.16), vec3(0.92, 0.95, 0.1), s);
  if (i == 1) return mix(vec3(1.0, 0.8, 0.76), vec3(1.0, 0.5, 0.58), s);
  return mix(vec3(0.8, 0.9, 1.0), vec3(0.78, 0.72, 1.0), s);
}

// How much of a pool's dye is at q (already offset by the wandering outline): a soft cloud. depth is
// how far behind the frosted surface q is: the frost spreads what's seen through it wider the deeper
// it lies, so the cloud is seen widened by that much (keeping the same amount of dye across its
// width), which keeps each pool a soft glow rather than a ball behind a window.
float cloud(vec3 q, vec3 c, float sigma, float depth) {
  float spread = 0.16 * depth;
  float s2 = sigma * sigma + spread * spread;
  vec3 d = q - c;
  return exp(-dot(d, d) / (2.0 * s2)) * (sigma * sigma / s2);
}

// The wandering outline the pools share: low noise, churning harder under stress.
vec3 wander(vec3 p) {
  float t = uTime * mix(0.2, 0.75, uStress);
  return 0.1 * vec3(snoise(p * 1.3 + t * 0.4), snoise(p * 1.3 + 4.1 - t * 0.3), snoise(p * 1.3 + 8.7 + t * 0.35));
}

void main() {
  vec3 eye = vEye;
  vec3 dir = normalize(vObj - eye);

  vec3 p = vObj;
  vec3 n = normalize(vNormalObj);
  if (dot(n, dir) > 0.0) n = -n;
  // Where a fold of the surface sits inside the resting radius, the ray still crosses the whole
  // body behind it, so measure from no less than that.
  float rad = max(length(p), H);
  vec3 v = -dir;
  float nv = clamp(dot(n, v), 0.0, 1.0);

  // The frost: a fine grain fixed to the surface bends each ray a little on the way in.
  vec3 g = vec3(hash3(p * 211.0), hash3(p * 211.0 + 17.0), hash3(p * 211.0 + 41.0)) - 0.5;
  vec3 nFrost = normalize(n + g * 0.22);
  vec3 rd = refract(dir, nFrost, 1.0 / IOR);
  if (dot(rd, rd) < 0.01) rd = dir;
  vec3 ro = p - n * 0.002;

  // Light, in the blob's space: the room's key light comes from above and behind the viewer's left.
  vec3 keyDir = normalize(uViewToObj * vec3(-0.35, 0.85, 0.4));
  vec3 backDir = normalize(uViewToObj * vec3(0.2, 0.3, -1.0));

  // The pools: where they are, how big, and their colors at this stress.
  float warm = smoothstep(0.1, 0.95, uStress);
  // An overdue task: the pools draw in tight and flicker. While Orb works they breathe slowly.
  float flicker = 1.0 + uSpike * 0.35 * sin(uClock * 31.0) * sin(uClock * 13.0);
  float shrink = (1.0 - 0.28 * uSpike) * (1.0 + 0.05 * uWorking * sin(uClock * 2.2));
  vec3 centers[3];
  float sigmas[3];
  vec3 absorbs[3];
  vec3 pigments[3];
  for (int i = 0; i < CLOUDS; i++) {
    centers[i] = cloudCenter(i);
    sigmas[i] = H * SIZE_OF[i] * shrink;
    absorbs[i] = cloudAbsorb(i, warm) * 7.0 * DENSITY[i] * flicker;
    pigments[i] = cloudPigment(i, warm) * 2.5 * DENSITY[i] * flicker;
  }
  // The glass itself: nearly clear, a touch milky, so it reads white where there's no dye.
  vec3 bodyAbsorb = vec3(0.16, 0.13, 0.1);
  float scatter = 0.7;
  // Light inside the glass, come in through its frosted surface: white, brighter from above.
  vec3 roomLight = vec3(0.8, 0.81, 0.83);

  // A ray grazing a lobe can leave almost at once; it still crosses a little glass.
  float len = max(exitDistance(ro, rd, rad), 0.3);
  const int STEPS = 30;
  float dt = len / float(STEPS);
  vec3 transmit = vec3(1.0);
  vec3 glow = vec3(0.0);
  // A finished task: a shell of light spreading out from the middle.
  float pulseR = uRippleAge * 0.9;
  float pulseFade = uRippleAge < 6.0 ? exp(-uRippleAge * 1.1) : 0.0;
  vec3 toward = keyDir;
  for (int i = 0; i < STEPS; i++) {
    float depth = dt * (float(i) + 0.5);
    vec3 q = ro + rd * depth;
    vec3 qw = q + wander(q);
    // Light reaching this point: in through the frosted surface, through the dye on the way
    // (estimated from the dye at the midpoint of that short path, plenty for soft clouds).
    float lightPath = min(exitDistance(q, toward, rad), 0.6 + rad - length(q));
    vec3 mid = q + toward * lightPath * 0.5;
    vec3 sigmaA = bodyAbsorb;
    vec3 pigment = vec3(0.0);
    float dense = 0.0;
    vec3 lightA = bodyAbsorb;
    for (int j = 0; j < CLOUDS; j++) {
      float k = cloud(qw, centers[j], sigmas[j], depth);
      sigmaA += absorbs[j] * k;
      pigment += pigments[j] * k;
      dense += 2.5 * DENSITY[j] * k;
      lightA += absorbs[j] * cloud(mid, centers[j], sigmas[j], depth);
    }
    vec3 lightT = exp(-lightA * lightPath);
    float up = 0.75 + 0.25 * toward.y;
    float pulse = pulseFade * exp(-pow(length(q) - pulseR, 2.0) / 0.012) * 2.5;
    vec3 inScatter = roomLight * lightT * up * (1.0 + pulse);
    // Scattered light mostly isn't lost in glass this milky, only turned (it bounces on and comes
    // out somewhere), so scattering dims what's behind far less than absorbing does.
    glow += transmit * (scatter + pigment) * inScatter * dt;
    transmit *= exp(-(sigmaA + 0.3 * (scatter + dense)) * dt);
  }
  // Light from behind comes straight through what's left, diffused by the frosted far side.
  vec3 back = roomLight * (0.85 + 0.15 * max(dot(rd, -backDir), 0.0));
  vec3 inside = glow + transmit * back;

  // The frosted surface's own look: a little diffuse white, a broad soft sheen, and Fresnel.
  vec3 L = keyDir;
  float diffuse = 0.55 + 0.45 * dot(n, L);
  vec3 r = reflect(-v, n);
  float sky = smoothstep(-0.4, 0.9, (transpose(uViewToObj) * r).y);
  float sheen = pow(max(dot(r, L), 0.0), 6.0);
  // A frosted surface never turns mirror-like at grazing angles the way polished resin does, so
  // its Fresnel tops out low; otherwise the blob's outline goes gray where it turns away.
  float fres = 0.04 + 0.3 * pow(1.0 - nv, 4.0);
  vec3 surface = vec3(1.0, 0.99, 0.99) * (0.04 * diffuse + fres * (0.12 + 0.35 * sky) + 0.12 * sheen);

  // Glass shades only faintly; the light inside carries the look.
  vec3 col = inside * (1.0 - fres) * mix(0.96, 1.0, diffuse) + surface;
  // The fine edge a cut glass panel shows where its outline turns away: a thin, cool line.
  float edgeLine = smoothstep(0.22, 0.04, nv);
  col = mix(col, col * vec3(0.8, 0.84, 0.9), edgeLine * 0.35);
  // Soft filmic roll-off, then to sRGB.
  col = col / (1.0 + 0.08 * col);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);
}
`;

export function buildResinOrb(uniforms: OrbUniforms) {
  const geometry = new THREE.IcosahedronGeometry(1, 128);
  const viewToObj = { value: new THREE.Matrix3() };
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: { ...uniforms, uViewToObj: viewToObj },
  });
  const mesh = new THREE.Mesh(geometry, material);
  // The lights are fixed to the room (the view), not to the blob: turn them into its space each frame.
  const m = new THREE.Matrix4();
  mesh.onBeforeRender = (_r, _s, camera) => {
    m.copy(camera.matrixWorld).premultiply(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
    viewToObj.value.setFromMatrix4(m);
  };
  const group = new THREE.Group();
  group.add(mesh);
  return {
    group,
    surface: SURFACE,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
