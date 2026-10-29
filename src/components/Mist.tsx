import { useEffect, useRef, type CSSProperties } from "react";
import * as THREE from "three";

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.0 + 3.1;
    a *= 0.5;
  }
  return v;
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uStress;
uniform vec2 uResolution;
uniform vec3 uBg;
varying vec2 vUv;

${NOISE}
void main() {
  // Keep the noise square regardless of the strip's aspect ratio.
  vec2 p = vUv * vec2(uResolution.x / uResolution.y, 1.0) * 2.2;
  float t = uTime * 0.15;
  // Domain warping: noise displaced by noise gives the slow swirl.
  vec2 q = vec2(fbm(p + vec2(t, -t * 0.5)), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 1.5), fbm(p + 3.0 * q + vec2(8.3, 2.8) - t * 1.2));
  float d = fbm(p + 2.5 * r);

  // Thick at the bottom, wispy and ragged where it fades out at the top. Opacity
  // follows the swirl density, so thin areas are see-through and wisps stand out.
  float depth = 1.0 - vUv.y;
  float density = smoothstep(0.2, 0.9, d);
  float edge = smoothstep(0.0, 0.75, depth + (d - 0.5) * 0.7);
  float alpha = pow(edge, 0.7) * (0.3 + 0.7 * density) * smoothstep(0.0, 0.3, depth + 0.1);
  alpha = clamp(alpha + smoothstep(0.6, 1.0, depth) * 0.2, 0.0, 0.9) * 0.7;

  // The orb's mood, blended into the page background: icy blue when calm,
  // violet when restless, ember when stressed.
  vec3 moodDeep = mix(vec3(0.36, 0.46, 0.92), vec3(0.50, 0.30, 0.80), smoothstep(0.0, 0.5, uStress));
  moodDeep = mix(moodDeep, vec3(0.80, 0.22, 0.12), smoothstep(0.5, 1.0, uStress));
  vec3 moodWisp = mix(vec3(0.70, 0.80, 1.00), vec3(0.80, 0.70, 1.00), smoothstep(0.0, 0.5, uStress));
  moodWisp = mix(moodWisp, vec3(1.00, 0.62, 0.30), smoothstep(0.5, 1.0, uStress));
  // Dense swirls take some of the mood color; thin areas glow faintly with a pale tint.
  vec3 glow = mix(uBg, mix(moodWisp, vec3(1.0), 0.35), 0.2);
  vec3 color = mix(glow, mix(uBg, moodDeep, 0.3), density);
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

/** The deep mist color for a stress level, matching the shader's moodDeep, for the CSS fade. */
function moodTint(level: number): string {
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  };
  let c = mix([0.36, 0.46, 0.92], [0.5, 0.3, 0.8], smooth(0, 0.5, level));
  c = mix(c, [0.8, 0.22, 0.12], smooth(0.5, 1, level));
  return `rgb(${c.map((v) => Math.round(v * 255)).join(" ")})`;
}

/** Blur radii (px) of the stacked layers, lightest at the top of the fade zone. */
const BLUR_STEPS = [0.25, 0.5, 1, 2, 4, 8];

/**
 * One layer of a progressive blur: each layer blurs what's behind it by a fixed
 * radius and is masked to its own band, so the blur deepens toward the bottom.
 */
function blurLayer(px: number, i: number): CSSProperties {
  const band = 100 / (BLUR_STEPS.length + 1);
  const mask = `linear-gradient(to bottom, transparent ${i * band}%, black ${(i + 1) * band}%, black ${(i + 2) * band}%, transparent ${Math.min((i + 3) * band, 100)}%)`;
  const last = i === BLUR_STEPS.length - 1;
  return {
    backdropFilter: `blur(${px}px)`,
    WebkitBackdropFilter: `blur(${px}px)`,
    // The deepest layer stays on to the bottom edge.
    maskImage: last ? `linear-gradient(to bottom, transparent ${i * band}%, black ${(i + 1) * band}%)` : mask,
    WebkitMaskImage: last ? `linear-gradient(to bottom, transparent ${i * band}%, black ${(i + 1) * band}%)` : mask,
  };
}

/**
 * Renders a full-surface fragment shader into the element behind `mount`,
 * with uTime, uResolution and uBg (the theme background, tracking light/dark
 * switches) as uniforms. Pauses with the page, like any requestAnimationFrame loop.
 */
function useShaderLayer(
  mount: React.RefObject<HTMLDivElement | null>,
  fragmentShader: string,
  maxPixelRatio: number,
  /** Target stress (0-1); uStress eases toward it like the orb does. */
  stress: React.RefObject<number>,
) {
  useEffect(() => {
    const el = mount.current!;
    const renderer = new THREE.WebGLRenderer({ alpha: true, premultipliedAlpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    el.appendChild(renderer.domElement);

    const uniforms = {
      uTime: { value: 0 },
      uStress: { value: stress.current },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uBg: { value: new THREE.Color() },
    };
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const readBg = () => {
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
      uniforms.uBg.value.set(bg || "#f5f5f4").convertLinearToSRGB();
    };
    readBg();
    scheme.addEventListener("change", readBg);
    const themeObserver = new MutationObserver(readBg);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader,
      uniforms,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));
    const camera = new THREE.Camera();

    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      renderer.setSize(width, height, false);
      uniforms.uResolution.value.set(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.2 : 1;
    const clock = new THREE.Clock();
    let frame = 0;
    const tick = () => {
      const dt = Math.min(clock.getDelta(), 0.1);
      uniforms.uTime.value += dt * motion;
      uniforms.uStress.value += (stress.current - uniforms.uStress.value) * Math.min(dt * 1.2, 1);
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      scheme.removeEventListener("change", readBg);
      themeObserver.disconnect();
      observer.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [mount, fragmentShader, maxPixelRatio, stress]);
}

/** A swirling band of mist tinted by the orb's mood, along the bottom of the window. Purely decorative; clicks pass through. */
export function Mist({ level }: { level: number }) {
  const mount = useRef<HTMLDivElement>(null);
  const stress = useRef(level);
  stress.current = level;
  useShaderLayer(mount, FRAGMENT, 1.5, stress);

  return (
    <>
      <div className="mist-fade" aria-hidden style={{ "--mist-mood": moodTint(level) } as CSSProperties}>
        {BLUR_STEPS.map((px, i) => (
          <div key={px} className="mist-fade-layer" style={blurLayer(px, i)} />
        ))}
        <div className="mist-fade-darken" />
      </div>
      <div ref={mount} className="mist" aria-hidden />
    </>
  );
}
