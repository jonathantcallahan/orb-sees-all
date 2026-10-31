/**
 * Ophelia: a porcelain orb. The same slow molten shape as the glass orbs (so stress, ripples,
 * ferrofluid spikes and the working motes all behave alike), made of glazed porcelain:
 *
 * - The body is a white, slightly warm, softly rough ceramic, and the glaze over it is a clearcoat:
 *   a thin, glossy layer with its own sharp reflections of a soft studio, as on real glazed china.
 * - Porcelain is a little translucent where it's thin. MeshPhysicalMaterial has no subsurface
 *   scattering, so two terms are added to its light, in the spirit of three.js's
 *   SubsurfaceScatteringShader: a soft glow where the surface turns away from you (the thin rim),
 *   and light that comes through from a lamp behind, bending around the shape. Both are warm white,
 *   blushing faintly toward rose as stress rises.
 */
import * as THREE from "three";
import { GLASS_SURFACE, SHELL_NORMAL, SHELL_SHAPE } from "./glassOrb";
import type { OrbUniforms } from "./orbEffects";

const TRANSLUCENCY = /* glsl */ `
#include <emissivemap_fragment>
{
  vec3 V = normalize(vViewPosition);
  vec3 N = normalize(normal);
  // Calm: a cool, milky white. Stressed: a faint rose blush, like porcelain held up to warm light.
  vec3 glowColor = mix(vec3(1.0, 0.97, 0.93), vec3(1.0, 0.82, 0.8), uStress * 0.7);
  // Thin at the rim, where the surface turns away: light seeps through.
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  // Light from a lamp behind and above, scattered through the body (distorted by the normal so it
  // wraps around the shape rather than showing as a disc).
  vec3 L = normalize(vec3(0.35, 0.55, -1.0));
  float through = pow(clamp(dot(V, -(L + N * 0.45)), 0.0, 1.0), 2.5);
  totalEmissiveRadiance += glowColor * (0.16 * rim + 0.26 * through);
}
`;

/**
 * Porcelain's studio: a mid-gray room, so the body shades gently from light to shadow instead of
 * washing out, with a few softbox strips the glaze mirrors as crisp highlights.
 */
function porcelainStudio(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.24, 0.24, 0.25);
  const box = (w: number, h: number, k: number, pos: [number, number, number]) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k * 1.02), side: THREE.DoubleSide }));
    mesh.position.set(...pos);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  };
  box(7, 4, 3.2, [-2, 5, 4]); // big key softbox, above and to the left
  box(1.2, 6, 3, [6, 0, 2]); // tall strip on the right
  box(5, 1, 1.4, [0, -5, 3]); // low fill bounce
  box(4, 3, 0.9, [0, 1, -6]); // behind, lifting the rim
  return scene;
}

export function buildPorcelainOrb(uniforms: OrbUniforms, renderer: THREE.WebGLRenderer) {
  const geometry = new THREE.IcosahedronGeometry(1, 128);
  const material = new THREE.MeshPhysicalMaterial({
    // The body: off-white, a touch warm, softly rough under the glaze.
    color: new THREE.Color(0.96, 0.95, 0.92),
    metalness: 0,
    roughness: 0.5,
    // The glaze: a glossy clear layer with crisp reflections of its own.
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    ior: 1.5,
    specularIntensity: 0.55,
    // A faint cool sheen at grazing angles, as glazed china shows.
    sheen: 0.35,
    sheenColor: new THREE.Color(0.86, 0.9, 1.0),
    sheenRoughness: 0.6,
    envMapIntensity: 0.85,
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
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${SHELL_SHAPE}`)
      .replace("#include <beginnormal_vertex>", SHELL_NORMAL)
      .replace("#include <begin_vertex>", "vec3 transformed = shellPos;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uStress;")
      .replace("#include <emissivemap_fragment>", TRANSLUCENCY);
  };
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = porcelainStudio();
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
    surface: GLASS_SURFACE,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      environment.dispose();
    },
  };
}
