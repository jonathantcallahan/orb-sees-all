/**
 * Moss: a quartz-like crystal, a six-sided prism with pointed ends, made of flat sheets of colored
 * film. Each face is a single flat color, with no light, shading or reflection on it. Light passes
 * through the sheets the way it does through colored gel: where you see one face through another,
 * their colors multiply, so cyan over red reads brown and yellow over blue reads green, as in a
 * print of layered transparent shapes. It stands upright and turns slowly, and like Edith its faces
 * keep slowly tilting and pushing in and out, so it's always re-forming with every face still flat.
 *
 * Drawn in two passes over the same shape: first its far faces, each in its own color, then its
 * near faces multiplied over them. The shared effects (a finished task's ripple, an update's hit,
 * the spikes) still move its surface, and under stress its faces shift more and its colors warm.
 */
import * as THREE from "three";
import { NOISE } from "./orbNoise";
import { FERRO, RIPPLE, type OrbUniforms } from "./orbEffects";

/**
 * The crystal's eighteen faces, each a direction and a distance: six sides around its middle, and
 * a six-sided point above and below, each facet in line with the side under it.
 */
const SHAPE = /* glsl */ `
const vec4 FACES[18] = vec4[18](
  vec4(0.8660, 0.0000, 0.5000, 0.600),
  vec4(0.0000, 0.0000, 1.0000, 0.600),
  vec4(-0.8660, 0.0000, 0.5000, 0.600),
  vec4(-0.8660, 0.0000, -0.5000, 0.600),
  vec4(0.0000, 0.0000, -1.0000, 0.600),
  vec4(0.8660, 0.0000, -0.5000, 0.600),
  vec4(0.6124, 0.7071, 0.3536, 0.813),
  vec4(0.0000, 0.7071, 0.7071, 0.813),
  vec4(-0.6124, 0.7071, 0.3536, 0.813),
  vec4(-0.6124, 0.7071, -0.3536, 0.813),
  vec4(0.0000, 0.7071, -0.7071, 0.813),
  vec4(0.6124, 0.7071, -0.3536, 0.813),
  vec4(0.6124, -0.7071, 0.3536, 0.813),
  vec4(0.0000, -0.7071, 0.7071, 0.813),
  vec4(-0.6124, -0.7071, 0.3536, 0.813),
  vec4(-0.6124, -0.7071, -0.3536, 0.813),
  vec4(0.0000, -0.7071, -0.7071, 0.813),
  vec4(0.6124, -0.7071, -0.3536, 0.813)
);
// Face i as it is now, its direction and distance. As Edith's do, each face tilts and pushes in
// and out on its own slow beats, so the crystal keeps re-forming: faces grow, shrink and swallow
// their neighbors, but each stays flat. A little less than hers, so it still reads as quartz;
// more under stress.
vec4 faceNow(int i, float t) {
  float fi = float(i);
  vec3 f = normalize(FACES[i].xyz + mix(0.2, 0.3, uStress) * vec3(sin(t * 0.52 + fi * 1.3), sin(t * 0.45 + fi * 2.1), sin(t * 0.38 + fi * 2.9)));
  return vec4(f, FACES[i].w * (1.0 + mix(0.08, 0.12, uStress) * sin(t * 0.62 + fi * 1.9)));
}
// The crystal's radius along a direction: the nearest face along it, with the edges eased just
// enough (a smooth minimum) that the mesh can draw them cleanly.
float crystal(vec3 n, float t) {
  n = normalize(n);
  float dist[18];
  float nearest = 1e3;
  for (int i = 0; i < 18; i++) {
    vec4 face = faceNow(i, t);
    float c = dot(n, face.xyz);
    dist[i] = c > 0.02 ? face.w / c : 1e3;
    nearest = min(nearest, dist[i]);
  }
  const float k = 0.004;
  float sum = 0.0;
  for (int i = 0; i < 18; i++) sum += exp(-(dist[i] - nearest) / k);
  return nearest - k * log(sum);
}
// With the shared effects.
float mossRadius(vec3 n, float t) {
  n = normalize(n);
  return (crystal(n, t) + 0.12 * ripple(n) + 0.1 * shock(n) + 0.5 * ferro(n)) * squash(n);
}
`;

/** The crystal's outside, for the motes it gives off while working. */
const SURFACE = /* glsl */ `
${SHAPE}
float orbSurface(vec3 n) {
  return mossRadius(n, uTime * mix(0.32, 1.0, uStress));
}
`;

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uStress;
varying vec3 vFace;
${NOISE}
${RIPPLE}
${FERRO}
${SHAPE}
void main() {
  vec3 n = normalize(position);
  float t = uTime * mix(0.32, 1.0, uStress);
  // Which face a point is on is judged on the plain crystal, so the effects don't recolor it.
  vFace = n * crystal(n, t);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(n * mossRadius(n, t), 1.0);
}
`;

/**
 * Each face's color, from a print of layered transparent crystals: bright cyan, yellow, red,
 * orange, green, pink, lavender, peach, sky, teal, blue, magenta, lime, cream, one deep navy,
 * coral, mint and mustard. Multiplied over each other they give its browns, olives and deep greens.
 */
const COLORS = /* glsl */ `
const vec3 COLORS[18] = vec3[18](
  vec3(0.36, 0.80, 0.92),
  vec3(1.00, 0.95, 0.20),
  vec3(0.93, 0.23, 0.18),
  vec3(0.97, 0.62, 0.13),
  vec3(0.33, 0.70, 0.31),
  vec3(0.91, 0.43, 0.62),
  vec3(0.76, 0.69, 0.85),
  vec3(0.97, 0.68, 0.53),
  vec3(0.73, 0.82, 0.93),
  vec3(0.00, 0.70, 0.70),
  vec3(0.00, 0.53, 0.80),
  vec3(0.88, 0.18, 0.47),
  vec3(0.66, 0.81, 0.24),
  vec3(0.98, 0.95, 0.60),
  vec3(0.20, 0.30, 0.45),
  vec3(0.91, 0.37, 0.40),
  vec3(0.43, 0.79, 0.73),
  vec3(0.86, 0.80, 0.30)
);
`;

/** How opaque the crystal is: nearly, with a hint of the page showing through. */
const OPACITY = 0.92;

const fragment = (near: boolean) => /* glsl */ `
uniform float uStress;
uniform float uTime;
varying vec3 vFace;
${SHAPE.replace(/float mossRadius[\s\S]*$/, "")}
${COLORS}
void main() {
  // The face this point lies on: the one it stands furthest out against.
  float t = uTime * mix(0.32, 1.0, uStress);
  int face = 0;
  float best = -1e3;
  for (int i = 0; i < 18; i++) {
    vec4 f = faceNow(i, t);
    float s = dot(vFace, f.xyz) / f.w;
    if (s > best) {
      best = s;
      face = i;
    }
  }
  // Flat color: no light, no shading, no reflection. Stress warms it a little.
  vec3 c = COLORS[face];
  c = mix(c, c * vec3(1.0, 0.8, 0.78), uStress * 0.4);
  ${
    near
      ? "// Multiplied over the far face behind it (by the blending), as light through two gels.\n  gl_FragColor = vec4(c, 1.0);"
      : `// Lighter than the near faces, so they tint what's in front rather than muddying it.\n  c = mix(c, vec3(1.0), 0.35);\n  gl_FragColor = vec4(c * ${OPACITY.toFixed(2)}, ${OPACITY.toFixed(2)});`
  }
}
`;

export function buildPrismOrb(uniforms: OrbUniforms) {
  const group = new THREE.Group();
  const geometry = new THREE.IcosahedronGeometry(1, 64);
  // The far faces, each its own color, laid down first (premultiplied, nearly opaque).
  const far = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: fragment(false),
    uniforms,
    side: THREE.BackSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  // The near faces, multiplied over them: color = near × far; the coverage stays the far pass's.
  const near = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: fragment(true),
    uniforms,
    side: THREE.FrontSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const farMesh = new THREE.Mesh(geometry, far);
  farMesh.renderOrder = 1;
  const nearMesh = new THREE.Mesh(geometry, near);
  nearMesh.renderOrder = 2;
  group.add(farMesh, nearMesh);
  // About the other orbs' size.
  group.scale.setScalar(1.12);

  return {
    group,
    surface: SURFACE,
    dispose: () => {
      geometry.dispose();
      far.dispose();
      near.dispose();
    },
  };
}
