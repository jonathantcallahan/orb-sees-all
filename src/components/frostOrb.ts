/**
 * Artemis, the listening orb: a soft pastel orb with a glow at its edge, wrapped in a cloud of tiny
 * dots that bounce with whatever is playing on the Mac.
 *
 * - The inner orb: mostly see-through, like a bubble, with soft pale fields of pink, lavender, sky
 *   blue and cyan drifting in it, denser and glowing rose toward its edge with no hard outline. The
 *   dots behind it show through. It swells only a little with the bass and on each hit (a spring,
 *   so it overshoots and settles): the dots carry the beat. Its colors follow how bright the music
 *   sounds, over a phrase rather than a beat: darker, bassier music deepens toward blue and violet,
 *   brighter music lifts toward pink and cyan. Stress pushes it toward magenta, as the other orbs
 *   redden.
 * - The dots: a thin layer of tiny dots resting on the inner orb's surface, each with a soft glow of
 *   its own: white on a dark page, and on a light one mostly the rose of the orb's aura and its
 *   pink, with some of its sky blue and cyan. They gather into wisps that one broad
 *   swirling flow (curl noise) carries around the orb at a pace the mids set. Each dot listens to
 *   one band of the sound, the bass lowest in the layer and the treble highest. Each hit throws them
 *   off the surface and they fall back and bounce, higher for a harder hit or a louder band, fading
 *   the farther they leap; the highs make the upper ones twinkle. Without music they breathe, drift and now and then hop a
 *   little.
 *
 * What it hears comes from orbMusic (Demian's listener); MusicResponse turns it into motion.
 */
import * as THREE from "three";
import { NOISE } from "./orbNoise";
import { FERRO, RIPPLE, type OrbUniforms } from "./orbEffects";
import { BANDS, listenToMusic, MusicResponse } from "../orbMusic";
import { isDark, type Theme } from "../theme";

/** The inner orb's radius at rest: with its glow and the dots' bounces it fills about as much as the other orbs. */
const INNER = 0.76;
const DOTS = 2600;

const PALETTE = /* glsl */ `
const vec3 PINK = vec3(1.0, 0.45, 0.85);
const vec3 LAVENDER = vec3(0.66, 0.55, 1.0);
const vec3 SKY = vec3(0.22, 0.66, 1.0);
const vec3 CYAN = vec3(0.3, 0.92, 0.9);
const vec3 DEEP = vec3(0.28, 0.32, 0.98);
const vec3 HOT = vec3(0.82, 0.32, 0.8);
// The inner orb's color at a direction: soft fields of pink, cyan and lavender over sky blue, drifting
// on the music's clock. bright (0..1) is how bright the music sounds; stress is the day's.
vec3 orbPalette(vec3 d, float time, float flow, float bright, float stress) {
  vec3 q = d * 0.7 + vec3(0.0, flow * 0.1, time * 0.025);
  float a = snoise(q);
  float b = snoise(q * 1.2 + 4.7);
  vec3 c = mix(DEEP, SKY, 0.3 + 0.7 * bright);
  // Broad fields with soft edges, each still its own color where it's strongest.
  c = mix(c, PINK, smoothstep(-0.05, 0.55, a) * mix(0.6, 0.95, bright));
  c = mix(c, CYAN, smoothstep(0.05, 0.6, b) * mix(0.6, 0.9, bright));
  c = mix(c, LAVENDER, smoothstep(0.2, 0.8, -a * b * 2.0) * 0.5);
  return mix(c, HOT, stress * 0.45);
}
`;

/**
 * How much the orb swells with the music: a little with the bass, a little on each hit's spring.
 * Kept small: the dots' bounce carries the beat.
 */
const SWELL_GLSL = "(0.04 * uBreath + 0.03 * uKick)";

const MUSIC_UNIFORMS = /* glsl */ `
uniform float uPresence;
uniform float uBreath;
uniform float uKick;
uniform float uHit;
uniform float uSwirl;
uniform float uSparkle;
uniform float uLevel;
uniform float uBright;
uniform float uTone;
uniform float uFlow;
uniform float uBands[${BANDS}];
uniform vec2 uWaves[4];
`;

/**
 * The inner orb's own shape at a direction: a slow breath and drift of its own, the bass's swell and
 * the hits' spring. The dots ride on it. Needs NOISE and MUSIC_UNIFORMS, and uTime.
 */
const INNER_SHAPE = /* glsl */ `
float innerShape(vec3 n) {
  float idle = 0.03 * sin(uTime * 1.05) + 0.015 * sin(uTime * 0.43 + 1.3);
  float drift = 0.05 * snoise(n * 1.1 + vec3(0.0, uFlow * 0.16, uTime * 0.05));
  return ${INNER.toFixed(3)} * (1.0 + idle + drift + ${SWELL_GLSL});
}
`;

const INNER_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uStress;
${MUSIC_UNIFORMS}
varying vec3 vDir;
varying vec3 vNormalV;
varying vec3 vViewPos;
${NOISE}
${RIPPLE}
${FERRO}
${INNER_SHAPE}
// Its radius with the shared effects too (a finished task's ripple, an update's hit, the spikes).
float innerRadius(vec3 n) {
  return (innerShape(n) + 0.05 * ripple(n) + 0.04 * shock(n) + 0.25 * ferro(n)) * squash(n);
}
void main() {
  vec3 n = normalize(position);
  vec3 pos = n * innerRadius(n);
  vDir = n;
  vNormalV = normalize(normalMatrix * n);
  vec4 view = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = view.xyz;
  gl_Position = projectionMatrix * view;
}
`;

const INNER_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uStress;
uniform float uOnLight;
${MUSIC_UNIFORMS}
varying vec3 vDir;
varying vec3 vNormalV;
varying vec3 vViewPos;
${NOISE}
${PALETTE}
void main() {
  vec3 c = orbPalette(vDir, uTime, uFlow, uBright, uStress);
  // Noisy music washes the colors a little; tonal music keeps them clear.
  c = mix(vec3(dot(c, vec3(0.333))), c, mix(0.65, 0.8, uTone));
  // Pastel, as if lit from within; louder music lifts it a little further toward white.
  // Pale, as if seen through haze. (Less washed than when it was solid: being see-through pales it.)
  c = mix(c, vec3(1.0), 0.35 + 0.04 * uLevel + 0.06 * uBreath + 0.1 * uHit);
  // Toward its edge it glows rose, as an aura does (the halo carries the glow outward): pale on a
  // dark page, deeper on a light one so it shows.
  float facing = max(dot(normalize(vNormalV), normalize(-vViewPos)), 0.0);
  vec3 rim = uOnLight > 0.5 ? vec3(0.95, 0.55, 0.74) : vec3(1.0, 0.84, 0.88);
  c = mix(c, rim, smoothstep(0.55, 0.0, facing) * 0.75);
  // No hard outline: it fades out over its outer rim, so it reads slightly blurred.
  // Mostly see-through, like a bubble: faint across its middle, denser toward its rim so it still
  // reads as a sphere, and fading out at the very edge with no hard outline.
  float alpha = mix(0.24, 0.7, pow(1.0 - facing, 1.6)) * smoothstep(0.0, 0.35, facing);
  gl_FragColor = vec4(min(c, vec3(0.98)) * alpha, alpha);
}
`;

/**
 * The inner orb's aura: a colored glow hugging its edge, a little brighter with the music and on
 * each hit. Rose: deeper on a light page so it shows, paler and brighter on a dark one. A square
 * always facing the camera, centered on the orb, sized with its breath and kicks.
 */
const HALO_SPAN = 2.6;
const HALO_VERTEX = /* glsl */ `
uniform float uTime;
${MUSIC_UNIFORMS}
varying vec2 vUv;
void main() {
  vUv = position.xy;
  float idle = 0.03 * sin(uTime * 1.05) + 0.015 * sin(uTime * 0.43 + 1.3);
  float r = ${INNER.toFixed(3)} * (1.0 + idle + ${SWELL_GLSL}) * ${HALO_SPAN.toFixed(2)};
  vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  gl_Position = projectionMatrix * (center + vec4(position.xy * r, 0.0, 0.0));
}
`;

const HALO_FRAGMENT = /* glsl */ `
uniform float uOnLight;
${MUSIC_UNIFORMS}
varying vec2 vUv;
void main() {
  // Distance from the center in the inner orb's radii (1 is its edge).
  float r = length(vUv) * ${HALO_SPAN.toFixed(2)};
  bool light = uOnLight > 0.5;
  vec3 rose = light ? vec3(0.95, 0.62, 0.78) : vec3(1.0, 0.8, 0.86);
  // Peaks at the edge and reaches only a little way in, so the colors stay clear. Outward it fades
  // the way light does, quickly at first and then in a long, soft tail (an inverse-power falloff,
  // not a bell curve), so there's no edge to it: it's all but gone well before the square ends.
  float x = r - 1.0;
  float glow = x < 0.0 ? exp(-pow(x / 0.12, 2.0)) : pow(1.0 + pow(x / 0.22, 2.0), -1.5);
  glow *= 1.0 - smoothstep(${(HALO_SPAN - 0.6).toFixed(2)}, ${HALO_SPAN.toFixed(2)}, r);
  glow *= (light ? 0.5 : 0.45) + 0.15 * uLevel + 0.25 * uHit;
  // A whisper of noise, below one step of the screen's color, so a faint gradient on a dark page
  // doesn't show as rings.
  float dither = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0 * step(0.002, glow);
  gl_FragColor = max(vec4(rose * glow + dither, glow + dither), 0.0);
}
`;

const DOT_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uStress;
uniform float uPixelRatio;
uniform float uOnLight;
${MUSIC_UNIFORMS}
attribute vec4 seed;
varying float vAlpha;
varying vec3 vColor;
varying float vGlow;
${NOISE}
${PALETTE}
${INNER_SHAPE}
vec3 potential(vec3 p) {
  return vec3(snoise(p), snoise(p + vec3(31.4, 7.1, 2.9)), snoise(p + vec3(-11.7, 19.3, 47.2)));
}
// Curl noise: a swirling flow with no sources or sinks, so the dots eddy like smoke rather than
// bunching up or spreading out. Broad (low frequency), so neighbors travel together.
vec3 curl(vec3 p) {
  const float e = 0.12;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  vec3 x0 = potential(p - dx), x1 = potential(p + dx);
  vec3 y0 = potential(p - dy), y1 = potential(p + dy);
  vec3 z0 = potential(p - dz), z1 = potential(p + dz);
  return vec3((y1.z - y0.z) - (z1.y - z0.y), (z1.x - z0.x) - (x1.z - x0.z), (x1.y - x0.y) - (y1.x - y0.x)) / (2.0 * e);
}
float hash(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
// A hop off the inner orb: up at speed v, back down under gravity, then two smaller bounces (each
// at a little under half the speed). Its height above the surface t seconds after leaving it.
float hop(float t, float v) {
  const float g = 10.0;
  for (int k = 0; k < 3; k++) {
    float flight = 2.0 * v / g;
    if (t < flight) return max(v * t - 0.5 * g * t * t, 0.0);
    t -= flight;
    v *= 0.42;
  }
  return 0.0;
}
void main() {
  // seed: x a phase, y a pace, z a size, w where it rests in the layer (and so which band it hears:
  // the bass lowest, the treble highest).
  int band = int(clamp(seed.w * ${BANDS}.0, 0.0, ${BANDS - 1}.0));
  float heard = uBands[band];

  // A thin layer over the inner orb's surface, riding its breath and kicks. The whole layer is
  // carried around the orb by one broad, slow flow (at the music's pace), so the dots drift together.
  vec3 home = normalize(position);
  vec3 dir = normalize(home + curl(home * 0.8 + vec3(0.0, uFlow * 0.1, 0.0)) * (0.1 + 0.1 * uSwirl));
  float surface = innerShape(dir);
  // At rest they lie just over the surface. Each hit throws them off it: up, back down onto it,
  // and a couple of smaller bounces, higher for a harder hit and for dots whose band is loud.
  // They leave a few hundredths of a second apart, so they don't move in lockstep.
  float rest = 0.012 + 0.03 * seed.w;
  float height = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 w = uWaves[i];
    if (w.y <= 0.0) continue;
    float t = w.x - 0.04 * seed.x;
    if (t > 0.0) height = max(height, hop(t, w.y * mix(0.82, 1.64, seed.y) * (0.75 + 0.5 * heard)));
  }
  // Without music they still hop now and then, each on its own few-second rhythm, barely.
  float period = 2.5 + 3.0 * seed.y;
  height = max(height, hop(mod(uTime + seed.x * period, period), 0.55 * (1.0 - 0.6 * uPresence)));
  // How far up it is, 0 on the surface to 1 at a big hop's peak: it shines brighter the higher.
  float up = clamp(height / 0.11, 0.0, 1.0);
  vec3 p = dir * (surface + rest + height);

  // The layer gathers into wisps: a slow field over the surface where dots show, thinning between
  // them. The bass spreads the wisps.
  float field = snoise(dir * 1.7 + vec3(0.0, uFlow * 0.08, uTime * 0.03));
  float wisp = smoothstep(-0.2 - 0.25 * uBreath, 0.45, field);

  // A slow pulse of their own, shared by neighbors (it follows the wisps), so the layer breathes
  // without music.
  float pulse = 0.5 + 0.5 * sin(uTime * 0.9 + field * 3.0 + seed.x * 1.2);
  // The higher dots twinkle with the highs: a few at a time, each a quick glint that fades.
  float beat = uTime * 8.0 + seed.x * 17.0;
  float chance = 0.14 * uSparkle * smoothstep(0.4, 0.95, seed.w);
  float twinkle = step(1.0 - chance, hash(floor(beat) + seed.y * 71.0)) * (1.0 - fract(beat));

  float shine = 0.35 + 0.35 * pulse;
  // On each hit the whole layer brightens at once, then fades within a tenth of a second.
  float onBeat = 0.45 * uHit;
  vAlpha = clamp(shine * (1.0 - 0.3 * uPresence) + uPresence * (0.4 * heard + 0.8 * twinkle + onBeat), 0.0, 1.0);
  vAlpha *= mix(0.08, 1.0, wisp);
  // The farther a dot leaps off the orb, the fainter it gets: about a fifth as bright at a big hop's peak.
  vAlpha *= mix(1.0, 0.2, up);

  vec4 view = modelViewMatrix * vec4(p, 1.0);
  // Behind the inner orb? (Treated as a sphere a touch smaller than its surface, so the dots along
  // its outline count as in front.)
  vec3 center = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float inner = ${INNER.toFixed(3)} * (0.97 + ${SWELL_GLSL});
  vec3 ray = normalize(view.xyz);
  float b = dot(ray, center);
  float disc = b * b - (dot(center, center) - inner * inner);
  // (Seen through it, as it's mostly see-through: just dimmed a little.)
  if (disc > 0.0 && b - sqrt(disc) < length(view.xyz)) vAlpha *= 1.0 - 0.35 * smoothstep(0.0, 0.02, disc);

  // White on a dark page. On a light one, each dot one of the orb's colors: most the rose of its
  // aura (the deeper rose of its rim, INNER_FRAGMENT) or its pink, the rest its sky blue or a
  // deeper cyan. At full strength, not paled like the orb: a dot this small only shows on the pale
  // orb and page in a strong color. Each is a color of its own, never a mix: pink and blue mixed
  // is purple, and the deep blue and lavender at the orb's heart are left out for the same reason.
  float pick = fract(seed.x * 7.13 + seed.y * 3.7);
  vec3 hue = pick < 0.45 ? vec3(0.95, 0.55, 0.74)
    : pick < 0.7 ? PINK
    : pick < 0.85 ? SKY
    : vec3(0.2, 0.76, 0.8);
  vColor = uOnLight > 0.5 ? hue : vec3(1.0);

  gl_Position = projectionMatrix * view;
  // Tiny, about 0.85 to 1.7 points, and they keep their size: the beat shows in how they shine and
  // leap, not in growing. The sprite is three times the dot, to hold its glow: the dot is its center third.
  gl_PointSize = 3.0 * (0.85 + 0.85 * seed.z) * uPixelRatio;
  // Each dot's own glow: faint at rest, brighter as it glints and on a hit.
  vGlow = 0.35 + 0.65 * clamp(twinkle + uHit, 0.0, 1.0) * uPresence;
}
`;

const DOT_FRAGMENT = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
varying float vGlow;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  // The dot itself, the sprite's center third: round and soft-edged, shaped like the working motes.
  float core = smoothstep(0.34, 0.0, r);
  core *= core;
  // Its own glow: a soft halo out to the sprite's edge, in the dot's own color.
  float halo = exp(-r * r * 7.0) * (1.0 - smoothstep(0.8, 1.0, r)) * vGlow * 0.45;
  // Premultiplied, so it shows over the orb and over a light or dark page alike.
  gl_FragColor = vec4(vColor * (core + halo) * vAlpha, (core + halo) * vAlpha);
}
`;

/**
 * The outside of what's drawn, for the motes the orb gives off while working: just past the dots
 * over the inner orb's surface, with its slow breath and drift (but not the music, which the motes
 * don't hear), and the shared effects so its wave tips match.
 */
const SURFACE = /* glsl */ `
float orbSurface(vec3 n) {
  n = normalize(n);
  float idle = 0.03 * sin(uTime * 1.05) + 0.015 * sin(uTime * 0.43 + 1.3);
  float drift = 0.05 * snoise(n * 1.1 + vec3(0.0, 0.0, uTime * 0.05));
  return (${INNER.toFixed(3)} * (1.0 + idle + drift) + 0.12 + 0.05 * ripple(n) + 0.04 * shock(n) + 0.25 * ferro(n)) * squash(n);
}
`;

export function buildFrostOrb(uniforms: OrbUniforms, renderer: THREE.WebGLRenderer) {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];

  const music = new MusicResponse();
  const stopListening = listenToMusic((heard) => music.hear(heard));
  const sound = {
    uPresence: { value: 0 },
    uBreath: { value: 0 },
    uKick: { value: 0 },
    uHit: { value: 0 },
    uSwirl: { value: 0 },
    uSparkle: { value: 0 },
    uLevel: { value: 0 },
    uBright: { value: 0.5 },
    uTone: { value: 0.5 },
    uFlow: { value: 0 },
    uBands: { value: new Array<number>(BANDS).fill(0) },
    uWaves: { value: [0, 1, 2, 3].map(() => new THREE.Vector2(0, 0)) },
  };

  const innerGeometry = new THREE.IcosahedronGeometry(1, 48);
  // Whether the page is light: the glow and dots color themselves for it.
  const onLight = { value: 0 };
  // Premultiplied, with a soft edge (see INNER_FRAGMENT).
  const premultiplied = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor } as const;
  const innerMaterial = new THREE.ShaderMaterial({ vertexShader: INNER_VERTEX, fragmentShader: INNER_FRAGMENT, uniforms: { ...uniforms, ...sound, uOnLight: onLight }, ...premultiplied });
  const inner = new THREE.Mesh(innerGeometry, innerMaterial);
  group.add(inner);
  disposables.push(innerGeometry, innerMaterial);

  // Its glow, over its edge.
  const haloGeometry = new THREE.PlaneGeometry(2, 2);
  const haloMaterial = new THREE.ShaderMaterial({ vertexShader: HALO_VERTEX, fragmentShader: HALO_FRAGMENT, uniforms: { ...uniforms, ...sound, uOnLight: onLight }, ...premultiplied, depthTest: false });
  const halo = new THREE.Mesh(haloGeometry, haloMaterial);
  halo.frustumCulled = false;
  halo.renderOrder = 2;
  group.add(halo);
  disposables.push(haloGeometry, haloMaterial);

  // The dot cloud, spread evenly around the inner orb (a Fibonacci sphere of directions), each dot
  // with its own seed.
  const positions = new Float32Array(DOTS * 3);
  const seeds = new Float32Array(DOTS * 4);
  for (let i = 0; i < DOTS; i++) {
    const y = 1 - (2 * (i + 0.5)) / DOTS;
    const r = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    positions.set([Math.cos(phi) * r, y, Math.sin(phi) * r], i * 3);
    seeds.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
  }
  const dotGeometry = new THREE.BufferGeometry();
  dotGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  dotGeometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 4));
  dotGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  const dotMaterial = new THREE.ShaderMaterial({
    vertexShader: DOT_VERTEX,
    fragmentShader: DOT_FRAGMENT,
    uniforms: { ...uniforms, ...sound, uPixelRatio: { value: renderer.getPixelRatio() }, uOnLight: onLight },
    transparent: true,
    depthWrite: false,
    // The ones behind the inner orb are faded in the shader instead.
    depthTest: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const dots = new THREE.Points(dotGeometry, dotMaterial);
  dots.renderOrder = 3;
  group.add(dots);
  disposables.push(dotGeometry, dotMaterial);

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let frame = 0;
  const update = (dt: number) => {
    music.step(dt);
    // With reduced motion the orb still listens, but moves a fraction as much.
    const k = reduced ? 0.25 : 1;
    sound.uPresence.value = music.presence;
    sound.uBreath.value = music.breath * k;
    sound.uKick.value = music.kick * k;
    sound.uHit.value = music.hit * k;
    sound.uSwirl.value = music.swirl * k;
    sound.uSparkle.value = reduced ? 0 : music.sparkle;
    sound.uLevel.value = music.level;
    sound.uBright.value = music.brightness;
    sound.uTone.value = music.tone;
    sound.uFlow.value = music.flow;
    for (let i = 0; i < BANDS; i++) sound.uBands.value[i] = music.bands[i] * k;
    sound.uWaves.value.forEach((w, i) => {
      const wave = music.waves[i];
      w.set(wave ? wave.age : 0, wave && !reduced ? wave.strength : 0);
    });
    if (frame++ % 30 === 0) onLight.value = isDark((document.documentElement.dataset.theme as Theme) ?? "system") ? 0 : 1;
  };

  return {
    group,
    surface: SURFACE,
    update,
    dispose: () => {
      stopListening();
      disposables.forEach((d) => d.dispose());
    },
  };
}
