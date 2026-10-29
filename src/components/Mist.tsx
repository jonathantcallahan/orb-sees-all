import { useEffect, useRef, type CSSProperties } from "react";
import * as THREE from "three";

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uBg;
varying vec2 vUv;

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

void main() {
  // Keep the noise square regardless of the strip's aspect ratio.
  vec2 p = vUv * vec2(uResolution.x / uResolution.y, 1.0) * 2.2;
  float t = uTime * 0.22;
  // Domain warping: noise displaced by noise gives the slow swirl.
  vec2 q = vec2(fbm(p + vec2(t, -t * 0.5)), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 1.5), fbm(p + 3.0 * q + vec2(8.3, 2.8) - t * 1.2));
  float d = fbm(p + 2.5 * r);

  // Thick at the bottom, wispy and ragged where it fades out at the top.
  float depth = 1.0 - vUv.y;
  float edge = smoothstep(0.0, 0.75, depth + (d - 0.5) * 0.7);
  float alpha = pow(edge, 0.7) * (0.75 + 0.25 * d) * smoothstep(0.0, 0.3, depth + 0.1);
  alpha = clamp(alpha + smoothstep(0.45, 1.0, depth) * 0.5, 0.0, 0.98);

  // Shades of the page background, slightly cooler, so the mist reads as part of the page.
  vec3 deep = mix(uBg, vec3(0.03, 0.03, 0.06), 0.45);
  vec3 wisp = mix(uBg, vec3(0.20, 0.18, 0.28), 0.15);
  vec3 color = mix(deep, wisp, d * d + length(q) * 0.1);
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

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

/** A swirling band of mist, a deeper shade of the background, along the bottom of the window. Purely decorative; clicks pass through. */
export function Mist() {
  const mount = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mount.current!;
    const renderer = new THREE.WebGLRenderer({ alpha: true, premultipliedAlpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    el.appendChild(renderer.domElement);

    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uBg: { value: new THREE.Color() },
    };
    // Track the theme's background color, including light/dark switches.
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
      fragmentShader: FRAGMENT,
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
      uniforms.uTime.value += Math.min(clock.getDelta(), 0.1) * motion;
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
  }, []);

  return (
    <>
      <div className="mist-fade" aria-hidden>
        {BLUR_STEPS.map((px, i) => (
          <div key={px} className="mist-fade-layer" style={blurLayer(px, i)} />
        ))}
        <div className="mist-fade-darken" />
      </div>
      <div ref={mount} className="mist" aria-hidden />
    </>
  );
}
