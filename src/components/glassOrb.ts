/**
 * The Glass orb: a molten metallic core inside a shell of frosted glass. The core oozes in big
 * rounded lobes, slow and viscous when calm, churning when stressed; its blue-to-magenta gradient
 * runs redder as stress rises. The glass follows the same molten shape with soft folds of its own.
 *
 * The frost is real transmission (MeshPhysicalMaterial): three renders the core into a mip-mapped
 * texture and the glass samples it through refraction, blurred by its roughness and thickness, so
 * the core shows through as a soft glow that sharpens where the glass is thin. A studio environment
 * gives it reflections and a bright rim.
 *
 * The Crystal orb is the same core suspended in clear, solid glass: no frost, a thick volume that
 * bends the core as you'd see it through a lens, bright edge reflections, and rainbow fringes
 * where the glass splits light (dispersion) plus a faint thin-film sheen.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { NOISE } from "./orbNoise";
import { FERRO, RIPPLE, type OrbUniforms } from "./orbEffects";

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
 * through violet to magenta-red on one side, which grows with stress.
 */
const CORE_COLOR = /* glsl */ `
// The cool ramp the core moves along with mood: cyan, blue, violet, cool magenta.
vec3 coolRamp(float x) {
  vec3 cyan = vec3(0.22, 0.8, 1.0);
  vec3 blue = vec3(0.12, 0.3, 0.92);
  vec3 violet = vec3(0.46, 0.32, 0.88);
  vec3 magenta = vec3(0.86, 0.26, 0.7);
  x = clamp(x, 0.0, 1.0) * 3.0;
  if (x < 1.0) return mix(cyan, blue, x);
  if (x < 2.0) return mix(blue, violet, x - 1.0);
  return mix(violet, magenta, x - 2.0);
}
vec3 coreColor(vec3 p, float time, float stress) {
  float g = dot(normalize(p), normalize(vec3(0.55, 0.75, 0.2))) * 0.5 + 0.5;
  g += 0.16 * snoise(p * 1.4 + time * 0.12);
  // Each mood shows a narrow slice of the ramp (about a third of a color step either side),
  // and stress moves the slice: cyan-blue when calm, blue-violet when restless, violet-magenta
  // when overloaded.
  return coolRamp(mix(0.12, 0.88, stress) + (g - 0.5) * 0.36);
}
`;

const CORE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uStress;
varying vec3 vObj;
varying vec3 vViewPos;
${NOISE}
${RIPPLE}
${FERRO}
${BLOB}
void main() {
  float t = uTime * mix(0.32, 1.0, uStress);
  // Smaller lobes than the shell's, so the core stays well inside it and the glass's outline reads.
  float spike = ferro(normal);
  vec3 pos = position + normal * (blob(normal, t) * mix(0.22, 0.3, uStress) + 0.1 * ripple(normal) + 0.35 * spike);
  // Colored by the undisplaced surface, so spikes match the metal around their base.
  vObj = pos - normal * 0.35 * spike;
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
  // Kept below white: seen through the frosted shell, any blown-out highlight spreads into a big
  // white patch.
  vec3 lit = color * (0.12 + 0.8 * sky + 0.45 * horizon) + (key * 0.7 + fill * 0.6) * vec3(0.92, 0.97, 1.0) + fres * mix(color, vec3(1.0), 0.2) * 0.45;
  lit = min(lit, vec3(0.92));
  gl_FragColor = vec4(lit, 1.0);
}
`;

/**
 * The shell's molten shape, injected into MeshPhysicalMaterial's vertex shader: it hugs the core's
 * lobes and adds broad folds of its own. Normals come from the displaced surface (by finite
 * differences), so reflections and refraction follow the folds.
 */
const SHELL_SHAPE = /* glsl */ `
uniform float uTime;
uniform float uStress;
uniform float uRadius;
uniform float uSeed;
${NOISE}
${RIPPLE}
${FERRO}
${BLOB}
float shellRadius(vec3 n, float t) {
  float lobe = blob(n, t) * mix(0.3, 0.4, uStress) * 1.1;
  float drift = snoise(n * 0.75 + vec3(uSeed) + t * 0.22);
  float folds = sin(dot(n, normalize(vec3(0.3, 0.9, 0.2) + uSeed * 0.1)) * 1.7 + drift * 1.5 + t * 0.35);
  return uRadius + lobe + folds * 0.07 + drift * 0.1 + 0.14 * ripple(n) + 0.6 * ferro(n);
}
vec3 shellPoint(vec3 n, float t) {
  n = normalize(n);
  return n * shellRadius(n, t);
}
`;

const SHELL_NORMAL = /* glsl */ `
float shellT = uTime * mix(0.32, 1.0, uStress);
vec3 shellN = normalize(normal);
vec3 shellA = normalize(cross(shellN, abs(shellN.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
vec3 shellB = cross(shellN, shellA);
vec3 shellPos = shellPoint(shellN, shellT);
vec3 shellDu = shellPoint(shellN + shellA * 0.004, shellT) - shellPos;
vec3 shellDv = shellPoint(shellN + shellB * 0.004, shellT) - shellPos;
vec3 objectNormal = normalize(cross(shellDu, shellDv));
if (dot(objectNormal, shellN) < 0.0) objectNormal = -objectNormal;
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(tangent.xyz);
#endif
`;

/**
 * A black studio with a few bright softbox strips and two faint colored lights. Clear glass mirrors
 * its surroundings, so this keeps it dark and see-through with crisp white streaks along its edges
 * and folds, and a hint of color in the glints.
 */
function darkStudio(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.02, 0.02, 0.03);
  const strip = (w: number, h: number, color: THREE.Color, pos: [number, number, number]) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    mesh.position.set(...pos);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  };
  const white = (k: number) => new THREE.Color(k, k, k);
  strip(6, 1.2, white(6), [0, 6, 2]); // overhead softbox
  strip(1, 7, white(4), [-6, 0, 3]); // left strip
  strip(1, 7, white(3), [6, 1, 1]); // right strip
  strip(5, 0.6, white(2.5), [0, -1, -6]); // rim light behind
  strip(2, 2, new THREE.Color(0.4, 1.6, 3), [-4, -4, 4]); // cool glint
  strip(2, 2, new THREE.Color(3, 2.2, 0.4), [4, 4, -3]); // warm glint
  return scene;
}

/** The two glass shells: frosted (the Glass orb) and clear (the Crystal orb). */
export type GlassVariant = "frosted" | "clear";

const SHELLS: Record<GlassVariant, THREE.MeshPhysicalMaterialParameters> = {
  frosted: {
    // Frost: roughness blurs what's seen through the glass; thickness bends and spreads it.
    roughness: 0.52,
    thickness: 1.7,
    ior: 1.45,
    // A faint cool tint deepening with the glass's thickness, like real glass.
    attenuationColor: new THREE.Color(0.86, 0.92, 1.0),
    attenuationDistance: 4,
    specularIntensity: 0.6,
    envMapIntensity: 0.45,
  },
  clear: {
    // Polished: a sharp view of the core, magnified and bent by a thick, dense volume.
    roughness: 0.03,
    thickness: 2.6,
    ior: 1.52,
    // Rainbow fringes where the glass bends light hardest, at the edges and folds.
    dispersion: 5,
    // A faint oil-slick sheen that shifts with the viewing angle.
    iridescence: 0.35,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [200, 600],
    attenuationColor: new THREE.Color(0.92, 0.95, 1.0),
    attenuationDistance: 6,
    specularIntensity: 1,
    // Crisp reflections of the dark studio's light strips give it the hard white rim of solid glass.
    envMapIntensity: 1.6,
  },
};

/**
 * Builds the Glass or Crystal orb's meshes and the environment its glass reflects (set it as the
 * scene's environment). Uniforms uTime and uStress are shared with the caller's loop.
 */
export function buildGlassOrb(uniforms: OrbUniforms, renderer: THREE.WebGLRenderer, variant: GlassVariant = "frosted") {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];

  const coreGeometry = new THREE.IcosahedronGeometry(0.66, 64);
  const coreMaterial = new THREE.ShaderMaterial({ vertexShader: CORE_VERTEX, fragmentShader: CORE_FRAGMENT, uniforms });
  const core = new THREE.Mesh(coreGeometry, coreMaterial);
  // In clear glass the core floats well inside, with plenty of glass around it.
  if (variant === "clear") core.scale.setScalar(0.72);
  group.add(core);
  disposables.push(coreGeometry, coreMaterial);

  // One glass shell over the core. Transmission renders after opaque objects, so it sees the core.
  const shellGeometry = new THREE.IcosahedronGeometry(1, 128);
  const shell = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, transmission: 1, ...SHELLS[variant] });
  shell.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uTime: uniforms.uTime,
      uStress: uniforms.uStress,
      uRippleAge: uniforms.uRippleAge,
      uRippleOrigin: uniforms.uRippleOrigin,
      uSpike: uniforms.uSpike,
      uSpikeDir: uniforms.uSpikeDir,
      uClock: uniforms.uClock,
      uRadius: { value: 1.1 },
      uSeed: { value: 1.7 },
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${SHELL_SHAPE}`)
      .replace("#include <beginnormal_vertex>", SHELL_NORMAL)
      .replace("#include <begin_vertex>", "vec3 transformed = shellPos;");
  };
  const shellMesh = new THREE.Mesh(shellGeometry, shell);
  shellMesh.renderOrder = 1;
  group.add(shellMesh);
  disposables.push(shellGeometry, shell);

  // Reflections and the rim come from a studio environment: a soft, bright room for frosted glass;
  // a dark one with a few light strips for clear glass, which mirrors it sharply.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = variant === "clear" ? darkStudio() : new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  pmrem.dispose();
  room.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  disposables.push(environment);

  return { group, environment, dispose: () => disposables.forEach((d) => d.dispose()) };
}
