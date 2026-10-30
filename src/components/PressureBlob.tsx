import { useEffect, useRef } from "react";
import * as THREE from "three";
import { orbMood, type Pressure } from "../tasks";
import { PressureBars } from "./PressureBars";
import { NOISE } from "./orbNoise";
import { NO_RIPPLE, RIPPLE, type OrbUniforms } from "./orbRipple";
import { TASK_DONE_EVENT } from "../orbEvents";
import { buildGlassOrb } from "./glassOrb";
import { buildLiquidOrb } from "./liquidOrb";


const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uStress;
varying vec3 vPos;
varying vec3 vViewPos;
varying float vDisp;
${NOISE}
${RIPPLE}
// One wave train: a sine along direction d, its phase bent by noise so crests wander, and its
// height scaled by a slow noise envelope (seeded) so it swells in some places and fades in others.
float wave(vec3 n, vec3 d, float freq, float phase, float seed) {
  float bend = 1.2 * snoise(n * (freq * 0.3) + vec3(seed) + phase * 0.3);
  // Squared envelope: long stretches where the wave nearly vanishes, with sharper tall peaks.
  float env = 0.5 + 0.5 * snoise(n * 0.8 + vec3(seed * 1.3) + phase * 0.08);
  float height = 0.08 + 0.92 * env * env * 1.6;
  return height * sin(dot(n, normalize(d)) * freq + phase + bend);
}
void main() {
  // Calm: slow, irregular swells. Stressed: high-frequency ridged noise, i.e. spikes.
  float flow = uTime * mix(0.125, 0.9, uStress);
  vec3 n = normal;
  // Nine wave trains of different sizes, directions and speeds, from a broad swell that lifts
  // whole regions to quick small ripples. Each has its own slowly drifting height envelope, so
  // waves rise tall in some places and all but vanish in others.
  float swell =
      0.34 * wave(n, vec3(0.30, 0.95, 0.10), 1.8, flow * 0.7, 9.4)
    + 0.30 * wave(n, vec3(0.80, 0.30, 0.52), 3.0, flow * 1.3, 0.0)
    + 0.24 * wave(n, vec3(-0.40, 0.88, 0.25), 4.2, -flow * 1.1, 1.7)
    + 0.20 * wave(n, vec3(0.65, -0.70, 0.30), 4.9, -flow * 0.9, 11.2)
    + 0.18 * wave(n, vec3(0.20, -0.50, 0.84), 5.5, flow * 1.7, 3.1)
    + 0.14 * wave(n, vec3(-0.90, 0.10, -0.42), 6.3, flow * 1.2, 13.5)
    + 0.13 * wave(n, vec3(-0.75, -0.35, 0.56), 7.0, -flow * 1.4, 4.6)
    + 0.09 * wave(n, vec3(0.55, 0.75, -0.37), 8.5, flow * 2.0, 6.2)
    + 0.06 * wave(n, vec3(-0.10, 0.25, -0.96), 10.5, -flow * 2.3, 7.9);
  // Spikes grow with the square of stress: faint until the orb is genuinely overloaded.
  float sharp = uStress * uStress;
  float ridge = 1.0 - abs(snoise(normal * mix(2.0, 4.5, sharp) + flow * 1.3));
  float spikes = pow(ridge, mix(2.0, 6.0, sharp));
  float disp = mix(0.1, 0.085, uStress) * swell + 0.55 * spikes * sharp + 0.14 * ripple(normal);
  vec3 pos = position + normal * disp;
  vPos = pos;
  vDisp = disp;
  vec4 view = modelViewMatrix * vec4(pos, 1.0);
  vViewPos = view.xyz;
  gl_Position = projectionMatrix * view;
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uStress;
varying vec3 vPos;
varying vec3 vViewPos;
varying float vDisp;
${NOISE}
void main() {
  // Two layers of noise, one warping the other, give the swirling bands.
  float t = uTime * mix(0.075, 0.6, uStress);
  float warp = snoise(vPos * 1.2 + vec3(t, -t, t * 0.5));
  float swirl = 0.5 + 0.5 * snoise(vPos * 2.0 + warp * 1.5 - t);

  // Calm: pale, icy tones (frost blue, glacier cyan, lavender) over a deeper periwinkle.
  vec3 cool = mix(mix(vec3(0.62, 0.80, 1.00), vec3(0.78, 0.72, 1.00), swirl), vec3(0.62, 0.96, 0.98), smoothstep(0.55, 1.0, warp));
  cool = mix(vec3(0.36, 0.46, 0.92), cool, smoothstep(-0.6, 0.4, warp));
  vec3 warm = mix(mix(vec3(1.00, 0.42, 0.10), vec3(0.93, 0.13, 0.22), swirl), vec3(1.00, 0.78, 0.15), smoothstep(0.55, 1.0, warp));
  vec3 color = mix(cool, warm, smoothstep(0.0, 1.0, uStress));
  // Spike tips run hotter.
  color = mix(color, vec3(1.0, 0.92, 0.75), clamp(vDisp, 0.0, 0.6) * uStress * 0.6);

  // Lighting from screen-space derivatives, so spikes catch light along their edges.
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  vec3 light = normalize(vec3(0.4, 0.7, 0.6));
  float diffuse = 0.55 + 0.45 * max(dot(n, light), 0.0);
  float rim = pow(1.0 - max(dot(n, normalize(-vViewPos)), 0.0), 2.5);
  vec3 lit = color * diffuse + rim * 0.35 * color + rim * 0.15;

  // When calm the orb turns ethereal: a soft blue-white halo, a faint thin-film
  // shimmer that shifts with the viewing angle, and a translucent core. All of
  // it fades out as stress rises.
  float calm = 1.0 - smoothstep(0.0, 0.5, uStress);
  vec3 shimmer = 0.5 + 0.5 * cos(6.2831 * (rim * 1.5 + swirl * 0.3 + vec3(0.55, 0.65, 0.8)));
  lit = mix(lit, mix(lit, shimmer, 0.18 * rim), calm);
  lit += calm * rim * vec3(0.55, 0.75, 1.0) * 0.55;
  float alpha = mix(1.0, 0.72 + 0.28 * rim, calm);
  // The canvas uses premultiplied alpha.
  gl_FragColor = vec4(lit * alpha, alpha);
}
`;

/** Rotation speed in radians per second at stress 0 and 1. */
const SPIN = { calm: 0.1, stressed: 2.2 };
/** How far the orb turns toward the cursor, in radians (about 35 degrees). */
const FACE_ANGLE = 0.6;

/** The orb looks a user can pick in Settings. */
export type OrbLook = "classic" | "glass" | "crystal" | "iridescent";

/** Builds the Classic orb: one shaded sphere that swells when calm and spikes under stress. */
function buildClassicOrb(uniforms: OrbUniforms) {
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    // The calm orb is partly see-through; the fragment shader outputs premultiplied color.
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const geometry = new THREE.IcosahedronGeometry(1, 64);
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

export function PressureBlob({ pressure, look = "classic" }: { pressure: Pressure; look?: OrbLook }) {
  const mount = useRef<HTMLDivElement>(null);
  const target = useRef(pressure.level);
  target.current = pressure.level;

  useEffect(() => {
    const el = mount.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Before drawing glass, three renders what's behind it into a buffer, which it clears to
    // half-transparent white when the canvas is transparent (renderTransmissionPass). Glass over
    // empty space then looks milky white instead of showing the page. Clear it to transparent.
    const setClearColor = renderer.setClearColor.bind(renderer);
    renderer.setClearColor = (color, alpha) =>
      alpha === 0.5 && new THREE.Color(color).getHex() === 0xffffff ? setClearColor(0x000000, 0) : setClearColor(color, alpha);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    // Far enough back that fully spiked (radius ~1.7) still fits in frame.
    camera.position.z = 6.4;

    const uniforms = {
      uTime: { value: 0 },
      uStress: { value: target.current },
      uRippleAge: { value: NO_RIPPLE },
      uRippleOrigin: { value: new THREE.Vector3(0, 0, 1) },
    };
    const orb =
      look === "glass"
        ? buildGlassOrb(uniforms, renderer)
        : look === "crystal"
          ? buildGlassOrb(uniforms, renderer, "clear")
          : look === "iridescent"
            ? buildLiquidOrb(uniforms)
            : buildClassicOrb(uniforms);
    if ("environment" in orb) scene.environment = orb.environment as THREE.Texture;
    const blob = orb.group;
    // The orb spins inside a group that turns it toward the cursor when the cursor comes near.
    const facing = new THREE.Group();
    facing.add(blob);
    scene.add(facing);
    const toward = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const size = Math.max(r.width, r.height) / 2;
      // -1 to 1 across the orb's box, from its center.
      const dx = (e.clientX - (r.left + r.width / 2)) / size;
      const dy = (e.clientY - (r.top + r.height / 2)) / size;
      // Full attention inside the box, fading out by twice its size.
      const near = Math.max(0, Math.min(1, 2 - Math.hypot(dx, dy)));
      toward.x = Math.max(-1, Math.min(1, dx)) * near;
      toward.y = Math.max(-1, Math.min(1, dy)) * near;
    };
    const onLeave = () => {
      toward.x = 0;
      toward.y = 0;
    };
    window.addEventListener("pointermove", onPointer);
    // A finished task sends ripples out from the point of the orb facing the viewer.
    const onTaskDone = () => {
      blob.updateWorldMatrix(true, false);
      const toViewer = new THREE.Vector3(0, 0, 1).applyQuaternion(blob.getWorldQuaternion(new THREE.Quaternion()).invert());
      uniforms.uRippleOrigin.value.copy(toViewer.normalize());
      uniforms.uRippleAge.value = 0;
    };
    window.addEventListener(TASK_DONE_EVENT, onTaskDone);
    document.addEventListener("pointerleave", onLeave);
    // The molten Glass orb turns more slowly, so its oozing reads as weight rather than spin.
    const spinScale = look === "classic" ? 1 : 0.6;

    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.2 : 1;
    const clock = new THREE.Clock();
    let frame = 0;
    const tick = () => {
      const dt = Math.min(clock.getDelta(), 0.1);
      // Ease toward the target so changes in pressure ramp instead of jumping.
      const stress = uniforms.uStress.value + (target.current - uniforms.uStress.value) * Math.min(dt * 1.2, 1);
      uniforms.uStress.value = stress;
      uniforms.uTime.value += dt * motion;
      if (uniforms.uRippleAge.value < NO_RIPPLE) uniforms.uRippleAge.value += dt;
      const spin = (SPIN.calm + (SPIN.stressed - SPIN.calm) * stress * stress) * motion * spinScale;
      blob.rotation.y += dt * spin;
      blob.rotation.x += dt * spin * 0.35;
      // Turn toward the cursor (up to about 35 degrees), easing so it follows rather than snaps.
      const ease = Math.min(dt * 4, 1);
      facing.rotation.y += (toward.x * FACE_ANGLE * motion - facing.rotation.y) * ease;
      facing.rotation.x += (toward.y * FACE_ANGLE * motion - facing.rotation.x) * ease;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener(TASK_DONE_EVENT, onTaskDone);
      document.removeEventListener("pointerleave", onLeave);
      observer.disconnect();
      orb.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [look]);

  const mood = orbMood(pressure);

  return (
    <div className={`pressure mood-${mood}`}>
      <div ref={mount} className="pressure-blob" aria-hidden />
      {/* Keyed by mood so each change fades in. */}
      <div key={mood} className="muted small orb-mood">
        Orb is {mood}
      </div>
      <PressureBars pressure={pressure} />
    </div>
  );
}

type Rgb = [number, number, number];
const lerp = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;

/** Three glow colors for a look at a stress level, each easing from its calm color to its stressed one. */
function glowColors(look: OrbLook, level: number): string[] {
  const t = Math.min(Math.max(level, 0), 1);
  const pairs: Record<OrbLook, [Rgb, Rgb][]> = {
    // Icy blue, lavender and cyan when calm; orange, red and amber under stress.
    classic: [
      [[120, 160, 255], [255, 120, 40]],
      [[180, 150, 255], [235, 40, 70]],
      [[120, 230, 240], [255, 190, 60]],
    ],
    // The Glass core's cool ramp: cyan and blue when calm, violet and magenta under stress.
    glass: [
      [[60, 200, 255], [150, 80, 230]],
      [[40, 90, 240], [220, 70, 180]],
      [[100, 160, 255], [120, 80, 225]],
    ],
    // The same core seen through clear glass, with a touch of the rainbow its edges throw.
    crystal: [
      [[70, 190, 255], [160, 80, 235]],
      [[60, 100, 240], [230, 70, 170]],
      [[120, 230, 200], [255, 170, 90]],
    ],
    // Soap-film pastels, warming toward pink and gold under stress.
    iridescent: [
      [[150, 230, 255], [255, 170, 220]],
      [[200, 180, 255], [255, 200, 150]],
      [[255, 190, 235], [255, 150, 200]],
    ],
  };
  return pairs[look].map(([calm, stressed]) => `rgb(${lerp(calm, stressed, t).join(" ")})`);
}

/**
 * Light the orb casts on the wall behind it: large, blurred, drifting patches of its colors, very
 * faint. Drawn behind the whole page, centered on the orb, so it can spread past its column.
 */
export function OrbGlow({ look, level }: { look: OrbLook; level: number }) {
  return (
    <div className="orb-glow" aria-hidden>
      {glowColors(look, level).map((color, i) => (
        <span key={i} className={`orb-glow-${i}`} style={{ backgroundColor: color }} />
      ))}
    </div>
  );
}
