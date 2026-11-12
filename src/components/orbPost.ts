/**
 * A look's own finish, after its lighting, as a rendered still often has: its light bleeding softly
 * into what's around it, more the brighter it is. The scene is drawn into a buffer first, then laid
 * onto the page with it. Also a soft film grain (FILM_GRAIN), which a look's own shaders put on what
 * it chooses, so it can keep it off clear reflections. Used by Kitten (see kittenOrb).
 *
 * The orb's canvas is see-through, so everything here stays premultiplied: the bleed adds light and
 * a little coverage, so it shows around the orb on a dark page and a light one.
 */
import * as THREE from "three";

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** One direction of a Gaussian blur, nine taps a texel `uDir` apart (color and coverage alike). */
const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  float w[5] = float[5](0.227, 0.1945, 0.1216, 0.054, 0.0162);
  vec4 c = texture2D(tSrc, vUv) * w[0];
  for (int i = 1; i < 5; i++) {
    c += texture2D(tSrc, vUv + uDir * float(i)) * w[i];
    c += texture2D(tSrc, vUv - uDir * float(i)) * w[i];
  }
  gl_FragColor = c;
}
`;

/** The scene with its light bled, onto the page. */
const COMPOSITE = /* glsl */ `
uniform sampler2D tBase;
uniform sampler2D tSoft;
uniform float uSoften;
varying vec2 vUv;
void main() {
  // Where it's bright around a point, the blurred scene's light spreads over it, so a lit edge
  // blurs out into what's around it while dark parts stay crisp.
  vec4 sharp = texture2D(tBase, vUv);
  vec4 soft = texture2D(tSoft, vUv);
  float light = max(soft.r, max(soft.g, soft.b));
  vec4 base = sharp + max(soft - sharp, 0.0) * uSoften * smoothstep(0.3, 0.9, light);
  float a = clamp(base.a, 0.0, 1.0);
  gl_FragColor = vec4(clamp(base.rgb, 0.0, a), a);
}
`;

/**
 * Film grain, for a look's own fragment shaders: `filmGrain(c, amount)` adds a soft grain to color
 * c, `amount` in color steps, a little stronger in middle tones than in black or white. It's sized
 * in points on the page (not device pixels), so it shows at 2x as at 1x, and new each frame (see
 * BleedAndGrain.refreshGrain). Needs the uniforms in BleedAndGrain.grain.
 */
export const FILM_GRAIN = /* glsl */ `
uniform vec2 uGrainSeed;
uniform float uGrainPixel;
float grainHash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
// Random values a little apart, eased between, so no grain is a hard single dot.
float grainNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(grainHash(i), grainHash(i + vec2(1.0, 0.0)), f.x), mix(grainHash(i + vec2(0.0, 1.0)), grainHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 filmGrain(vec3 c, float amount) {
  float lum = clamp(dot(c, vec3(0.3, 0.55, 0.15)), 0.0, 1.0);
  float n = grainNoise(gl_FragCoord.xy / (uGrainPixel * 1.4) + uGrainSeed) - 0.5;
  return c + n * amount * (0.45 + 0.55 * (1.0 - abs(lum * 2.0 - 1.0)));
}
`;

export interface BleedAndGrain {
  /** Draws `scene` to the screen with its light bled. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void;
  /** The uniforms FILM_GRAIN reads, for the materials that use it (see refreshGrain). */
  grain: { uGrainSeed: THREE.IUniform<THREE.Vector2>; uGrainPixel: THREE.IUniform<number> };
  /** New grain for this frame, sized for the renderer: call it before the first pass that shows grain. */
  refreshGrain(renderer: THREE.WebGLRenderer): void;
  dispose(): void;
}

/** `soften` is how far light bleeds into its surroundings, 0 to 1, at its brightest. */
export function createBleedAndGrain(opts: { soften: number }): BleedAndGrain {
  // The scene itself, multisampled so its edges stay smooth, and blurred at half size for its bleed.
  const base = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const params = { type: THREE.HalfFloatType, depthBuffer: false } as const;
  const half = [new THREE.WebGLRenderTarget(1, 1, params), new THREE.WebGLRenderTarget(1, 1, params)];
  const targets = [base, ...half];

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
    new THREE.ShaderMaterial({ vertexShader: QUAD_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  const blur = pass(BLUR, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
  const composite = pass(COMPOSITE, { tBase: { value: base.texture }, tSoft: { value: half[0].texture }, uSoften: { value: opts.soften } });
  const grain = { uGrainSeed: { value: new THREE.Vector2() }, uGrainPixel: { value: 1 } };
  const materials = [blur, composite];

  const draw = (r: THREE.WebGLRenderer, material: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) => {
    quad.material = material;
    r.setRenderTarget(to);
    r.render(quadScene, quadCamera);
  };

  const size = new THREE.Vector2();
  const clear = new THREE.Color();
  return {
    grain,
    refreshGrain(r) {
      grain.uGrainSeed.value.set(Math.random() * 1000, Math.random() * 1000);
      grain.uGrainPixel.value = r.getPixelRatio();
    },
    render(r, scene, camera) {
      r.getDrawingBufferSize(size);
      if (base.width !== size.x || base.height !== size.y) {
        base.setSize(size.x, size.y);
        for (const t of half) t.setSize(Math.max(1, size.x >> 1), Math.max(1, size.y >> 1));
      }
      const before = r.getRenderTarget();
      r.getClearColor(clear);
      const clearAlpha = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(base);
      r.render(scene, camera);
      // The scene blurred at half size, across then down, read back by the composite.
      blur.uniforms.tSrc.value = base.texture;
      blur.uniforms.uDir.value.set(1 / half[0].width, 0);
      draw(r, blur, half[1]);
      blur.uniforms.tSrc.value = half[1].texture;
      blur.uniforms.uDir.value.set(0, 1 / half[0].height);
      draw(r, blur, half[0]);
      draw(r, composite, before);
      r.setClearColor(clear, clearAlpha);
    },
    dispose() {
      targets.forEach((t) => t.dispose());
      materials.forEach((m) => m.dispose());
      quad.geometry.dispose();
    },
  };
}
