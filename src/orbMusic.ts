import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/**
 * The listening orb's side of the music: what Demian hears (src-tauri/src/listen), and how that
 * turns into the orb's motion.
 *
 * What's heard is all relative (0.5 means "as usual for this music"), so loud and quiet tracks move
 * the orb alike. MusicResponse turns it into motion with the rules that keep a visualizer alive
 * rather than twitchy: hits land fast and fade slowly, each part of the sound drives one thing,
 * hits are springs and bounces rather than flashes, a chorus fills the orb while a quiet verse thins
 * it, and silence eases into rest instead of stopping.
 */

export const BANDS = 8;

/** One frame of what's playing (every value 0..1; 0.5 is "as usual" for the relative ones). */
export interface Heard {
  level: number;
  bands: number[];
  bass: number;
  mid: number;
  high: number;
  /** The strongest hit since the last frame, 0 if none. */
  hit: number;
  hits: number;
  /** The strongest bass hit (a kick, a thump in the low end) since the last frame, 0 if none. */
  bassHit: number;
  bassHits: number;
  /** Where the sound's center of brightness sits, 100 Hz (0) to 8 kHz (1). */
  brightness: number;
  /** 0 for a pure tone, toward 1 for noise. */
  noisiness: number;
  /** The last ~18 seconds against the last few minutes: 0.5 as usual. */
  section: number;
  active: boolean;
}

/** How listening is going: off (not asked), listening, error (it keeps retrying) or unavailable (not on this system). */
export type ListeningState = { state: "off" | "listening" | "error" | "unavailable"; detail?: string };

type Message = ({ kind: "features" } & Heard) | { kind: "status"; state: ListeningState["state"]; detail?: string | null };

type Source = (onHeard: (heard: Heard) => void, onStatus: (status: ListeningState) => void) => () => void;

/** Demian's own ears: the Rust listener, over a channel. */
const tauriSource: Source = (onHeard, onStatus) => {
  let stopped = false;
  const start = () => {
    if (stopped) return;
    // A new channel each time: the listener closes its channel when it stops, so one reused after
    // leaving and coming back would deliver nothing.
    const channel = new Channel<Message>();
    channel.onmessage = (m) => {
      if (m.kind === "features") onHeard(m);
      else onStatus({ state: m.state, detail: m.detail ?? undefined });
    };
    invoke("start_listening", { onHeard: channel }).catch((e) => onStatus({ state: "error", detail: String(e) }));
  };
  const stop = () => invoke("stop_listening").catch(() => {});
  // Not while the window is hidden: nothing's watching.
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVisibility);
  if (!document.hidden) start();
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    stop();
  };
};

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let source: Source | null = inTauri ? tauriSource : null;

/** For trying the orb outside the app: something else to listen to (a simulation). */
export function setMusicSource(next: Source | null) {
  source = next;
}

const STATUS_EVENT = "orb:listening";
let status: ListeningState = { state: "off" };
const listeners = new Set<(heard: Heard) => void>();
let stopSource: (() => void) | null = null;

function setStatus(next: ListeningState) {
  status = next;
  window.dispatchEvent(new Event(STATUS_EVENT));
}

/** How listening is going now, for Settings. */
export function listeningStatus(): ListeningState {
  return status;
}

/** How listening is going, following changes. */
export function useListeningStatus(): ListeningState {
  const [now, setNow] = useState(status);
  useEffect(() => {
    const onChange = () => setNow(status);
    window.addEventListener(STATUS_EVENT, onChange);
    return () => window.removeEventListener(STATUS_EVENT, onChange);
  }, []);
  return now;
}

/** Hears what's playing while subscribed; the last one to leave stops the listening. */
export function listenToMusic(onHeard: (heard: Heard) => void): () => void {
  listeners.add(onHeard);
  if (!stopSource && source) {
    stopSource = source(
      (heard) => listeners.forEach((l) => l(heard)),
      (s) => setStatus(s),
    );
  }
  return () => {
    listeners.delete(onHeard);
    if (listeners.size === 0 && stopSource) {
      stopSource();
      stopSource = null;
      setStatus({ state: "off" });
    }
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Moves `current` toward `target`: quickly (time constant `attack` s) when rising, slowly (`release`) when falling. */
export function envelope(current: number, target: number, attack: number, release: number, dt: number): number {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));
}

/** How far a relative value stands above its usual: 0 at or below `from`, 1 at `from + span`. */
const above = (x: number, from: number, span: number) => clamp01((x - from) / span);

/** A hit, for the dots: it throws them off the inner orb, and they fall back and bounce. */
export interface Wave {
  age: number;
  strength: number;
}
/** How long a hit stays in play, in seconds: long enough for its hop and bounces to settle. */
export const WAVE_LIFE = 1.0;
const MAX_WAVES = 4;
/** Hits closer together than this make one throw, not a burst of them. */
const WAVE_GAP = 0.12;
/**
 * How hard a bass hit must land to move the orb: the dots' bounce, the inner orb's spring and its
 * glow's pulse. Lighter ones, and hits outside the bass (hi-hats, snares, vocals), leave them alone,
 * so it's the big thumps that show; the breath, swirl, twinkle and the dots' own bands still follow
 * everything.
 */
export const BIG_BASS_HIT = 0.35;

/**
 * The orb's response to the music, stepped once a frame. Every output is 0..1 (kick is a spring
 * that swings a little either side of 0).
 */
export class MusicResponse {
  /** How present the music is: eases in when it starts, and out over a few seconds into silence. */
  presence = 0;
  /** The bass: the inner orb's breath and the cloud's swell. */
  breath = 0;
  /** The mids: how fast and turbulently the dots flow. */
  swirl = 0;
  /** The highs: the outer dots' twinkle. */
  sparkle = 0;
  /** Each band, for the dots that listen to it (bass near the core, treble at the outside). */
  bands = new Array<number>(BANDS).fill(0);
  /** Loudness. */
  level = 0;
  /** How bright the sound is, slowly: the inner orb's colors follow it. */
  brightness = 0.5;
  /** How tonal (1) or noisy (0), slowly. */
  tone = 0.5;
  /** How intense this stretch of the music is: a chorus near 1.3, a quiet verse near 0.7. */
  gain = 1;
  /** The hits' spring: each hit pushes it out at once, and it springs back past rest and settles. */
  kick = 0;
  /** Each hit's moment: jumps up on the hit and fades within about a tenth of a second, so the beat lands on the beat. */
  hit = 0;
  private kickVelocity = 0;
  waves: Wave[] = [];
  /** A clock the dots flow by: it runs faster with the music, so the music sets the pace, not the position. */
  flow = 0;

  private latest: Heard | null = null;
  private sinceHeard = Infinity;
  private sinceWave = Infinity;

  hear(heard: Heard) {
    this.latest = heard;
    this.sinceHeard = 0;
    if ((heard.bassHits ?? 0) > 0 && heard.active && heard.bassHit >= BIG_BASS_HIT) {
      // The spring is pushed out at once (not given a shove that peaks later), scaled by how hard
      // it hit and how intense the section is.
      const strength = clamp01(0.4 + (heard.bassHit - BIG_BASS_HIT) * 0.9);
      this.kick = Math.min(this.kick + 0.5 * strength * this.gain, 1.2);
      this.hit = Math.max(this.hit, strength * Math.min(this.gain, 1.2));
      if (this.sinceWave >= WAVE_GAP) {
        this.waves.push({ age: 0, strength });
        if (this.waves.length > MAX_WAVES) this.waves.shift();
        this.sinceWave = 0;
      } else {
        const last = this.waves[this.waves.length - 1];
        if (last) last.strength = Math.max(last.strength, strength);
      }
    }
  }

  step(dt: number) {
    this.sinceHeard += dt;
    this.sinceWave += dt;
    // Nothing heard for a while (listening stopped, or no permission yet) counts as silence.
    const h = this.sinceHeard < 0.5 ? this.latest : null;
    const active = !!h?.active;

    this.presence = envelope(this.presence, active ? 1 : 0, 0.5, 2.5, dt);
    const p = this.presence;
    this.gain = envelope(this.gain, active ? 0.65 + 0.7 * (h?.section ?? 0.5) : 1, 2, 2, dt);
    const g = this.gain;

    this.breath = envelope(this.breath, h ? above(h.bass, 0.4, 0.42) * p * g : 0, 0.025, 0.24, dt);
    this.swirl = envelope(this.swirl, h ? above(h.mid, 0.32, 0.5) * p * g : 0, 0.35, 0.7, dt);
    this.sparkle = envelope(this.sparkle, h ? above(h.high, 0.38, 0.45) * p * g : 0, 0.03, 0.18, dt);
    for (let i = 0; i < BANDS; i++) this.bands[i] = envelope(this.bands[i], h ? above(h.bands[i] ?? 0, 0.38, 0.5) * p * g : 0, 0.03, 0.3, dt);
    this.level = envelope(this.level, h ? h.level * p : 0, 0.12, 0.4, dt);
    // Color moves slowly, over a phrase rather than a beat, and drifts back to the middle in silence.
    this.brightness = envelope(this.brightness, h && active ? h.brightness : 0.5, 1.6, 3, dt);
    this.tone = envelope(this.tone, h && active ? 1 - h.noisiness : 0.5, 1.6, 3, dt);

    // The kick: a stiff, slightly underdamped spring, back through rest in about a fifth of a second
    // with one small overshoot, so it's done before the next beat. In small substeps.
    for (let i = 0, n = Math.ceil(dt / 0.008); i < n; i++) {
      const s = dt / n;
      this.kickVelocity += (-160 * this.kick - 14 * this.kickVelocity) * s;
      this.kick += this.kickVelocity * s;
    }

    this.hit *= Math.exp(-dt / 0.11);
    for (const w of this.waves) w.age += dt;
    this.waves = this.waves.filter((w) => w.age < WAVE_LIFE);

    this.flow += dt * (0.25 + 0.9 * this.swirl + 0.35 * this.breath);
  }
}
