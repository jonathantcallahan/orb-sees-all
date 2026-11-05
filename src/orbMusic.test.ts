import { describe, expect, it } from "vitest";
import { envelope, MusicResponse, WAVE_LIFE, type Heard } from "./orbMusic";

const quiet: Heard = { level: 0, bands: new Array(8).fill(0), bass: 0, mid: 0, high: 0, hit: 0, hits: 0, brightness: 0.5, noisiness: 0.3, section: 0.5, active: false };
const playing = (over: Partial<Heard> = {}): Heard => ({ ...quiet, level: 0.6, bands: new Array(8).fill(0.5), bass: 0.5, mid: 0.5, high: 0.5, active: true, ...over });

/** Runs the response for `secs` at 60 frames a second, hearing `heard` each frame (or nothing). */
function run(m: MusicResponse, secs: number, heard?: (t: number) => Heard | null) {
  const dt = 1 / 60;
  for (let t = 0; t < secs; t += dt) {
    const h = heard?.(t);
    if (h) m.hear(h);
    m.step(dt);
  }
}

describe("envelope", () => {
  it("rises with the attack and falls with the release", () => {
    expect(envelope(0, 1, 0.025, 0.25, 0.05)).toBeGreaterThan(0.8);
    expect(envelope(1, 0, 0.025, 0.25, 0.05)).toBeGreaterThan(0.8);
  });
});

describe("MusicResponse", () => {
  it("eases in when music starts and rests a few seconds after it stops", () => {
    const m = new MusicResponse();
    run(m, 0.2, () => playing());
    expect(m.presence).toBeGreaterThan(0.2);
    expect(m.presence).toBeLessThan(0.6);
    run(m, 3, () => playing());
    expect(m.presence).toBeGreaterThan(0.95);
    run(m, 1, () => quiet);
    expect(m.presence).toBeGreaterThan(0.5);
    run(m, 8, () => quiet);
    expect(m.presence).toBeLessThan(0.1);
  });

  it("counts nothing heard (listening stopped) as silence", () => {
    const m = new MusicResponse();
    run(m, 3, () => playing());
    run(m, 10);
    expect(m.presence).toBeLessThan(0.1);
  });

  it("breathes with the bass: quick to swell, slow to settle", () => {
    const m = new MusicResponse();
    run(m, 3, () => playing({ bass: 0.4 }));
    const rest = m.breath;
    run(m, 0.06, () => playing({ bass: 0.85 }));
    const swelled = m.breath;
    expect(swelled - rest).toBeGreaterThan(0.5);
    run(m, 0.1, () => playing({ bass: 0.4 }));
    expect(m.breath).toBeGreaterThan(rest + (swelled - rest) * 0.5);
  });

  it("lands each hit at once: a spring pushed out, a moment that fades fast, and a wave", () => {
    const m = new MusicResponse();
    run(m, 3, () => playing());
    m.hear(playing({ hit: 0.8, hits: 1 }));
    expect(m.waves).toHaveLength(1);
    // On the hit itself, not a few frames later.
    expect(m.kick).toBeGreaterThan(0.3);
    expect(m.hit).toBeGreaterThan(0.8);
    let dip = 0;
    run(m, 0.35, () => {
      dip = Math.min(dip, m.kick);
      return playing();
    });
    expect(m.hit).toBeLessThan(0.1);
    // It springs back past rest before settling.
    expect(dip).toBeLessThan(0);
    run(m, WAVE_LIFE + 0.2, (t) => (t < 1 ? playing() : null));
    expect(Math.abs(m.kick)).toBeLessThan(0.01);
    expect(m.waves).toHaveLength(0);
  });

  it("folds hits close together into one wave", () => {
    const m = new MusicResponse();
    run(m, 1, () => playing());
    m.hear(playing({ hit: 0.3, hits: 1 }));
    m.step(1 / 60);
    m.hear(playing({ hit: 0.9, hits: 1 }));
    expect(m.waves).toHaveLength(1);
    expect(m.waves[0].strength).toBeGreaterThan(0.9);
    run(m, 0.2, () => playing());
    m.hear(playing({ hit: 0.5, hits: 1 }));
    expect(m.waves).toHaveLength(2);
    expect(WAVE_LIFE).toBeGreaterThan(0.5);
  });

  it("swells in a loud section and thins in a quiet one", () => {
    const loud = new MusicResponse();
    run(loud, 8, () => playing({ section: 0.8, mid: 0.8 }));
    const soft = new MusicResponse();
    run(soft, 8, () => playing({ section: 0.25, mid: 0.8 }));
    expect(loud.gain).toBeGreaterThan(1.15);
    expect(soft.gain).toBeLessThan(0.9);
    expect(loud.swirl).toBeGreaterThan(soft.swirl);
  });

  it("drifts its colors slowly with how bright the music sounds", () => {
    const m = new MusicResponse();
    run(m, 0.5, () => playing({ brightness: 0.95 }));
    expect(m.brightness).toBeLessThan(0.7);
    run(m, 8, () => playing({ brightness: 0.95 }));
    expect(m.brightness).toBeGreaterThan(0.9);
  });
});
