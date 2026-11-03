/**
 * Edith: an opal stone sealed under a thick layer of clear glass, standing upright and turning
 * very slowly.
 *
 * - The opal: a faceted stone (see STONE_RADIUS), milky and faintly blue-white, a little
 *   translucent at its rim, and full of play-of-color (see PLAY_OF_COLOR): domains of spectral fire
 *   under the surface that flash and slide as it turns. Calm, the fire runs mostly green, with blue,
 *   like a white opal; under stress it heats through gold to the reds and oranges of a fire opal.
 * - The glass: a clear, polished layer about 0.26 thick, cut like the stone: its faces are the
 *   stone's, pushed out evenly, with the same crisp edges. Clear all over (its frost is off for now). It's drawn as a
 *   see-through layer (see the glass material below), with the studio's reflections on it and a
 *   faint aqua at its thick outline.
 */
import * as THREE from "three";
import { darkStudio, SHELL_NORMAL } from "./glassOrb";
import { NOISE } from "./orbNoise";
import { FERRO, RIPPLE } from "./orbEffects";
import { porcelainStudio } from "./porcelainOrb";
import type { OrbUniforms } from "./orbEffects";

/** The opal's size inside the glass, so stone and glass together are about Ophelia's size. */
const STONE = 0.8;
/** How thick the glass is, in orb units: about half an inch at the orb's scale. */
const GLASS = 0.26;
/**
 * The stone's shape: flat faces meeting at crisp edges, like a tumbled rough stone, rather than the
 * molten lobes of the other orbs. It's the inside of fourteen planes (each a direction and a
 * distance, irregular so no two faces match), joined with a smooth minimum so the edges are sharp
 * but just eased. The faces keep tilting and pushing in and out, so the stone is always slowly
 * re-forming (more so under stress), with every face still flat.
 * The shared effects (a finished task's ripple, an update's hit, the spikes) still work on it.
 */
const STONE_RADIUS = /* glsl */ `
const vec4 FACES[14] = vec4[14](
  vec4(0.360, 0.932, 0.051, 0.912),
  vec4(-0.487, 0.816, 0.312, 0.981),
  vec4(-0.066, 0.571, -0.818, 0.915),
  vec4(0.520, 0.616, 0.592, 0.936),
  vec4(-0.865, 0.482, -0.137, 0.963),
  vec4(0.916, 0.074, -0.395, 0.946),
  vec4(-0.374, -0.044, 0.926, 1.031),
  vec4(-0.549, -0.046, -0.834, 0.960),
  vec4(0.919, -0.341, 0.200, 0.933),
  vec4(-0.858, -0.402, 0.319, 0.994),
  vec4(0.367, -0.583, -0.725, 1.012),
  vec4(0.156, -0.635, 0.756, 1.040),
  vec4(-0.474, -0.864, -0.169, 0.919),
  vec4(0.362, -0.911, -0.197, 0.978)
);
// The faceted body at direction n, each face pushed out by \`grow\` (0 for the stone itself; the
// glass is the same faces pushed out by its thickness, so it has the stone's flat faces). \`k\` is
// how much the edges are eased: barely, for the stone and the glass alike.
float facets(vec3 n, float t, float grow, float k) {
  n = normalize(n);
  // Smooth minimum (log-sum-exp) of the distance to each face along n: flat faces, eased edges.
  // Taken relative to the nearest face, so it stays exact however small k is.
  float dist[14];
  float nearest = 1e3;
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    // Each face tilts and pushes in and out on its own slow beats, so the stone keeps re-forming:
    // faces grow, shrink and swallow their neighbors, but each stays flat.
    vec3 f = normalize(FACES[i].xyz + mix(0.26, 0.36, uStress) * vec3(sin(t * 0.52 + fi * 1.3), sin(t * 0.45 + fi * 2.1), sin(t * 0.38 + fi * 2.9)));
    float d = FACES[i].w * (1.0 + mix(0.12, 0.16, uStress) * sin(t * 0.62 + fi * 1.9)) + grow;
    float c = dot(n, f);
    dist[i] = c > 0.05 ? d / c : 1e3;
    nearest = min(nearest, dist[i]);
  }
  float sum = 0.0;
  for (int i = 0; i < 14; i++) sum += exp(-(dist[i] - nearest) / k);
  float r = nearest - k * log(sum);
  return (r + 0.12 * ripple(n) + 0.1 * shock(n) + 0.5 * ferro(n)) * squash(n);
}
float shellRadius(vec3 n, float t) {
  return facets(n, t, 0.0, 0.006);
}
`;

/** The stone's shape for the vertex shaders: uniforms, the shared effects, its radius, a point on it. */
const SHAPE = /* glsl */ `
uniform float uTime;
uniform float uStress;
${NOISE}
${RIPPLE}
${FERRO}
${STONE_RADIUS}
vec3 shellPoint(vec3 n, float t) {
  n = normalize(n);
  return n * shellRadius(n, t);
}
`;

/**
 * The glass's outer radius at a direction: the stone's faces pushed out by the glass's thickness,
 * so the glass is cut like the stone, with the same flat faces and crisp edges, an even layer over
 * each face. (In the stone's units, since the stone is drawn at STONE scale.)
 */
const GLASS_RADIUS = /* glsl */ `
float glassRadius(vec3 n, float t) {
  // Cut glass: edges as sharp as the mesh allows, so they look like they could cut.
  return facets(n, t, ${(GLASS / STONE).toFixed(3)}, 0.004) * ${STONE.toFixed(3)};
}
`;

/** The outside of the glass, for the particle layer, so motes rise off the glass rather than inside it. */
const SURFACE = /* glsl */ `
${STONE_RADIUS}
${GLASS_RADIUS}
float orbSurface(vec3 n) {
  return glassRadius(normalize(n), uTime * mix(0.32, 1.0, uStress));
}
`;

/** The glass's shape in the vertex shader, with normals from the shape itself (as SHELL_NORMAL does). */
const GLASS_NORMAL = /* glsl */ `
float shellT = uTime * mix(0.32, 1.0, uStress);
vec3 shellN = normalize(normal);
vec3 shellA = normalize(cross(shellN, abs(shellN.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
vec3 shellB = cross(shellN, shellA);
vec3 glassP = glassPoint(shellN, shellT);
vec3 glassDu = glassPoint(shellN + shellA * 0.004, shellT) - glassP;
vec3 glassDv = glassPoint(shellN + shellB * 0.004, shellT) - glassP;
vec3 objectNormal = normalize(cross(glassDu, glassDv));
if (dot(objectNormal, shellN) < 0.0) objectNormal = -objectNormal;
`;

/**
 * Play-of-color, as opal makes it. Opal is silica spheres (150–300 nm) stacked in small crystal
 * domains; each domain reflects one wavelength by Bragg diffraction, λ = 2·n·d·cosθ, where d is its
 * layer spacing and θ the angle between its layers' normal and the light and view. So:
 *
 * - The stone is split into domains (3D Voronoi cells), each with its own spacing and orientation.
 * - A domain lights up only near its Bragg angle (the half vector between key light and eye lined
 *   up with its layer normal), in the color that angle gives, shifting toward blue as it tilts
 *   away, so colors flash and slide as the orb turns.
 * - The domains sit a little under the surface, at two depths seen with parallax along the view,
 *   so the fire reads as inside the stone rather than painted on it.
 *
 * Calm, the spacing is small, giving greens, blues and violets (a white opal); stress widens it
 * toward gold, orange and red (a fire opal).
 */
const PLAY_OF_COLOR = /* glsl */ `
#include <emissivemap_fragment>
{
  vec3 V = normalize(vViewPosition);
  vec3 N = normalize(normal);
  // The stone's own axes in view space, so its domains turn with it.
  mat3 toView = mat3(normalize(vAxisX), normalize(vAxisY), normalize(vAxisZ));
  vec3 Vobj = transpose(toView) * V;
  vec3 L = normalize(vec3(-0.35, 0.85, 0.45));
  vec3 Hv = normalize(L + V);
  // Spacing range in nm: small calm (greens, blues), wide stressed (golds, reds).
  float dLo = mix(168.0, 228.0, uStress);
  float dHi = mix(212.0, 262.0, uStress);
  vec3 fire = vec3(0.0);
  for (int layer = 0; layer < 2; layer++) {
    float depth = layer == 0 ? 0.03 : 0.09;
    // Seen through the surface: a little deeper along the view for each layer.
    vec3 P = (vOpalPos - Vobj * depth) * mix(4.2, 2.8, float(layer)) + float(layer) * 17.0;
    vec3 cell; float edge;
    opalDomain(P, cell, edge);
    vec3 h = opalHash(cell);
    // The domain's layer normal and spacing.
    // Its layers ripple a little across it (opal's domains are never perfectly flat), so the color
    // rolls across a patch instead of filling it evenly.
    vec3 ripple = 0.28 * sin(P.yzx * 2.3 + h * 6.2831) + 0.14 * sin(P.zxy * 5.1 + h.zxy * 6.2831);
    vec3 lattice = normalize(toView * normalize(h * 2.0 - 1.0 + ripple));
    float d = mix(dLo, dHi, fract(h.x * 7.3 + h.z * 3.1));
    float c = abs(dot(Hv, lattice));
    // Bragg: n_eff ~1.37 for silica spheres in air-filled voids.
    float lambda = 2.0 * 1.37 * d * c;
    // Bright only near the Bragg angle; domains are speckled at their edges.
    float strength = pow(c, 7.0) * smoothstep(0.0, 0.22, edge) * (0.45 + 0.55 * h.y);
    fire += wavelengthToRgb(lambda) * strength * (layer == 0 ? 1.0 : 0.65);
  }
  totalEmissiveRadiance += fire * 1.1;
  // The stone's own milky glow: opal is bright from within, never gray.
  totalEmissiveRadiance += vec3(0.76, 0.88, 0.82) * 0.22;
  // Milky translucency at the thin rim, cool white.
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  totalEmissiveRadiance += vec3(0.82, 0.96, 0.9) * rim * 0.14;
}
`;

/** Helpers for the play-of-color: domain cells, their hashes, and a visible wavelength as a color. */
const OPAL_HELPERS = /* glsl */ `
vec3 opalHash(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}
// The domain p falls in (3D Voronoi), and how far p is inside its edge.
void opalDomain(vec3 p, out vec3 cell, out float edge) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  vec3 best = i;
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
      for (int z = -1; z <= 1; z++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 r = g + opalHash(i + g) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; best = i + g; }
        else if (d < d2) d2 = d;
      }
  cell = best;
  edge = sqrt(d2) - sqrt(d1);
}
// A wavelength in nm as an RGB color (black outside 380–700 nm).
vec3 wavelengthToRgb(float w) {
  vec3 c = vec3(0.0);
  if (w >= 380.0 && w < 440.0) c = vec3(-(w - 440.0) / 60.0, 0.0, 1.0);
  else if (w < 490.0 && w >= 440.0) c = vec3(0.0, (w - 440.0) / 50.0, 1.0);
  else if (w < 510.0 && w >= 490.0) c = vec3(0.0, 1.0, -(w - 510.0) / 20.0);
  else if (w < 580.0 && w >= 510.0) c = vec3((w - 510.0) / 70.0, 1.0, 0.0);
  else if (w < 645.0 && w >= 580.0) c = vec3(1.0, -(w - 645.0) / 65.0, 0.0);
  else if (w <= 700.0 && w >= 645.0) c = vec3(1.0, 0.0, 0.0);
  // Fades at the ends of what the eye sees.
  float fade = w < 420.0 ? 0.3 + 0.7 * (w - 380.0) / 40.0 : w > 680.0 ? 0.3 + 0.7 * (700.0 - w) / 20.0 : 1.0;
  return c * clamp(fade, 0.0, 1.0);
}
`;

function shareUniforms(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: OrbUniforms) {
  Object.assign(shader.uniforms, {
    uTime: uniforms.uTime,
    uStress: uniforms.uStress,
    uRippleAge: uniforms.uRippleAge,
    uShockAge: uniforms.uShockAge,
    uShockDir: uniforms.uShockDir,
    uSquash: uniforms.uSquash,
    uRippleOrigin: uniforms.uRippleOrigin,
    uSpike: uniforms.uSpike,
    uSpikeDir: uniforms.uSpikeDir,
    uClock: uniforms.uClock,
  });
}

/** The layer the stone is drawn on, apart from the main view (see prerender). */
const STONE_LAYER = 3;

export function buildOpalOrb(uniforms: OrbUniforms, renderer: THREE.WebGLRenderer) {
  // The glass's view of what's inside it: the stone alone, drawn each frame at screen size, with
  // mipmaps so the frosted glass can see it blurred, and multisampled so its edges are smooth.
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
  target.texture.generateMipmaps = true;
  target.texture.minFilter = THREE.LinearMipmapLinearFilter;
  const inside = { value: target.texture };
  const viewport = { value: new THREE.Vector2(1, 1) };
  const group = new THREE.Group();

  // The stone.
  const stoneGeometry = new THREE.IcosahedronGeometry(1, 128);
  const stone = new THREE.MeshPhysicalMaterial({
    // Each face lit from its own plane, so its edges are hard breaks in the light, like the glass's.
    flatShading: true,
    color: new THREE.Color(0.86, 0.95, 0.9),
    metalness: 0,
    roughness: 0.32,
    ior: 1.45,
    // Under glass: its own shine is soft; the glass carries the gloss.
    specularIntensity: 0.2,
    sheen: 0.3,
    sheenColor: new THREE.Color(0.8, 1.0, 0.9),
    sheenRoughness: 0.5,
    envMapIntensity: 0.8,
  });
  stone.onBeforeCompile = (shader) => {
    shareUniforms(shader, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${SHAPE}\nvarying vec3 vOpalPos;\nvarying vec3 vAxisX;\nvarying vec3 vAxisY;\nvarying vec3 vAxisZ;`)
      .replace(
        "#include <beginnormal_vertex>",
        `${SHELL_NORMAL}\nvOpalPos = shellPos;\nvAxisX = normalMatrix * vec3(1.0, 0.0, 0.0);\nvAxisY = normalMatrix * vec3(0.0, 1.0, 0.0);\nvAxisZ = normalMatrix * vec3(0.0, 0.0, 1.0);`,
      )
      .replace("#include <begin_vertex>", `vec3 transformed = shellPos * ${STONE.toFixed(3)};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform float uStress;\nuniform float uTime;\nvarying vec3 vOpalPos;\nvarying vec3 vAxisX;\nvarying vec3 vAxisY;\nvarying vec3 vAxisZ;\n${OPAL_HELPERS}`)
      .replace("#include <emissivemap_fragment>", PLAY_OF_COLOR);
  };
  // The stone is seen only through the glass (which refracts it), so it's drawn on its own layer,
  // into the glass's view of what's inside (see prerender), not straight to the screen.
  const stoneMesh = new THREE.Mesh(stoneGeometry, stone);
  stoneMesh.layers.set(STONE_LAYER);
  group.add(stoneMesh);

  // The glass over it, drawn after the stone.
  const glassGeometry = new THREE.IcosahedronGeometry(1, 128);
  // The glass: drawn as a see-through layer over the stone, not by refraction. three's refraction
  // looks through to a snapshot of what's behind, which around the orb is empty canvas, so clear
  // glass came out with seams where the stone ended or, pushed harder, murky. Here the stone shows
  // through untouched; the glass adds what clear glass shows on its own: reflections of the studio,
  // brighter where the light grazes it, a faint aqua at its thick outline, and frost toward the top.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.02,
    ior: 1.5,
    specularIntensity: 1,
    envMapIntensity: 1.3,
    transparent: true,
    depthWrite: false,
    // Each face lit from its own plane, so every edge is a hard break in the reflections.
    flatShading: true,
  });
  glass.onBeforeCompile = (shader) => {
    shareUniforms(shader, uniforms);
    Object.assign(shader.uniforms, { uInside: inside, uViewport: viewport });
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\n${SHAPE}\n${GLASS_RADIUS}\nvarying float vGlassHeight;\nvec3 glassPoint(vec3 n, float t) { n = normalize(n); return n * glassRadius(n, t); }`,
      )
      .replace("#include <beginnormal_vertex>", GLASS_NORMAL)
      .replace("#include <begin_vertex>", "vec3 transformed = glassP;\nvGlassHeight = glassP.y;");
    // Frost (rougher and milkier toward the top, as if sandblasted) is off for now: glassFrost is
    // held at 0. Remove the "0.0 *" to bring it back, clear over the lower third and frosting above.
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlassHeight;\nuniform sampler2D uInside;\nuniform vec2 uViewport;")
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nfloat glassFrost = 0.0 * smoothstep(-0.48, 0.95, vGlassHeight);\nroughnessFactor = mix(0.02, 0.42, glassFrost);",
      )
      // What you see through the glass: the stone, refracted by the facet you look through (each
      // facet bends it its own way, so it breaks and shifts at the glass's edges, as real cut glass
      // does), with red, green and blue bent slightly apart (the faint color fringes of thick glass)
      // and blurred where the glass is frosted. Where the refracted view misses the stone, the glass
      // is see-through. On top: the glass's own milkiness (frost, and more at its thick outline,
      // tinted faint aqua), its reflections at full strength, and bright lines where facets meet.
      .replace(
        "#include <opaque_fragment>",
        `vec3 gN = normalize(normal);
vec3 gV = normalize(vViewPosition);
float glassFacing = clamp(dot(gN, gV), 0.0, 1.0);
float glassEdge = pow(1.0 - glassFacing, 2.5);
vec2 screen = gl_FragCoord.xy / uViewport;
vec2 bend = refract(-gV, gN, 1.0 / 1.5).xy * 0.07;
float blur = mix(0.6, 4.5, glassFrost);
vec4 seenG = textureLod(uInside, screen + bend, blur);
float seenR = textureLod(uInside, screen + bend * 1.06, blur).r;
float seenB = textureLod(uInside, screen + bend * 0.94, blur).b;
float cover = smoothstep(0.02, 0.98, seenG.a);
vec3 seen = vec3(seenR, seenG.g, seenB) / max(seenG.a, 0.001);
float glassHaze = mix(0.03, 0.45, glassFrost) + glassEdge * 0.35;
vec3 glassTint = mix(vec3(0.96, 0.98, 1.0), vec3(0.74, 0.9, 0.9), glassEdge * 0.7);
float ridge = clamp(length(fwidth(gN)) * 6.0 - 0.15, 0.0, 1.0);
vec3 shine = totalSpecular + vec3(ridge * 0.7);
float glassShine = clamp(max(shine.r, max(shine.g, shine.b)), 0.0, 1.0);
vec3 premult = seen * cover * (1.0 - glassHaze) + totalDiffuse * glassTint * glassHaze + shine;
float glassAlpha = clamp(cover * (1.0 - glassHaze) + glassHaze + glassShine, 0.0, 1.0);
gl_FragColor = vec4(premult / max(glassAlpha, 0.001), glassAlpha);`,
      );
  };
  const glassMesh = new THREE.Mesh(glassGeometry, glass);
  glassMesh.renderOrder = 1;
  group.add(glassMesh);
  // Oblong, like a cabochon-cut opal: drawn out along one axis, slimmer across, about the same
  // volume. On the group, so the motes and the glass stretch with the stone as it turns.
  // A little smaller than the other orbs overall (80%, then 15% back up: 92%).
  const size = 0.8 * 1.15;
  group.scale.set(0.88 * size, 1.32 * size, 0.88 * size);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = porcelainStudio();
  const environment = pmrem.fromScene(room, 0.02).texture;
  // The glass reflects a dark studio with a few bright strips: crisp streaks of light sliding over
  // its facets, the way clear glass reads, rather than a soft gray sheen.
  const strips = darkStudio();
  const glassEnvironment = pmrem.fromScene(strips, 0.01).texture;
  glass.envMap = glassEnvironment;
  glass.envMapIntensity = 2.6;
  pmrem.dispose();
  for (const scene of [room, strips])
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });

  // Draws the stone (only) into the glass's view of what's inside, each frame before the scene.
  const size2 = new THREE.Vector2();
  const prerender = (r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => {
    r.getDrawingBufferSize(size2);
    if (target.width !== size2.x || target.height !== size2.y) target.setSize(size2.x, size2.y);
    viewport.value.copy(size2);
    const before = r.getRenderTarget();
    const clear = r.getClearColor(new THREE.Color());
    const clearAlpha = r.getClearAlpha();
    const layers = camera.layers.mask;
    camera.layers.set(STONE_LAYER);
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(scene, camera);
    r.setRenderTarget(before);
    r.setClearColor(clear, clearAlpha);
    camera.layers.mask = layers;
  };

  return {
    group,
    environment,
    prerender,
    surface: SURFACE,
    dispose: () => {
      stoneGeometry.dispose();
      stone.dispose();
      glassGeometry.dispose();
      glass.dispose();
      environment.dispose();
      glassEnvironment.dispose();
      target.dispose();
    },
  };
}
