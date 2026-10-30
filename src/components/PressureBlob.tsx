import { useEffect, useRef } from "react";
import * as THREE from "three";
import { orbMood, type Pressure } from "../tasks";
import { PressureBars } from "./PressureBars";
import { NO_RIPPLE } from "./orbEffects";
import { ORB_AGITATE_EVENT, TASK_DONE_EVENT } from "../orbEvents";
import { buildParticles } from "./orbParticles";
import { isDark, type Theme } from "../theme";
import { buildGlassOrb } from "./glassOrb";

/** Rotation speed in radians per second at stress 0 and 1. */
const SPIN = { calm: 0.1, stressed: 2.2 };
/** How far the orb turns toward the cursor, in radians (about 35 degrees). */
const FACE_ANGLE = 0.6;

/** The orb looks a user can pick in Settings: Demian (crystal) and Roth (glass). */
export type OrbLook = "crystal" | "glass";

/** Mote colors for each look while Orb works: bright on a dark page, deeper on a light one. */
/** How far above its surroundings a point must stand to count as a wave tip, per look (their waves differ in depth). */
const TIP: Record<OrbLook, [number, number]> = {
  glass: [0.006, 0.03],
  crystal: [0.006, 0.03],
};

const MOTE_COLORS: Record<OrbLook, { dark: [number, number, number]; light: [number, number, number] }> = {
  glass: { dark: [0.45, 0.85, 1.0], light: [0.15, 0.35, 0.85] },
  crystal: { dark: [0.78, 0.9, 1.0], light: [0.3, 0.4, 0.72] },
};

/**
 * The orb. `working` is true while Orb is busy (a refresh, a task session): it then gives off motes
 * from the tips of its waves.
 */
export function PressureBlob({ pressure, look = "crystal", working = false }: { pressure: Pressure; look?: OrbLook; working?: boolean }) {
  const mount = useRef<HTMLDivElement>(null);
  const target = useRef(pressure.level);
  target.current = pressure.level;
  const workingRef = useRef(working);
  workingRef.current = working;

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
      uSpike: { value: 0 },
      uSpikeDir: { value: new THREE.Vector3(0, 0, 1) },
      uClock: { value: 0 },
      uWorking: { value: 0 },
    };
    const orb = look === "glass" ? buildGlassOrb(uniforms, renderer) : buildGlassOrb(uniforms, renderer, "clear");
    if ("environment" in orb) scene.environment = orb.environment as THREE.Texture;
    const blob = orb.group;
    // Motes off the wave tips while Orb works; they ride along as the orb turns.
    const moteColor = new THREE.Color();
    const particles = buildParticles(orb.surface, uniforms, moteColor, renderer.getPixelRatio(), TIP[look]);
    blob.add(particles.points);
    const paintMotes = () => moteColor.setRGB(...MOTE_COLORS[look][isDark((document.documentElement.dataset.theme as Theme) ?? "system") ? "dark" : "light"]);
    paintMotes();
    // The orb spins inside a group that turns it toward the cursor when the cursor comes near.
    const facing = new THREE.Group();
    facing.add(blob);
    scene.add(facing);
    const toward = { x: 0, y: 0 };
    // Where the cursor is relative to the orb's center, in orb-box units, wherever it is: the spikes aim at it.
    const cursor = { x: 0, y: 1 };
    const onPointer = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const size = Math.max(r.width, r.height) / 2;
      // -1 to 1 across the orb's box, from its center.
      const dx = (e.clientX - (r.left + r.width / 2)) / size;
      const dy = (e.clientY - (r.top + r.height / 2)) / size;
      cursor.x = dx;
      cursor.y = dy;
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
    // Hovering an overdue task: ferrofluid spikes grow toward the cursor and the orb chitters.
    let agitated = false;
    const onAgitate = (e: Event) => {
      agitated = (e as CustomEvent<boolean>).detail;
    };
    window.addEventListener(ORB_AGITATE_EVENT, onAgitate);
    const aim = new THREE.Vector3();
    const toOrb = new THREE.Quaternion();
    document.addEventListener("pointerleave", onLeave);
    // The molten orbs turn slowly, so their oozing reads as weight rather than spin.
    const spinScale = 0.6;

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
      uniforms.uClock.value += dt;
      // Motes fade in over about half a second when work starts, and out a little slower.
      const work = workingRef.current && motion === 1 ? 1 : 0;
      uniforms.uWorking.value += (work - uniforms.uWorking.value) * Math.min(dt * (work ? 2.5 : 1.5), 1);
      if (frame % 30 === 0) paintMotes();
      // Spikes surge in quickly and sink back a little slower.
      const spike = uniforms.uSpike.value;
      uniforms.uSpike.value = spike + ((agitated ? 1 : 0) - spike) * Math.min(dt * (agitated ? 5 : 2.5), 1);
      if (uniforms.uSpike.value > 0.001) {
        // Aim at the cursor: its direction from the orb's center in view space, then into the orb's own space.
        aim.set(cursor.x, -cursor.y, 0.6).normalize();
        blob.getWorldQuaternion(toOrb).invert();
        uniforms.uSpikeDir.value.copy(aim.applyQuaternion(toOrb));
      }
      // A faint tremor while agitated.
      const shake = 0.012 * uniforms.uSpike.value * motion;
      facing.position.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0);
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
      window.removeEventListener(ORB_AGITATE_EVENT, onAgitate);
      document.removeEventListener("pointerleave", onLeave);
      observer.disconnect();
      orb.dispose();
      particles.dispose();
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
