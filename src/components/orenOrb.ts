/**
 * Oren: a soap bubble.
 *
 * A bubble is a film of soapy water a few hundred nanometers thick, so what you see is almost all
 * light bouncing off it: the room reflected, and colors from thin-film interference, where light
 * reflecting off the film's front and back surfaces adds up or cancels depending on how thick the
 * film is there. MeshPhysicalMaterial models that interference (iridescence); here the film's
 * thickness isn't fixed but swirls slowly across the surface, as the soap drains and eddies in a
 * real bubble, so the colors move in bands. A bubble is nearly all reflection, so each pixel is
 * as opaque as the light it reflects: where it reflects little it's clear and the page shows
 * through, in light theme or dark, and it shows more toward the edges, where it reflects more
 * (Fresnel), with a faint edge so it still reads against a white page.
 *
 * Its shape is a near-sphere that wobbles gently, more so under stress, and still takes the shared
 * ripples and ferrofluid spikes, so it reacts like the other orbs.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { NOISE } from "./orbNoise";
import { FERRO, RIPPLE, type OrbUniforms } from "./orbEffects";
import { isDark, type Theme } from "../theme";

/** The bubble's radius at a direction: round, with a slow wobble, ripples and spikes. Also the particles' surface. */
export const BUBBLE_SURFACE = /* glsl */ `
float bubbleRadius(vec3 n, float t) {
  float wobble = snoise(n * 0.9 + vec3(t * 0.35, t * 0.22, -t * 0.28)) * mix(0.045, 0.12, uStress);
  float sway = sin(dot(n, vec3(0.0, 1.0, 0.3)) * 2.0 + t * 0.9) * 0.025;
  return 1.12 + wobble + sway + 0.14 * ripple(n) + 0.6 * ferro(n);
}
float orbSurface(vec3 n) {
  return bubbleRadius(normalize(n), uTime);
}
`;

const BUBBLE_SHAPE = /* glsl */ `
uniform float uTime;
uniform float uStress;
${NOISE}
${RIPPLE}
${FERRO}
${BUBBLE_SURFACE}
varying vec3 vBubbleDir;
vec3 bubblePoint(vec3 n) {
  n = normalize(n);
  return n * bubbleRadius(n, uTime);
}
`;

const BUBBLE_NORMAL = /* glsl */ `
vec3 bN = normalize(normal);
vec3 bA = normalize(cross(bN, abs(bN.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
vec3 bB = cross(bN, bA);
vec3 bPos = bubblePoint(bN);
vec3 objectNormal = normalize(cross(bubblePoint(bN + bA * 0.004) - bPos, bubblePoint(bN + bB * 0.004) - bPos));
if (dot(objectNormal, bN) < 0.0) objectNormal = -objectNormal;
vBubbleDir = bN;
`;

/**
 * The film's thickness, which sets its colors. A real bubble is mostly around half a micron to a
 * micron thick, where interference colors are soft pastels, varying gently as the soap swirls;
 * near the top, where it drains thin, and toward the silhouette, stronger colors appear.
 */
const FILM_THICKNESS = /* glsl */ `
#include <lights_physical_fragment>
#ifdef USE_IRIDESCENCE
{
  vec3 p = normalize(vBubbleDir);
  float t = uClock * 0.05;
  vec3 q = vec3(snoise(p * 1.4 + vec3(t, 0.0, 0.0)), snoise(p * 1.4 + vec3(4.2, t, 1.3)), snoise(p * 1.4 + vec3(-2.7, 2.1, t)));
  float swirl = snoise(p * 0.8 + q * 0.5 + vec3(0.0, -t * 1.6, 0.0)) * 0.5 + 0.5;
  float thick = mix(560.0, 1050.0, swirl);
  // Thinner toward the top, where the soap drains away first.
  float drained = smoothstep(0.55, 0.95, p.y);
  float film = mix(thick, mix(330.0, 520.0, swirl), drained);
  // Toward the silhouette, where you see the film at a glancing angle, its colors run strongest:
  // the film thins to where interference colors are vivid.
  float graze = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  // Strongest just inside the rim: right at the edge a film reflects every color alike and washes out.
  float band = smoothstep(0.2, 0.5, graze) * (1.0 - smoothstep(0.82, 0.97, graze));
  material.iridescenceThickness = mix(film, mix(260.0, 560.0, swirl), band);
}
#endif
`;

/**
 * How the film lays over the page. On a dark page a bubble shows as light: its highlights and tints,
 * as opaque as they are bright, with the room's dim, even reflection taken out so the body stays
 * clear. On a white page its bright reflections vanish and what shows is its edge: clear in the
 * middle, a soft gray, faintly tinted rim where it reflects most (the reflection, laid over the page
 * by Fresnel). Color goes out premultiplied either way.
 */
const FILM_LIGHT = /* glsl */ `
// The film's colors, a little richer: rendered reflections of a mostly neutral room come out paler
// than the eye sees on a real bubble.
outgoingLight = max(mix(vec3(dot(outgoingLight, vec3(0.299, 0.587, 0.114))), outgoingLight, 1.9), vec3(0.0));
if (uLightPage > 0.5) {
  float facing = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  float a = clamp(0.03 + 0.62 * pow(1.0 - facing, 2.6), 0.0, 1.0);
  gl_FragColor = vec4(outgoingLight * 0.62 * a, a);
} else {
  float facing = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  float rim = pow(1.0 - facing, 1.8);
  // The room's dim, even reflection is taken out, so only highlights and tints remain: the body
  // stays clear over a white page as well as a dark one.
  vec3 light = max(outgoingLight * (0.22 + 1.2 * rim) - vec3(0.07), vec3(0.0));
  float la = clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0);
  // A fine neutral-gray edge: a dark line on a white page, a light one on a dark page.
  float edge = 0.32 * pow(1.0 - facing, 5.0);
  float a = clamp(la + edge * (1.0 - la), 0.0, 1.0);
  gl_FragColor = vec4(min(light, vec3(la)) + vec3(0.5) * edge * (1.0 - la), a);
}
`;

export function buildOrenOrb(uniforms: OrbUniforms, renderer: THREE.WebGLRenderer) {
  // Which theme the page is in, followed as it changes (Settings, or macOS when matching it).
  const lightPage = { value: 0 };
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  const readTheme = () => {
    lightPage.value = isDark((document.documentElement.dataset.theme as Theme) ?? "system") ? 0 : 1;
  };
  readTheme();
  scheme.addEventListener("change", readTheme);
  const themeObserver = new MutationObserver(readTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const geometry = new THREE.IcosahedronGeometry(1, 128);
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.02, 0.02, 0.03),
    metalness: 0,
    roughness: 0.0,
    // Water's index: plain reflections of the room, with the film's color laid over them only in part.
    ior: 1.33,
    specularIntensity: 1,
    iridescence: 1,
    iridescenceIOR: 1.33,
    iridescenceThicknessRange: [260, 1050],
    envMapIntensity: 1.3,
    transparent: true,
    // Premultiplied "over": the shader writes color already scaled by its opacity.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uTime: uniforms.uTime,
      uStress: uniforms.uStress,
      uRippleAge: uniforms.uRippleAge,
      uRippleOrigin: uniforms.uRippleOrigin,
      uSpike: uniforms.uSpike,
      uSpikeDir: uniforms.uSpikeDir,
      uClock: uniforms.uClock,
      uLightPage: lightPage,
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${BUBBLE_SHAPE}`)
      .replace("#include <beginnormal_vertex>", BUBBLE_NORMAL)
      .replace("#include <begin_vertex>", "vec3 transformed = bPos;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform float uClock;\nuniform float uLightPage;\nvarying vec3 vBubbleDir;\n${NOISE}`)
      .replace("#include <lights_physical_fragment>", FILM_THICKNESS)
      .replace("#include <opaque_fragment>", FILM_LIGHT);
  };
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));

  // A bright room: a bubble shows what it reflects, so a lit room gives its film color everywhere,
  // with the room's lights as the crisp window-like highlights bubbles have.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.02).texture;
  pmrem.dispose();
  room.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });

  return {
    group,
    environment,
    surface: BUBBLE_SURFACE,
    dispose: () => {
      scheme.removeEventListener("change", readTheme);
      themeObserver.disconnect();
      geometry.dispose();
      material.dispose();
      environment.dispose();
    },
  };
}
