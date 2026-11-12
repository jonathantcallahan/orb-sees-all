/**
 * Kitten: a hollow faceted gem of glass, lit blue, with a cross of light at its center.
 *
 * The gem has forty-eight triangular faces between twenty-six tips: one over each of the cross's
 * six points and one over each place between them, so its outline stays much the same as it
 * turns. Each triangle bends from all its neighbors, so each reads as its own face. Its faces are
 * flat, so each lights up whole when it catches a light, its edges and tips softly rounded.
 *
 * It's colorless glass, hollow with walls about a twelfth of its radius (half an inch if it's a
 * foot across), the cross floating in the hollow, whose own facets show as a smaller gem within,
 * with a bright rim where the glass mirrors completely. All its color is the light it mirrors,
 * outside and back from within, from a room of royal blue light, brighter up and to the right,
 * with large panels of lavender, pink, violet, teal and mint light. It mirrors more the more a
 * facet is turned away from you (Fresnel), and a facet facing a panel lights up as a whole pane of
 * that color, the panes changing as it turns. Each facet also bends the view of the inside a
 * little (slightly differently for each color, so it fringes at the edges) with a faint waviness.
 * A thin-film sheen runs along its outline. No lines are drawn: the facets show only by how each
 * bends the view and what it mirrors.
 *
 * The cross is a six-pointed star, a point along each way of all three axes, all alike: between
 * any two neighboring points its outline is a four-pointed star's, the sides curving in to rounded
 * tips, and its faces meet along each arm in a soft crease, each face between three points
 * dished in slightly and smoothly. It's matte, lit from above: pale lavender where it faces up and
 * a warm pink where it faces down, so the crease along each level arm reads as a shelf as it
 * turns. It gives off a little light of its own, more where the light falls full on it, and
 * lights the glass around it.
 *
 * Gem and cross turn together about the upright axis through their top and bottom points, leaning
 * only toward the cursor (see PressureBlob). The shared effects (a finished task's ripple, an
 * update's hit, the spikes) move its surface like the other orbs', and under stress it warms
 * toward magenta.
 *
 * Drawn in three steps, each showing the last through itself, bent: the hollow (its far side, then
 * the cross), then what's seen through the outside (the far wall from within, then the hollow's
 * near side), then the outside's near faces, with their reflections over it. Then it's finished
 * with its light bleeding softly into what's around it, more where it's bright (see orbPost). A
 * soft film grain is on what's inside the glass, the near faces' reflections left clear.
 */
import * as THREE from "three";
import { NOISE } from "./orbNoise";
import { FERRO, RIPPLE, type OrbUniforms } from "./orbEffects";
import type { OrbMotes } from "./orbParticles";
import { createBleedAndGrain, FILM_GRAIN } from "./orbPost";

/**
 * How far out the gem's tips over the creases are, against the others' 1: a little lower, so each
 * triangle bends from all its neighbors (level, the triangles each side of a line from a point's
 * tip to a face's tip lie nearly flat, and read as one square).
 */
const GEM_CREASE = 0.93;

/**
 * The gem's forty-eight triangular faces, between twenty-six tips: one over each of the cross's six
 * points, one over the middle of each face between three points (8), and one over each crease
 * between two points (12), those a little lower. With a tip every way it could turn to the side,
 * its outline stays much the same as it turns. Each face spans a point's tip, a crease's and a
 * face's, all neighbors; all forty-eight are alike, so all sit at the same distance from the center.
 */
function gemFaces(): { faces: THREE.Vector3[]; distance: number } {
  const points: THREE.Vector3[] = [];
  const creases: THREE.Vector3[] = [];
  const middles: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++)
    for (const s of [-1, 1]) {
      const v = new THREE.Vector3();
      v.setComponent(i, s);
      points.push(v);
    }
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      for (const s of [-1, 1])
        for (const u of [-1, 1]) {
          const v = new THREE.Vector3();
          v.setComponent(i, s).setComponent(j, u);
          creases.push(v.normalize().multiplyScalar(GEM_CREASE));
        }
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) middles.push(new THREE.Vector3(a, b, c).normalize());
  const faces: THREE.Vector3[] = [];
  for (const p of points)
    for (const e of creases)
      for (const m of middles) {
        // Neighbors only: the crease and face beside this point, the face beside this crease.
        if (p.dot(e) < 0.7 * GEM_CREASE || p.dot(m) < 0.57 || e.dot(m) < 0.8 * GEM_CREASE) continue;
        const f = e.clone().sub(p).cross(m.clone().sub(p)).normalize();
        faces.push(f.dot(p) < 0 ? f.negate() : f);
      }
  // The points' and faces' tips at 1.
  return { faces, distance: faces[0].dot(points[0]) };
}
const GEM = gemFaces();

/** The gem's faces' normals, for the shaders. */
const GEM_FACES = /* glsl */ `
const vec3 KIT_FACES[${GEM.faces.length}] = vec3[${GEM.faces.length}](
  ${GEM.faces.map((f) => `vec3(${f.x.toFixed(6)}, ${f.y.toFixed(6)}, ${f.z.toFixed(6)})`).join(",\n  ")}
);
const int KIT_COUNT = ${GEM.faces.length};
const float KIT_IN = ${GEM.distance.toFixed(6)};
// How rounded its edges are (a smooth minimum of the faces, about this wide).
const float KIT_EDGE = 0.012;
// The sphere its tips are rounded off at, and how softly.
const float KIT_CAP = 0.975;
const float KIT_CAP_SOFT = 0.02;
`;

/**
 * The glass's normal at a point, for its fragment shaders: worked out exactly for the point rather
 * than blended from the mesh's corners, so facets meet crisply.
 */
const FACETS = /* glsl */ `
${GEM_FACES}
// The flat facet's normal, rolling smoothly into its neighbor's over the rounded edge between them
// (weighted as the shape's smooth minimum weights them), and toward its rounded tips into the
// sphere's they're rounded to, as the shape blends into it.
vec3 facetNormal(vec3 p) {
  vec3 dir = normalize(p);
  float nearest = 1e3;
  for (int i = 0; i < KIT_COUNT; i++) {
    float c = dot(dir, KIT_FACES[i]);
    if (c > 0.02) nearest = min(nearest, KIT_IN / c);
  }
  vec3 sum = vec3(0.0);
  float weight = 0.0;
  for (int i = 0; i < KIT_COUNT; i++) {
    float c = dot(dir, KIT_FACES[i]);
    if (c > 0.02) {
      float w = exp(-(KIT_IN / c - nearest) / KIT_EDGE);
      sum += KIT_FACES[i] * w;
      weight += w;
    }
  }
  float poly = nearest - KIT_EDGE * log(weight);
  // How much the tip's rounding takes over here (as kitGem's second smooth minimum weighs it).
  float m = min(poly, KIT_CAP);
  float faces = exp(-(poly - m) / KIT_CAP_SOFT);
  float cap = exp(-(KIT_CAP - m) / KIT_CAP_SOFT);
  return normalize(mix(normalize(sum), dir, cap / (faces + cap)));
}
// In view space: the facet's, but the surface's own where the shared effects (ripples, spikes)
// bend it.
vec3 gemNormal() {
  vec3 surface = normalize(vNormalV);
  vec3 facet = normalize(vNormalMatrix * facetNormal(vObj));
  return normalize(mix(facet, surface, smoothstep(0.15, 0.4, 1.0 - dot(facet, surface))));
}
`;

/**
 * The gem's shape: its forty-eight flat faces, their edges softly rounded, and its points rounded
 * off where they reach past a sphere a little inside them.
 */
const SHAPE = /* glsl */ `
${GEM_FACES}
// Distance to each face along a direction (far when it faces away).
void kitDistances(vec3 n, out float d[${GEM.faces.length}]) {
  for (int i = 0; i < KIT_COUNT; i++) {
    float c = dot(n, KIT_FACES[i]);
    d[i] = c > 0.02 ? KIT_IN / c : 1e3;
  }
}
// The gem's radius along a direction: the nearest face, its edges eased (a smooth minimum), then
// its points rounded where they'd reach past the sphere.
float kitGem(vec3 n) {
  n = normalize(n);
  float d[${GEM.faces.length}];
  kitDistances(n, d);
  float nearest = 1e3;
  for (int i = 0; i < KIT_COUNT; i++) nearest = min(nearest, d[i]);
  float sum = 0.0;
  for (int i = 0; i < KIT_COUNT; i++) sum += exp(-(d[i] - nearest) / KIT_EDGE);
  float poly = nearest - KIT_EDGE * log(sum);
  float m = min(poly, KIT_CAP);
  return m - KIT_CAP_SOFT * log(exp(-(poly - m) / KIT_CAP_SOFT) + exp(-(KIT_CAP - m) / KIT_CAP_SOFT));
}
// With the shared effects.
float kitRadius(vec3 n) {
  n = normalize(n);
  return (kitGem(n) + 0.1 * ripple(n) + 0.08 * shock(n) + 0.45 * ferro(n)) * squash(n);
}
`;

/** How far the cross's points reach from the center (the gem's corners are at 1). */
const CROSS_REACH = 0.46;

/**
 * How strong the film grain is on what's inside the glass, its far faces and the cross (see
 * FILM_GRAIN). The near faces have none, so their reflections stay clear.
 */
const GRAIN = 0.09;

/** Where the cross is on screen from a point of the gem: for its glow. */
const GLOW = /* glsl */ `
// How close the line of sight through this point passes to the gem's center, in the cross's
// reach: 0 straight through it, 1 at its points' tips as seen.
float crossSight(vec3 viewPos, vec3 center, float scale) {
  vec3 rd = normalize(viewPos);
  vec3 off = center - rd * dot(center, rd);
  return length(off) / (scale * ${CROSS_REACH.toFixed(3)});
}
// The cross's soft glow through the glass: brightest close around it, fading out.
vec3 crossGlow(float sight, float stress) {
  vec3 tint = mix(vec3(0.95, 0.6, 1.0), vec3(1.0, 0.45, 0.75), stress);
  return tint * (0.28 * exp(-max(sight - 0.55, 0.0) * 4.0));
}
`;

const GEM_VERTEX = /* glsl */ `
// 1 for the gem's outside, less for the hollow inside it (the same shape, smaller).
uniform float uInset;
varying vec3 vObj;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vCenter;
varying float vScale;
varying mat3 vNormalMatrix;
${NOISE}
${RIPPLE}
${FERRO}
${SHAPE}
vec3 kitPoint(vec3 n) {
  n = normalize(n);
  return n * kitRadius(n);
}
void main() {
  vec3 n = normalize(position);
  vec3 p = kitPoint(n);
  // The normal from the surface itself, by finite differences.
  vec3 a = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(n, a);
  vec3 normal = normalize(cross(kitPoint(n + a * 0.003) - p, kitPoint(n + b * 0.003) - p));
  if (dot(normal, n) < 0.0) normal = -normal;
  p *= uInset;
  vObj = p;
  vNormalMatrix = normalMatrix;
  vNormalV = normalize(normalMatrix * normal);
  vec4 view = modelViewMatrix * vec4(p, 1.0);
  vViewPos = view.xyz;
  vCenter = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vScale = length(modelViewMatrix[0].xyz);
  gl_Position = projectionMatrix * view;
}
`;

/**
 * The studio the glass mirrors, by reflected direction in view space (x right, y up, z toward
 * you): a room filled with deep royal blue light, brighter up and to the right, with large panels
 * of colored light, lavender to the right, pink up and to the right, violet below, teal to the
 * left and mint up and to the left. The glass has no color of its own; all of it comes from this.
 * Each flat facet mirrors one direction, so a facet facing a panel lights up whole, a pane of that
 * color, and passes on to the next as it turns.
 */
const STUDIO = /* glsl */ `
// A round panel of light around direction d, its edge where the angle's cosine is \`edge\`, soft.
float panel(vec3 r, vec3 d, float edge) {
  return smoothstep(edge - 0.02, edge + 0.01, dot(r, normalize(d)));
}
vec3 studio(vec3 r, float stress, float panels) {
  vec3 pink = mix(vec3(1.0, 0.42, 0.9), vec3(1.0, 0.3, 0.55), stress);
  vec3 lavender = mix(vec3(0.72, 0.6, 1.0), vec3(0.95, 0.5, 0.85), stress * 0.5);
  // The room itself: deep royal blue light, brighter up and to the right, warming toward magenta
  // under stress. All the glass's color comes from here and the panels.
  vec3 deep = mix(vec3(0.03, 0.03, 0.32), vec3(0.18, 0.03, 0.32), stress * 0.6);
  vec3 bright = mix(vec3(0.3, 0.26, 1.0), vec3(0.55, 0.25, 0.92), stress * 0.6);
  vec3 c = mix(deep, bright, smoothstep(-0.7, 1.0, 0.5 * r.x + 0.8 * r.y));
  vec3 p = lavender * panel(r, vec3(0.9, 0.05, 0.35), 0.88) * 1.7;
  p += pink * panel(r, vec3(0.45, 0.8, 0.25), 0.9) * 1.5;
  p += vec3(0.45, 0.3, 1.0) * panel(r, vec3(0.25, -0.85, 0.3), 0.9) * 1.2;
  p += vec3(0.15, 0.75, 0.85) * panel(r, vec3(-0.9, -0.2, 0.3), 0.88) * 1.4;
  p += vec3(0.4, 1.0, 0.75) * panel(r, vec3(-0.5, 0.7, 0.3), 0.92) * 1.1;
  return c + p * panels;
}
`;

/** The thin-film sheen where the glass is seen edge-on: violet, cyan, mint, then a pale mint. */
const FILM = /* glsl */ `
vec3 film(float graze, float around) {
  float h = clamp(graze + 0.08 * sin(around * 2.0 + 0.8), 0.0, 1.0);
  vec3 c = mix(vec3(0.5, 0.38, 1.0), vec3(0.2, 0.82, 1.0), smoothstep(0.55, 0.72, h));
  c = mix(c, vec3(0.42, 1.0, 0.74), smoothstep(0.7, 0.85, h));
  c = mix(c, vec3(0.86, 1.0, 0.96), smoothstep(0.88, 1.0, h));
  return mix(c, vec3(1.0, 0.5, 0.88), 0.4 * smoothstep(0.3, 0.9, sin(around * 3.0 - 1.2)) * (1.0 - smoothstep(0.75, 0.95, h)));
}
`;

const GEM_VARYINGS = /* glsl */ `
uniform float uStress;
varying vec3 vObj;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vCenter;
varying float vScale;
varying mat3 vNormalMatrix;
`;

/**
 * A far wall seen from within: the outside's far faces behind the hollow, and the hollow's own far
 * side behind the cross. Colorless, so all that shows is what it mirrors back inside, the room's
 * blue light and its panels faintly, and the cross's glow. Opaque; the glass in front then bends
 * it a little (CAVITY_FRONT for the hollow's, FRONT_FRAGMENT for the outside's).
 */
const BACK_FRAGMENT = /* glsl */ `
${GEM_VARYINGS}
${STUDIO}
${GLOW}
${FILM_GRAIN}
void main() {
  // Turned to face inward, toward you.
  vec3 n = -normalize(vNormalV);
  vec3 v = normalize(-vViewPos);
  // Mostly the room's blue; the panels only faintly, from within.
  vec3 c = studio(reflect(-v, n), uStress, 0.25) * 0.8;
  c += crossGlow(crossSight(vViewPos, vCenter, vScale), uStress);
  c = filmGrain(c, ${GRAIN.toFixed(3)});
  gl_FragColor = vec4(min(c, vec3(1.0)), 1.0);
}
`;

/**
 * How far glass bends what's seen through it (the outside's near faces, and the hollow's near side),
 * in the share of the canvas per unit of tilt.
 */
const GLASS_BEND = 0.05;
/** A faint waviness in that, like old leaded glass, in the same units. */
const GLASS_WAVE = 0.004;

/**
 * How much of the gem's size the hollow inside it is: the walls are the rest, about a twelfth of
 * its radius (half an inch if it's a foot across).
 */
const GEM_HOLLOW = 0.92;

/**
 * The hollow's near side, seen from within the near wall: through it, the hollow (tCavity: its far
 * side and the cross), bent the other way as light leaves the glass, and faintly, what its facets
 * mirror; toward its outline, where the glass mirrors completely, only that. The hollow's own
 * facets show, a smaller gem within the gem, with a bright rim.
 */
const CAVITY_FRONT = /* glsl */ `
${GEM_VARYINGS}
${STUDIO}
${FACETS}
uniform sampler2D tCavity;
uniform vec2 uViewport;
void main() {
  vec3 n = gemNormal();
  vec3 v = normalize(-vViewPos);
  float graze = 1.0 - clamp(dot(n, v), 0.0, 1.0);
  vec2 uv = gl_FragCoord.xy / uViewport;
  vec2 bend = -n.xy * ${GLASS_BEND.toFixed(4)};
  vec4 seen = texture2D(tCavity, uv - bend);
  vec3 through = vec3(texture2D(tCavity, uv - bend * 0.9).r, seen.g, texture2D(tCavity, uv - bend * 1.12).b);
  // Seen this aslant from inside glass, light can't get out (total internal reflection): toward
  // its outline the hollow mirrors completely, a bright rim, and nothing of it is seen through.
  vec3 mirrored = studio(reflect(-v, n), uStress, 0.5);
  float fres = max(0.05 + 0.3 * graze * graze, smoothstep(0.22, 0.45, graze));
  through = mix(mirrored, through, seen.a);
  gl_FragColor = vec4(mix(through, mirrored, fres), 1.0);
}
`;

/**
 * The glass's near faces, which finish the picture. Through each you see the inside and the cross
 * (tInside, drawn first), shifted a little by the facet's tilt as glass bends light, with a faint
 * waviness, and blue bent a touch more than red, so the image fringes with color at the facets'
 * edges. It has no color of its own: it mirrors the studio, more toward its outline (Fresnel),
 * each facet lighting up as a whole pane, with a thin-film sheen right at the outline. No lines are
 * drawn: the facets show only by how each bends the view and what it mirrors.
 */
const FRONT_FRAGMENT = /* glsl */ `
${GEM_VARYINGS}
${STUDIO}
${FILM}
${GLOW}
${NOISE}
${FACETS}
uniform sampler2D tInside;
uniform vec2 uViewport;
void main() {
  vec3 n = gemNormal();
  vec3 v = normalize(-vViewPos);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  float graze = 1.0 - facing;
  vec3 r = reflect(-v, n);
  float fres = 0.15 + 0.85 * pow(graze, 1.3);
  // What's seen through, bent.
  vec2 uv = gl_FragCoord.xy / uViewport;
  vec2 bend = n.xy * ${GLASS_BEND.toFixed(4)} + vec2(snoise(vObj * 2.5), snoise(vObj * 2.5 + 7.1)) * ${GLASS_WAVE.toFixed(4)};
  vec4 seen = texture2D(tInside, uv - bend);
  vec3 through = vec3(texture2D(tInside, uv - bend * 0.9).r, seen.g, texture2D(tInside, uv - bend * 1.12).b);
  // Colorless: what's seen through, less what's mirrored instead.
  vec3 c = through * (1.0 - fres);
  // Right at the outline, where it's seen edge-on, a thin-film sheen.
  float around = atan(vObj.y, vObj.x);
  float edgeOn = smoothstep(0.78, 0.97, graze);
  c = mix(c, film(graze, around) * 1.5, edgeOn);
  // What it mirrors, as light over all that.
  c += studio(r, uStress, 1.0) * fres * (1.0 - edgeOn * 0.5);
  c += crossGlow(crossSight(vViewPos, vCenter, vScale), uStress) * 0.35;
  gl_FragColor = vec4(c, max(seen.a, edgeOn));
}
`;

/** Below 1, the cross's sides curve in between its points, drawn to a ridge along each arm. */
const CROSS_SIDE = 0.74;
/**
 * In the middle of each eighth, between three points: a little above CROSS_SIDE, so each face
 * there dishes in only slightly and evenly (much more and its middle bulges).
 */
const CROSS_PUFF = 0.79;
/** The radius its tips and ridges are rounded to, in its reach. */
const CROSS_ROUND = 0.12;

/**
 * How sharp the creases along its arms are: 0 pinches them to thin fins, more makes them softer
 * creases where its faces meet at an angle (and its tips a little wider).
 */
const CROSS_CREASE = 0.03;

/**
 * The star before it's rounded: how far it reaches along the unit direction (x, y, z). A
 * superellipsoid, |x|^p + |y|^p + |z|^p = 1, with p at CROSS_SIDE on the planes through its points
 * (the four-pointed star's outline in each of them) rising to CROSS_PUFF in the middle of each
 * eighth. Each |x|^p is eased to (|x| + crease)^p - crease^p, so its faces meet along each arm at
 * an angle, a crease, rather than pinching to a fin.
 */
function crossCore(x: number, y: number, z: number): number {
  x = Math.abs(x);
  y = Math.abs(y);
  z = Math.abs(z);
  // 0 on the planes through the points, 1 in the middle of each eighth, rising quickly off the
  // planes and evenly across the middle, so the face between is evenly curved.
  const middle = (27 * x * x * y * y * z * z) ** 0.25;
  const p = CROSS_SIDE + (CROSS_PUFF - CROSS_SIDE) * middle;
  const e = CROSS_CREASE;
  const eased = (t: number) => (t + e) ** p - e ** p;
  return (1 - CROSS_ROUND) * (eased(1) / (eased(x) + eased(y) + eased(z))) ** (1 / p);
}

/**
 * Directions from the center farther apart than this can't share a rounding ball of radius
 * CROSS_ROUND (see crossRound): the star comes no closer to its center than about 0.3.
 */
const NEAR = Math.asin(Math.min(1, CROSS_ROUND / 0.3));

/**
 * The cross along unit direction d once it's rounded: grown outward by CROSS_ROUND, which rounds
 * every tip into a ball and every ridge into a rounded edge. That's the farthest point along d of
 * any ball of that radius around a point of the star. The candidates are the star's ridges and
 * tips, in the planes through its points (where it's pinched sharp), taken densely, and its
 * smooth faces, searched around d.
 */
function crossRound(dx: number, dy: number, dz: number, ridges: Float64Array): number {
  const r2 = CROSS_ROUND * CROSS_ROUND;
  const reach = NEAR;
  const farthest = (ex: number, ey: number, ez: number, r: number) => {
    const along = r * (ex * dx + ey * dy + ez * dz);
    const off = r * r - along * along;
    return off > r2 || along <= 0 ? 0 : along + Math.sqrt(r2 - off);
  };
  let best = 0;
  const close = Math.cos(reach);
  for (let i = 0; i < ridges.length; i += 4) {
    if (ridges[i] * dx + ridges[i + 1] * dy + ridges[i + 2] * dz < close) continue;
    best = Math.max(best, farthest(ridges[i], ridges[i + 1], ridges[i + 2], ridges[i + 3]));
  }
  // The faces: a look around d (in the plane square to it), then closing in on the best.
  const ref = Math.abs(dx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = dy * ref[2] - dz * ref[1];
  let uy = dz * ref[0] - dx * ref[2];
  let uz = dx * ref[1] - dy * ref[0];
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = dy * uz - dz * uy;
  const vy = dz * ux - dx * uz;
  const vz = dx * uy - dy * ux;
  const at = (s: number, t: number) => {
    let ex = dx + ux * s + vx * t;
    let ey = dy + uy * s + vy * t;
    let ez = dz + uz * s + vz * t;
    const k = 1 / Math.sqrt(ex * ex + ey * ey + ez * ez);
    ex *= k;
    ey *= k;
    ez *= k;
    return farthest(ex, ey, ez, crossCore(ex, ey, ez));
  };
  let bs = 0;
  let bt = 0;
  let bv = at(0, 0);
  for (let ring = 1; ring <= 6; ring++) {
    for (let spoke = 0; spoke < 12; spoke++) {
      const a = (spoke / 12) * Math.PI * 2;
      const s = ((reach * ring) / 6) * Math.cos(a);
      const t = ((reach * ring) / 6) * Math.sin(a);
      const v = at(s, t);
      if (v > bv) [bv, bs, bt] = [v, s, t];
    }
  }
  for (let step = 0.03; step > 0.0005; step /= 2) {
    for (let moved = true, n = 0; moved && n < 4; n++) {
      moved = false;
      for (const [ds, dt] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const v = at(bs + ds, bt + dt);
        if (v > bv) [bv, bs, bt, moved] = [v, bs + ds, bt + dt, true];
      }
    }
  }
  return Math.max(best, bv);
}

const PHI = 72;
const PSI = 25;
const PHI_MAX = Math.acos(1 / Math.sqrt(3));
/**
 * The rounded cross's reach over one wedge of directions, |x| ≥ |y| ≥ |z| (it's the same in all
 * 48 mirror images of it), by the angle from the nearest point (0 to where three points meet) and
 * around it (0 on a ridge's plane to 45°), PHI by PSI steps.
 */
function reachTable(): Float32Array {
  const ridges: number[] = [];
  for (let i = 0; i <= 256; i++) {
    const a = (i / 256) * (Math.PI / 2);
    for (const [x, y, z] of [[Math.cos(a), Math.sin(a), 0], [Math.cos(a), 0, Math.sin(a)], [0, Math.cos(a), Math.sin(a)]]) {
      ridges.push(x, y, z, crossCore(x, y, z));
    }
  }
  const ridgeArray = Float64Array.from(ridges);
  const table = new Float32Array(PHI * PSI);
  for (let i = 0; i < PHI; i++) {
    for (let j = 0; j < PSI; j++) {
      const phi = (i / (PHI - 1)) * PHI_MAX;
      const psi = (j / (PSI - 1)) * (Math.PI / 4);
      table[i * PSI + j] = crossRound(Math.cos(phi), Math.sin(phi) * Math.cos(psi), Math.sin(phi) * Math.sin(psi), ridgeArray);
    }
  }
  return table;
}

/** Catmull-Rom weights: a smooth curve through four evenly spaced values, at t between the middle two. */
function smoothWeights(t: number): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [(-t + 2 * t2 - t3) / 2, (2 - 5 * t2 + 3 * t3) / 2, (t + 4 * t2 - 3 * t3) / 2, (t3 - t2) / 2];
}

/** The rounded cross's reach along the direction (x, y, z), smoothly between the table's values. */
function crossReachAt(table: Float32Array, x: number, y: number, z: number): number {
  // Folded into the wedge: a ≥ b ≥ c.
  let a = Math.abs(x);
  let b = Math.abs(y);
  let c = Math.abs(z);
  if (a < b) [a, b] = [b, a];
  if (b < c) [b, c] = [c, b];
  if (a < b) [a, b] = [b, a];
  const fi = (Math.acos(Math.min(1, a / Math.sqrt(a * a + b * b + c * c))) / PHI_MAX) * (PHI - 1);
  const fj = (Math.atan2(c, b) / (Math.PI / 4)) * (PSI - 1);
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  const wi = smoothWeights(fi - i0);
  const wj = smoothWeights(fj - j0);
  // Past the table's edges, mirrored: through a point's tip, across a ridge's plane, across |y| = |z|.
  const row = (i: number) => Math.min(Math.abs(i), PHI - 1);
  const col = (j: number) => (j < 0 ? -j : j > PSI - 1 ? 2 * (PSI - 1) - j : j);
  let sum = 0;
  for (let di = 0; di < 4; di++) {
    const r = row(i0 - 1 + di) * PSI;
    for (let dj = 0; dj < 4; dj++) sum += wi[di] * wj[dj] * table[r + col(j0 - 1 + dj)];
  }
  return sum;
}

interface CrossMesh {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
}
let crossMesh: CrossMesh | null = null;

/**
 * The cross's mesh: a sphere built from a cube's six faces (so each point's tip sits in the middle
 * of one, finely meshed), each vertex pushed out to the rounded star along its direction, with
 * its normal from the star's surface around it. Worked out once (about 60ms), then reused.
 */
function crossGeometry(): THREE.BufferGeometry {
  const mesh = (crossMesh ??= buildCrossMesh());
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
  return geometry;
}

function buildCrossMesh(): CrossMesh {
  const table = reachTable();
  const N = 96;
  const positions = new Float32Array(6 * (N + 1) * (N + 1) * 3);
  const normals = new Float32Array(positions.length);
  const index = new Uint32Array(6 * N * N * 6);
  const m = new THREE.Vector3();
  const ta = new THREE.Vector3();
  const tb = new THREE.Vector3();
  const p = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const qa = new THREE.Vector3();
  const qb = new THREE.Vector3();
  const point = (out: THREE.Vector3, d: THREE.Vector3) => {
    out.copy(d).normalize();
    return out.multiplyScalar(crossReachAt(table, out.x, out.y, out.z) * CROSS_REACH);
  };
  const X = new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  // Each face: its middle, and two directions across it whose cross product points outward.
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [X, Y, Z],
    [X.clone().negate(), Z, Y],
    [Y, Z, X],
    [Y.clone().negate(), X, Z],
    [Z, X, Y],
    [Z.clone().negate(), Y, X],
  ];
  const h = 0.004;
  let v = 0;
  let k = 0;
  for (const [mid, u, w] of faces) {
    const first = v;
    for (let i = 0; i <= N; i++) {
      // Evenly spaced in angle across the face, not in distance.
      const su = Math.tan(((i / N) * 2 - 1) * (Math.PI / 4));
      for (let j = 0; j <= N; j++) {
        const sw = Math.tan(((j / N) * 2 - 1) * (Math.PI / 4));
        m.copy(mid).addScaledVector(u, su).addScaledVector(w, sw).normalize();
        point(p, m);
        ta.crossVectors(m, Math.abs(m.y) < 0.99 ? Y : X).normalize();
        tb.crossVectors(m, ta);
        point(pa, qa.copy(m).addScaledVector(ta, h)).sub(point(qb, qa.copy(m).addScaledVector(ta, -h)));
        point(pb, qa.copy(m).addScaledVector(tb, h)).sub(point(qb, qa.copy(m).addScaledVector(tb, -h)));
        const n = pa.cross(pb).normalize();
        if (n.dot(m) < 0) n.negate();
        positions.set([p.x, p.y, p.z], v * 3);
        normals.set([n.x, n.y, n.z], v * 3);
        v++;
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const a = first + i * (N + 1) + j;
        const b = a + N + 1;
        index.set([a, b, b + 1, a, b + 1, a + 1], k);
        k += 6;
      }
    }
  }
  return { positions, normals, index };
}

/**
 * The cross's surface, for the motes it gives off while working: they rise off its points and
 * ridges inside the glass (see MOTES). crossCore's star, grown by its rounding, which is exact at
 * the tips and close enough between them for where a mote appears.
 */
const CROSS_SURFACE = /* glsl */ `
float orbSurface(vec3 n) {
  vec3 a = abs(normalize(n));
  float middle = pow(27.0 * a.x * a.x * a.y * a.y * a.z * a.z, 0.25);
  float p = ${CROSS_SIDE.toFixed(3)} + ${(CROSS_PUFF - CROSS_SIDE).toFixed(3)} * middle;
  float e = ${CROSS_CREASE.toFixed(3)};
  float ep = pow(e, p);
  float sum = pow(a.x + e, p) + pow(a.y + e, p) + pow(a.z + e, p) - 3.0 * ep;
  float core = ${(1 - CROSS_ROUND).toFixed(3)} * pow((pow(1.0 + e, p) - ep) / sum, 1.0 / p);
  return ${CROSS_REACH.toFixed(3)} * (core + ${CROSS_ROUND.toFixed(3)});
}
`;

/**
 * Kitten's working motes: off the cross rather than the glass, close to it (they'd reach the
 * glass from as far off as the other looks' motes start), and drawn with the cross in the hollow
 * (layer 2), so they're seen through the glass, bent like the cross. Larger and brighter than the
 * other looks' (the lit glass behind them would swallow those). Which of the cross's directions
 * give them off is PressureBlob's TIP for Kitten.
 */
const MOTES: OrbMotes = { layer: 2, gap: [0.04, 0.18], size: 1.6, boost: 2.5 };

const CROSS_VERTEX = /* glsl */ `
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vCenter;
varying float vScale;
void main() {
  vNormalV = normalize(normalMatrix * normal);
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vViewPos = view.xyz;
  vCenter = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vScale = length(modelViewMatrix[0].xyz);
  gl_Position = projectionMatrix * view;
}
`;

const CROSS_FRAGMENT = /* glsl */ `
uniform float uStress;
${FILM_GRAIN}
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vCenter;
varying float vScale;
void main() {
  vec3 n = normalize(vNormalV);
  vec3 v = normalize(-vViewPos);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  // Where this is on the cross as you see it, in its reach.
  vec2 at = (vViewPos.xy - vCenter.xy) / (vScale * ${CROSS_REACH.toFixed(3)});
  // Matte, lit from above: what faces up is a pale lavender, what faces down a warm pink, so the
  // crease along each level arm reads as a shelf where the two meet.
  vec3 above = vec3(0.9, 0.88, 1.0);
  vec3 below = mix(vec3(1.0, 0.68, 0.94), vec3(1.0, 0.5, 0.72), uStress);
  vec3 c = mix(below, above, smoothstep(-0.4, 0.4, n.y));
  // How full on the light falls, from the upper left in front: dimmer where it falls aslant.
  float lit = max(dot(n, normalize(vec3(-0.35, 0.6, 0.72))), 0.0);
  c *= 0.55 + 0.5 * lit;
  // Where it falls full on, it glows: brighter than white, which the finish spreads into a soft
  // glow (see orbPost). Nothing here mirrors the room, so it's not shiny.
  c += vec3(1.0, 0.9, 1.0) * pow(lit, 4.0) * 0.6;
  // A little light pooled at its heart.
  c = mix(c, vec3(1.0, 0.97, 1.0), (1.0 - smoothstep(0.1, 0.6, length(at))) * smoothstep(0.55, 1.0, facing) * 0.3);
  // A faint pale edge, so its outline reads against the blue.
  c = mix(c, vec3(1.0, 0.9, 1.0), pow(1.0 - facing, 2.0) * 0.25);
  // Its own light: a little everywhere, so even its shaded side glows faintly.
  c += mix(vec3(0.95, 0.75, 1.0), vec3(1.0, 0.6, 0.8), uStress) * 0.16;
  c = filmGrain(c, ${GRAIN.toFixed(3)});
  gl_FragColor = vec4(c, 1.0);
}
`;

export function buildKittenOrb(uniforms: OrbUniforms) {
  const group = new THREE.Group();
  // Finished with its light bleeding softly, more where it's bright. The film grain is only on what's
  // inside the glass.
  const post = createBleedAndGrain({ soften: 1.0 });
  const inner = { ...uniforms, ...post.grain };
  // Fine enough for its rounded edges' outline.
  const gemGeometry = new THREE.IcosahedronGeometry(1, 96);
  // Premultiplied "over", for the glass.
  const over = {
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  } as const;
  // The glass is hollow, so it's drawn in three steps (see render):
  // 1. The hollow (layer 2, into `cavity`): its far side, seen from within, then the cross in it.
  const outside = { value: 1 };
  const hollow = { value: GEM_HOLLOW };
  const cavityBack = new THREE.ShaderMaterial({ vertexShader: GEM_VERTEX, fragmentShader: BACK_FRAGMENT, uniforms: { ...inner, uInset: hollow }, side: THREE.BackSide });
  const cavityBackMesh = new THREE.Mesh(gemGeometry, cavityBack);
  cavityBackMesh.renderOrder = 0;
  cavityBackMesh.layers.set(2);
  const crossShape = crossGeometry();
  const cross = new THREE.ShaderMaterial({ vertexShader: CROSS_VERTEX, fragmentShader: CROSS_FRAGMENT, uniforms: inner });
  const crossMesh = new THREE.Mesh(crossShape, cross);
  crossMesh.renderOrder = 1;
  crossMesh.layers.set(2);
  const cavity = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  // 2. What's seen through the outside (layer 1, into `inside`): the far wall from within, then the
  // hollow's near side, which shows the hollow through itself, bent.
  const viewport = new THREE.Vector2(1, 1);
  const back = new THREE.ShaderMaterial({ vertexShader: GEM_VERTEX, fragmentShader: BACK_FRAGMENT, uniforms: { ...inner, uInset: outside }, side: THREE.BackSide });
  const backMesh = new THREE.Mesh(gemGeometry, back);
  backMesh.renderOrder = 0;
  backMesh.layers.set(1);
  const cavityFront = new THREE.ShaderMaterial({
    vertexShader: GEM_VERTEX,
    fragmentShader: CAVITY_FRONT,
    uniforms: { ...uniforms, uInset: hollow, tCavity: { value: cavity.texture }, uViewport: { value: viewport } },
  });
  const cavityFrontMesh = new THREE.Mesh(gemGeometry, cavityFront);
  cavityFrontMesh.renderOrder = 1;
  cavityFrontMesh.layers.set(1);
  const inside = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  // 3. The outside's near faces (layer 0, to the screen), which show that through themselves, bent,
  // with their reflections over it.
  const front = new THREE.ShaderMaterial({
    vertexShader: GEM_VERTEX,
    fragmentShader: FRONT_FRAGMENT,
    uniforms: { ...uniforms, uInset: outside, tInside: { value: inside.texture }, uViewport: { value: viewport } },
    side: THREE.FrontSide,
    ...over,
  });
  const frontMesh = new THREE.Mesh(gemGeometry, front);
  frontMesh.renderOrder = 2;
  group.add(cavityBackMesh, crossMesh, backMesh, cavityFrontMesh, frontMesh);
  // About the other orbs' size.
  group.scale.setScalar(1.14);
  const clear = new THREE.Color();
  const render = (r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => {
    r.getDrawingBufferSize(viewport);
    for (const target of [cavity, inside]) if (target.width !== viewport.x || target.height !== viewport.y) target.setSize(viewport.x, viewport.y);
    const before = r.getRenderTarget();
    const layers = camera.layers.mask;
    r.getClearColor(clear);
    const clearAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    // New grain this frame, before the passes that show it.
    post.refreshGrain(r);
    // The hollow, then what's seen through the outside, each on its own (cleared as each is drawn).
    for (const [target, layer] of [[cavity, 2], [inside, 1]] as const) {
      r.setRenderTarget(target);
      camera.layers.set(layer);
      r.render(scene, camera);
    }
    camera.layers.mask = layers;
    r.setRenderTarget(before);
    r.setClearColor(clear, clearAlpha);
    // Then the near faces (and anything else in the scene), finished.
    post.render(r, scene, camera);
  };
  return {
    group,
    surface: CROSS_SURFACE,
    motes: MOTES,
    render,
    dispose: () => {
      cavity.dispose();
      inside.dispose();
      gemGeometry.dispose();
      crossShape.dispose();
      cavityBack.dispose();
      cavityFront.dispose();
      back.dispose();
      cross.dispose();
      front.dispose();
      post.dispose();
    },
  };
}
