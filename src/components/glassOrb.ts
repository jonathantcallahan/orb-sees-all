/**
 * The Glass orb: a molten metallic core inside a layer of milky glass. The core oozes in big
 * rounded lobes, slow and viscous when calm, churning when stressed; its blue-to-magenta gradient
 * runs redder as stress rises. The glass follows the same molten shape with soft folds of its own,
 * takes on the core's colors through its curves, and frosts toward its edges.
 */
import * as THREE from "three";
import { NOISE } from "./orbNoise";

/** Large, smooth lobes from domain-warped low-frequency noise: the molten shape. */
const BLOB = /* glsl */ `
float blob(vec3 p, float t) {
  vec3 q = p * 0.55 + vec3(0.0, t * 0.28, t * 0.16);
  vec3 w = vec3(snoise(q + 3.1), snoise(q + 7.7), snoise(q + 12.3));
  return 0.9 * snoise(p * 0.65 + w * 0.6 + t * 0.18);
}
`;

/**
 * The core's color at a direction from the center: cyan and blue across most of it, turning
 * through violet to magenta-red on one side, which grows with stress. The glass uses it too, to
 * show the core's colors through its curves.
 */
const CORE_COLOR = /* glsl */ `
vec3 coreColor(vec3 p, float time, float stress) {
  float g = dot(normalize(p), normalize(vec3(0.55, 0.75, 0.2))) * 0.5 + 0.5;
  g += 0.16 * snoise(p * 1.4 + time * 0.12);
  // Cool tones throughout: cyan and blue, then violet, then a cool magenta. Calm keeps the
  // magenta to a small accent; stress spreads it.
  float edge = mix(0.86, 0.42, stress);
  vec3 color = mix(vec3(0.22, 0.8, 1.0), vec3(0.12, 0.3, 0.92), smoothstep(0.15, 0.5, g));
  color = mix(color, vec3(0.46, 0.32, 0.88), smoothstep(edge - 0.22, edge, g));
  return mix(color, vec3(0.86, 0.26, 0.7), smoothstep(edge, edge + 0.22, g));
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
  vec3 pos = position + normal * blob(normal, t) * mix(0.3, 0.4, uStress);
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
${CORE_COLOR}
void main() {
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  vec3 v = normalize(-vViewPos);

  vec3 color = coreColor(vObj, uTime, uStress);

  // Polished metal: little diffuse light; the color comes from tinted reflections of a bright
  // sky, a chrome-like horizon band and a dark floor, with sharp highlights and bright edges.
  vec3 r = reflect(-v, n);
  float sky = smoothstep(-0.05, 0.7, r.y);
  float horizon = exp(-pow((r.y - 0.05) * 5.0, 2.0));
  float key = pow(max(dot(r, normalize(vec3(0.35, 0.8, 0.5))), 0.0), 90.0);
  float fill = pow(max(dot(r, normalize(vec3(-0.6, 0.25, 0.7))), 0.0), 20.0) * 0.45;
  float fres = pow(1.0 - max(dot(n, v), 0.0), 2.5);
  vec3 lit = color * (0.1 + 1.05 * sky + 0.55 * horizon) + (key * 1.3 + fill) * vec3(0.92, 0.97, 1.0) + fres * mix(color, vec3(1.0), 0.4) * 0.7;
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
  float lobe = blob(normal, t) * mix(0.3, 0.4, uStress) * 1.1;
  // Broad, slow folds, like sheets of soft glass draped over the core.
  float drift = snoise(normal * 0.75 + vec3(uSeed) + t * 0.22);
  float folds = sin(dot(normal, normalize(vec3(0.3, 0.9, 0.2) + uSeed * 0.1)) * 1.7 + drift * 1.5 + t * 0.35);
  vec3 pos = normal * (uRadius + lobe + folds * 0.07 + drift * 0.1);
  vObj = pos;
  vec4 view = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = view.xyz;
  gl_Position = projectionMatrix * view;
}
`;

const SHELL_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uStress;
uniform float uOpacity;
varying vec3 vObj;
varying vec3 vViewPos;
${NOISE}
${CORE_COLOR}
void main() {
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  vec3 v = normalize(-vViewPos);
  float facing = abs(dot(n, v));
  float fres = pow(1.0 - facing, 2.0);
  // How sharply the glass bends here: folds pick up more of the core's color and a brighter edge.
  float curve = clamp(length(fwidth(n)) * 16.0, 0.0, 1.0);

  // What the glass shows of the core: its color along a direction bent by the glass's shape,
  // so the colors slide and stretch across the folds instead of sitting straight behind them.
  vec3 bend = vec3(snoise(vObj * 1.6), snoise(vObj * 1.6 + 4.1), snoise(vObj * 1.6 + 8.3));
  vec3 inner = coreColor(vObj + bend * 0.45 + n * 0.25, uTime, uStress);

  // Milky glass tinted by the core: clearest face-on, frostier and brighter toward the edges.
  vec3 frost = vec3(0.86, 0.9, 0.97);
  vec3 color = mix(frost, inner * 1.1, clamp(0.5 * facing + 0.45 * curve, 0.0, 0.85));
  vec3 r = reflect(-v, n);
  float key = pow(max(dot(r, normalize(vec3(0.35, 0.8, 0.5))), 0.0), 40.0);
  color += fres * 0.3 + curve * 0.12 + key * 0.6;

  float alpha = clamp(mix(0.4, 0.88, fres) + curve * 0.15, 0.0, 0.95) * uOpacity;
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

  // One layer of glass over the core, drawn after it.
  for (const [radius, seed, opacity, order] of [[1.1, 1.7, 1.0, 1]] as const) {
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
