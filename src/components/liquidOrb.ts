/**
 * The Iridescent orb: a liquid, holographic bubble. Its outline stays nearly round while the
 * surface swirls with soft, twisting dents; thin-film color (cyan, lavender, pink, a touch of gold)
 * shifts with the viewing angle and the swirls. Under stress it churns faster and deeper and its
 * colors warm and saturate.
 */
import * as THREE from "three";
import { NOISE } from "./orbNoise";
import { RIPPLE, type OrbUniforms } from "./orbRipple";

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uStress;
varying vec3 vObj;
varying vec3 vViewPos;
varying float vDisp;
${NOISE}
${RIPPLE}
// Liquid motion: twist the surface around the vertical axis by a slowly varying angle, then
// warp it, so dents swirl and flow like a disturbed liquid surface instead of bobbing in place.
float liquid(vec3 p, float t) {
  // The twist fades toward the poles, where a rotation would wind into a target pattern.
  float a = 1.5 * snoise(p * 0.55 + vec3(0.0, t * 0.12, 0.0)) * sqrt(max(1.0 - p.y * p.y, 0.0));
  float c = cos(a);
  float s = sin(a);
  vec3 q = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
  vec3 w = vec3(snoise(q * 0.8 + t * 0.16), snoise(q * 0.8 + 5.2 - t * 0.14), snoise(q * 0.8 + 9.7 + t * 0.12));
  return 0.85 * snoise(q * 0.9 + w * 0.8) + 0.15 * snoise(q * 1.7 + w * 0.6 + t * 0.25);
}
void main() {
  float t = uTime * mix(0.35, 1.1, uStress);
  float d = liquid(normal, t) * mix(0.08, 0.15, uStress) + 0.12 * ripple(normal);
  vec3 pos = position + normal * d;
  vObj = pos;
  vDisp = d;
  vec4 view = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = view.xyz;
  gl_Position = projectionMatrix * view;
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uStress;
varying vec3 vObj;
varying vec3 vViewPos;
varying float vDisp;
${NOISE}
// A looping pastel ramp, cyan to lavender to pink to gold and back, like soap-film color.
vec3 pastel(float f) {
  vec3 cyan = vec3(0.6, 0.92, 1.0);
  vec3 lavender = vec3(0.78, 0.72, 1.0);
  vec3 pink = vec3(1.0, 0.7, 0.9);
  vec3 gold = vec3(1.0, 0.92, 0.72);
  float x = fract(f) * 4.0;
  float k = smoothstep(0.0, 1.0, fract(x));
  if (x < 1.0) return mix(cyan, lavender, k);
  if (x < 2.0) return mix(lavender, pink, k);
  if (x < 3.0) return mix(pink, gold, k);
  return mix(gold, cyan, k);
}
void main() {
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  vec3 v = normalize(-vViewPos);
  float facing = max(dot(n, v), 0.0);
  float fres = pow(1.0 - facing, 1.6);

  // Thin-film color: the phase runs with viewing angle, the swirls and the dents.
  float film = facing * 1.1 + 0.45 * snoise(vObj * 0.8 + uTime * 0.06) + vDisp * 2.5 + uStress * 0.35;
  // Soft and milky when calm; deeper and warmer (toward pink and gold) under stress.
  vec3 irid = mix(vec3(0.9, 0.92, 1.0), pastel(film * 0.8), mix(0.88, 1.0, uStress));
  // Chrome-like contrast: deepen the color where the surface faces away from the sky.
  irid = mix(irid * irid, irid, 0.55);
  irid = mix(irid, irid * irid * 1.15, uStress * 0.5);

  // Glossy liquid: a bright sky reflected from above, a sharp highlight and a soft second one.
  vec3 r = reflect(-v, n);
  float sky = smoothstep(-0.25, 0.9, r.y);
  float key = pow(max(dot(r, normalize(vec3(0.3, 0.8, 0.55))), 0.0), 90.0);
  float soft = pow(max(dot(r, normalize(vec3(-0.5, 0.3, 0.8))), 0.0), 18.0) * 0.3;
  vec3 color = irid * (0.42 + 0.68 * sky) + (key + soft) * vec3(1.0) + fres * vec3(0.75, 0.9, 1.0) * 0.35;

  // A little see-through in the middle, glassier at the rim. Premultiplied alpha.
  float alpha = 0.86 + 0.14 * fres;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

/** Builds the Iridescent orb's mesh. Uniforms uTime and uStress are shared with the caller's loop. */
export function buildLiquidOrb(uniforms: OrbUniforms) {
  const geometry = new THREE.IcosahedronGeometry(1, 80);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));
  return {
    group,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
