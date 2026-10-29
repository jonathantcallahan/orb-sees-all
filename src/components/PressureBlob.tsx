import { useEffect, useRef } from "react";
import * as THREE from "three";
import { orbMood, type Pressure } from "../tasks";

// Ashima Arts 3D simplex noise (MIT), shared by both shaders.
const NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uStress;
varying vec3 vPos;
varying vec3 vViewPos;
varying float vDisp;
${NOISE}
void main() {
  // Calm: slow, irregular swells. Stressed: high-frequency ridged noise, i.e. spikes.
  float flow = uTime * mix(0.125, 0.9, uStress);
  // Three wave trains crossing the sphere in different directions and speeds.
  // Noise bends each one's phase and a slow noise field varies their height, so
  // the surface rolls like a choppy sea rather than wobbling uniformly.
  vec3 n = normal;
  float swell =
      0.5 * sin(dot(n, vec3(0.80, 0.30, 0.52)) * 5.0 + flow * 2.0 + 2.0 * snoise(n * 1.3 + flow * 0.5))
    + 0.3 * sin(dot(n, vec3(-0.40, 0.88, 0.25)) * 7.0 - flow * 1.6 + 2.0 * snoise(n * 1.7 - flow * 0.4))
    + 0.2 * sin(dot(n, vec3(0.20, -0.50, 0.84)) * 9.0 + flow * 2.6 + 2.0 * snoise(n * 2.3 + flow * 0.3));
  swell *= 0.55 + 0.45 * snoise(n * 0.9 + flow * 0.2);
  float ridge = 1.0 - abs(snoise(normal * mix(2.0, 4.5, uStress) + flow * 1.3));
  float spikes = pow(ridge, mix(2.0, 6.0, uStress));
  float disp = mix(0.13 * swell, 0.12 * swell + 0.55 * spikes, uStress);
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

  vec3 cool = mix(mix(vec3(0.16, 0.42, 0.95), vec3(0.50, 0.33, 0.95), swirl), vec3(0.08, 0.75, 0.70), smoothstep(0.55, 1.0, warp));
  vec3 warm = mix(mix(vec3(1.00, 0.42, 0.10), vec3(0.93, 0.13, 0.22), swirl), vec3(1.00, 0.78, 0.15), smoothstep(0.55, 1.0, warp));
  vec3 color = mix(cool, warm, smoothstep(0.0, 1.0, uStress));
  // Spike tips run hotter.
  color = mix(color, vec3(1.0, 0.92, 0.75), clamp(vDisp, 0.0, 0.6) * uStress * 0.6);

  // Lighting from screen-space derivatives, so spikes catch light along their edges.
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  vec3 light = normalize(vec3(0.4, 0.7, 0.6));
  float diffuse = 0.55 + 0.45 * max(dot(n, light), 0.0);
  float rim = pow(1.0 - max(dot(n, normalize(-vViewPos)), 0.0), 2.5);
  gl_FragColor = vec4(color * diffuse + rim * 0.35 * color + rim * 0.15, 1.0);
}
`;

/** Rotation speed in radians per second at stress 0 and 1. */
const SPIN = { calm: 0.1, stressed: 2.2 };

export function PressureBlob({ pressure }: { pressure: Pressure }) {
  const mount = useRef<HTMLDivElement>(null);
  const target = useRef(pressure.level);
  target.current = pressure.level;

  useEffect(() => {
    const el = mount.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    // Far enough back that fully spiked (radius ~1.7) still fits in frame.
    camera.position.z = 6.4;

    const uniforms = { uTime: { value: 0 }, uStress: { value: target.current } };
    const material = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms });
    const geometry = new THREE.IcosahedronGeometry(1, 64);
    const blob = new THREE.Mesh(geometry, material);
    scene.add(blob);

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
      const spin = (SPIN.calm + (SPIN.stressed - SPIN.calm) * stress * stress) * motion;
      blob.rotation.y += dt * spin;
      blob.rotation.x += dt * spin * 0.35;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  const mood = orbMood(pressure);
  const counts =
    pressure.projectsOnMe || pressure.criticalTasks
      ? `${pressure.projectsOnMe} project${pressure.projectsOnMe === 1 ? "" : "s"} waiting on you · ${pressure.criticalTasks} critical`
      : null;

  return (
    <div className={`pressure mood-${mood}`} title={counts ?? "Nothing waiting on you"}>
      <div ref={mount} className="pressure-blob" aria-hidden />
      <div className="muted small">Orb is {mood}</div>
      {counts && <div className="muted small">{counts}</div>}
    </div>
  );
}
