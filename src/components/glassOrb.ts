/**
 * The Glass orb: a molten metallic core inside layers of frosted glass. The core oozes in big
 * rounded lobes, slow and viscous when calm, churning when stressed; its blue-to-magenta gradient
 * runs redder as stress rises. The glass shells follow the same molten shape with soft folds of
 * their own, clear where you look straight through them and frosted toward their edges.
 */
import * as THREE from "three";
import { NOISE } from "./orbNoise";

/** Large, smooth lobes from domain-warped low-frequency noise: the molten shape. */
const BLOB = /* glsl */ `
float blob(vec3 p, float t) {
  vec3 q = p * 0.8 + vec3(0.0, t * 0.3, t * 0.18);
  vec3 w = vec3(snoise(q + 3.1), snoise(q + 7.7), snoise(q + 12.3));
  return 0.72 * snoise(p * 0.95 + w * 0.7 + t * 0.2) + 0.14 * snoise(p * 1.6 + w * 0.5 - t * 0.25);
}
`;

const CORE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uStress;
varying vec3 vObj;
varying vec3 vViewPos;
${NOISE}
${BLOB}
void main() {
  float t = uTime * mix(0.32, 1.0, uStress);
  vec3 pos = position + normal * blob(normal, t) * mix(0.2, 0.3, uStress);
  vObj = pos;
  vec4 view = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = view.xyz;
  gl_Position = projectionMatrix * view;
}
`;

const CORE_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uStress;
varying vec3 vObj;
varying vec3 vViewPos;
${NOISE}
void main() {
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  vec3 v = normalize(-vViewPos);

  // Cyan and blue across most of the core, turning through violet to magenta-red on one side.
  // The red side grows with stress, and the boundary drifts slowly.
  float g = dot(normalize(vObj), normalize(vec3(0.55, 0.75, 0.2))) * 0.5 + 0.5;
  g += 0.16 * snoise(vObj * 1.4 + uTime * 0.12);
  // Calm: a red accent on one side. Stressed: red spreads over most of the core.
  float edge = mix(0.8, 0.36, uStress);
  vec3 color = mix(vec3(0.0, 0.74, 1.0), vec3(0.06, 0.26, 0.95), smoothstep(0.15, 0.5, g));
  color = mix(color, vec3(0.52, 0.22, 0.74), smoothstep(edge - 0.2, edge, g));
  color = mix(color, vec3(0.98, 0.07, 0.32), smoothstep(edge, edge + 0.22, g));

  // Polished metal: a bright sky reflected from above, a key highlight and a softer fill.
  vec3 r = reflect(-v, n);
  float sky = 0.22 + 0.78 * smoothstep(-0.35, 0.9, r.y);
  float key = pow(max(dot(r, normalize(vec3(0.35, 0.8, 0.5))), 0.0), 60.0);
  float fill = pow(max(dot(r, normalize(vec3(-0.6, 0.25, 0.7))), 0.0), 14.0) * 0.35;
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 lit = color * (0.22 + 0.9 * sky) + (key + fill) * vec3(1.0) + fres * color * 0.5;
  gl_FragColor = vec4(lit, 1.0);
}
`;

const SHELL_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uStress;
uniform float uRadius;
uniform float uSeed;
varying vec3 vObj;
varying vec3 vViewPos;
${NOISE}
${BLOB}
void main() {
  float t = uTime * mix(0.32, 1.0, uStress);
  // Follow the core's molten shape, so the glass hugs it, then add soft folds of its own.
  float lobe = blob(normal, t) * mix(0.2, 0.3, uStress) * 1.1;
  // Broad, slow folds, like sheets of soft glass draped over the core.
  float drift = snoise(normal * 1.1 + vec3(uSeed) + t * 0.25);
  float folds = sin(dot(normal, normalize(vec3(0.3, 0.9, 0.2) + uSeed * 0.1)) * 2.6 + drift * 1.8 + t * 0.4);
  vec3 pos = normal * (uRadius + lobe + folds * 0.07 + drift * 0.1);
  vObj = pos;
  vec4 view = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = view.xyz;
  gl_Position = projectionMatrix * view;
}
`;

const SHELL_FRAGMENT = /* glsl */ `
uniform float uOpacity;
varying vec3 vObj;
varying vec3 vViewPos;
${NOISE}
void main() {
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  vec3 v = normalize(-vViewPos);
  // Frosted glass: nearly clear face-on, milky and bright toward the edges, with a fine grain.
  float facing = abs(dot(n, v));
  float fres = pow(1.0 - facing, 2.2);
  float grain = 0.5 + 0.5 * snoise(vObj * 9.0);
  float alpha = (0.07 + 0.3 * fres + 0.04 * grain) * uOpacity;
  vec3 color = vec3(0.80, 0.88, 0.98) * (0.78 + 0.22 * n.y) + fres * 0.22;
  // The canvas uses premultiplied alpha.
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

/** Builds the Glass orb's meshes. Uniforms uTime and uStress are shared with the caller's loop. */
export function buildGlassOrb(uniforms: { uTime: { value: number }; uStress: { value: number } }) {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];

  const coreGeometry = new THREE.IcosahedronGeometry(0.82, 64);
  const coreMaterial = new THREE.ShaderMaterial({ vertexShader: CORE_VERTEX, fragmentShader: CORE_FRAGMENT, uniforms });
  group.add(new THREE.Mesh(coreGeometry, coreMaterial));
  disposables.push(coreGeometry, coreMaterial);

  // Two glass layers, each with its own folds, drawn after the core and through each other.
  for (const [radius, seed, opacity, order] of [
    [1.04, 1.7, 1.0, 1],
    [1.2, 5.3, 0.75, 2],
  ] as const) {
    const geometry = new THREE.IcosahedronGeometry(1, 72);
    const material = new THREE.ShaderMaterial({
      vertexShader: SHELL_VERTEX,
      fragmentShader: SHELL_FRAGMENT,
      uniforms: { ...uniforms, uRadius: { value: radius }, uSeed: { value: seed }, uOpacity: { value: opacity } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = order;
    group.add(mesh);
    disposables.push(geometry, material);
  }

  return { group, dispose: () => disposables.forEach((d) => d.dispose()) };
}
