//! What the listening orb hears, reduced to a few numbers per frame: how loud it is, how each part
//! of the spectrum stands against its own recent level, the hits (onsets), how bright the sound is,
//! how tonal, and how intense this stretch of the music is against the rest.
//!
//! Everything is relative. Each band is judged against its own running level, so a quiet acoustic
//! track and a loud one move the orb as much, and nothing hangs on a fixed threshold. Values are
//! squashed into 0..1 with 0.5 meaning "as usual", so the orb can treat any music the same way.
//!
//! The analysis runs on short frames (a 1024-sample window every 256 samples, about 5 ms at 48 kHz)
//! so hits land within a few milliseconds of the sound. Smoothing for the eye is the orb's job.

use realfft::num_complex::Complex32;
use realfft::{RealFftPlanner, RealToComplex};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;

pub const WINDOW: usize = 1024;
pub const HOP: usize = 256;
/// Bands the orb's dots listen to, spaced evenly in log frequency from 30 Hz to 16 kHz.
pub const BANDS: usize = 8;
const LOW_HZ: f32 = 30.0;
const HIGH_HZ: f32 = 16_000.0;
/// Below this loudness (dBFS) the frame counts as silence: nothing adapts, and the orb rests.
const SILENCE_DB: f32 = -62.0;
/// How long sound must be gone before the orb counts it as silence, in seconds.
const SILENCE_HOLD: f32 = 1.5;
/// How quickly each band's sense of "usual" follows the music, in seconds.
const USUAL_SECS: f32 = 5.0;
/// The stretch of music the section intensity looks at, and the longer stretch it's judged against.
const SECTION_SECS: f32 = 18.0;
const SESSION_SECS: f32 = 120.0;
/// A hit needs this long since the last one, in seconds, so one drum isn't counted twice.
const HIT_COOLDOWN: f32 = 0.09;
/// The adaptive threshold for hits looks back this far, in seconds.
const FLUX_MEMORY: f32 = 0.45;
/// Bass hits (a kick drum, a bass drop): the rise of the lowest two bands alone, about 30 to 145 Hz,
/// against a longer look back and a higher bar than hits anywhere, so hi-hats, snares, vocals and a
/// bass line moving between notes don't count; only a real thump does.
const BASS_HIT_COOLDOWN: f32 = 0.15;
const BASS_FLUX_MEMORY: f32 = 1.0;
const BASS_HIT_BAR: f32 = 2.0;
const BASS_HIT_FLOOR: f32 = 0.6;

/// One frame of what's playing, ready for the orb. Every value is 0..1 unless noted.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    /// Loudness: 0 at -60 dBFS or below, 1 at full scale.
    pub level: f32,
    /// Each band against its own usual level: 0.5 as usual, higher when it swells, lower when it thins.
    pub bands: [f32; BANDS],
    /// The low, middle and high thirds of the bands, the same way.
    pub bass: f32,
    pub mid: f32,
    pub high: f32,
    /// The strongest hit since the last frame sent (0 when there was none).
    pub hit: f32,
    /// How many hits since the last frame sent.
    pub hits: u32,
    /// The strongest bass hit since the last frame sent (0 when there was none): see BASS_HIT_BAR.
    pub bass_hit: f32,
    /// How many bass hits since the last frame sent.
    pub bass_hits: u32,
    /// How bright the sound is: where its spectral centroid sits between 100 Hz (0) and 8 kHz (1).
    pub brightness: f32,
    /// How noisy rather than tonal: 0 for a pure tone, toward 1 for noise.
    pub noisiness: f32,
    /// How intense the last ~18 seconds are against the last couple of minutes: 0.5 as usual.
    pub section: f32,
    /// Whether anything is playing.
    pub active: bool,
}

/// Turns a stream of mono samples into Features, one per hop.
pub struct Analyzer {
    rate: f32,
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    spectrum: Vec<Complex32>,
    scratch: Vec<Complex32>,
    /// Samples not yet analyzed; always fewer than WINDOW + HOP.
    pending: VecDeque<f32>,
    /// Which FFT bins fall in each band.
    band_bins: [(usize, usize); BANDS],
    /// Each band's usual level, in dB.
    usual: [f32; BANDS],
    primed: bool,
    previous: Vec<f32>,
    flux_history: VecDeque<f32>,
    since_hit: f32,
    /// The FFT bins bass hits listen to: the lowest two bands.
    bass_bins: (usize, usize),
    bass_flux_history: VecDeque<f32>,
    since_bass_hit: f32,
    /// The bass's total level last hop (log-compressed), for its jump.
    bass_level: f32,
    brightness: f32,
    section_db: f32,
    session_db: f32,
    quiet_for: f32,
}

/// 0..1 with 0.5 at zero: how far `db` stands above (or below) its usual, in steps of `scale` dB.
fn squash(db: f32, scale: f32) -> f32 {
    1.0 / (1.0 + (-db / scale).exp())
}

/// Exponential smoothing step toward `target` with time constant `tau` seconds, over `dt` seconds.
fn follow(current: f32, target: f32, tau: f32, dt: f32) -> f32 {
    current + (target - current) * (1.0 - (-dt / tau).exp())
}

impl Analyzer {
    pub fn new(sample_rate: f32) -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(WINDOW);
        let window = (0..WINDOW).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / WINDOW as f32).cos()).collect();
        let bin_hz = sample_rate / WINDOW as f32;
        let nyquist_bin = WINDOW / 2;
        let mut band_bins = [(0, 0); BANDS];
        for (b, range) in band_bins.iter_mut().enumerate() {
            let edge = |k: usize| LOW_HZ * (HIGH_HZ / LOW_HZ).powf(k as f32 / BANDS as f32);
            let lo = ((edge(b) / bin_hz).floor() as usize).clamp(1, nyquist_bin);
            let hi = ((edge(b + 1) / bin_hz).ceil() as usize).clamp(lo + 1, nyquist_bin + 1);
            *range = (lo, hi);
        }
        Analyzer {
            rate: sample_rate,
            input: fft.make_input_vec(),
            spectrum: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
            window,
            pending: VecDeque::with_capacity(WINDOW * 4),
            band_bins,
            usual: [SILENCE_DB; BANDS],
            primed: false,
            previous: vec![0.0; nyquist_bin + 1],
            flux_history: VecDeque::new(),
            since_hit: 1.0,
            bass_bins: (band_bins[0].0, band_bins[1].1),
            bass_flux_history: VecDeque::new(),
            since_bass_hit: 1.0,
            bass_level: 0.0,
            brightness: 0.5,
            section_db: SILENCE_DB,
            session_db: SILENCE_DB,
            quiet_for: SILENCE_HOLD,
        }
    }

    /// Adds samples and returns a Features for each hop they complete.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Features> {
        let mut out = Vec::new();
        for &s in samples {
            self.pending.push_back(if s.is_finite() { s } else { 0.0 });
            if self.pending.len() >= WINDOW {
                out.push(self.frame());
                self.pending.drain(..HOP);
            }
        }
        out
    }

    fn frame(&mut self) -> Features {
        let dt = HOP as f32 / self.rate;
        let mut sum_sq = 0.0;
        for (i, (slot, &s)) in self.input.iter_mut().zip(self.pending.iter()).enumerate() {
            *slot = s * self.window[i];
            sum_sq += s * s;
        }
        let rms = (sum_sq / WINDOW as f32).sqrt();
        let db = 20.0 * rms.max(1e-9).log10();
        let _ = self.fft.process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch);

        // Power per bin, scaled so a full-scale sine reads about 0 dB.
        let norm = 4.0 / (WINDOW as f32 * WINDOW as f32);
        let power: Vec<f32> = self.spectrum.iter().map(|c| c.norm_sqr() * norm).collect();

        let sounding = db > SILENCE_DB;
        self.quiet_for = if sounding { 0.0 } else { self.quiet_for + dt };
        let active = self.quiet_for < SILENCE_HOLD;

        // Each band in dB, against its usual. While it's silent, nothing adapts: the usual stays
        // where the music left it, so the next song starts from a sensible place.
        let mut bands = [0.0; BANDS];
        for (b, &(lo, hi)) in self.band_bins.iter().enumerate() {
            let energy: f32 = power[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
            let band_db = 10.0 * energy.max(1e-12).log10();
            if sounding {
                if !self.primed {
                    self.usual[b] = band_db;
                }
                // The usual falls back faster than it rises, so a quiet passage after a loud one
                // still reads as quiet, but not for long.
                let tau = if band_db > self.usual[b] { USUAL_SECS } else { USUAL_SECS * 0.6 };
                self.usual[b] = follow(self.usual[b], band_db, tau, dt);
                bands[b] = squash(band_db - self.usual[b], 5.0);
            }
        }
        if sounding {
            self.primed = true;
        }
        let third = |range: std::ops::Range<usize>| -> f32 {
            let n = range.len() as f32;
            bands[range].iter().sum::<f32>() / n
        };
        let (bass, mid, high) = if sounding { (third(0..3), third(3..5), third(5..BANDS)) } else { (0.0, 0.0, 0.0) };

        // Hits: spectral flux on log-compressed magnitudes (only rises count), against the median
        // of the recent flux, so a dense mix needs a bigger jump than a sparse one.
        let mut flux = 0.0;
        for (k, &p) in power.iter().enumerate().skip(1) {
            let m = (1.0 + 1000.0 * p.sqrt()).ln();
            let rise = m - self.previous[k];
            if rise > 0.0 {
                flux += rise;
            }
            self.previous[k] = m;
        }
        flux /= power.len() as f32;
        // For bass hits, the jump in the bass's total energy rather than bin by bin: a kick's pitch
        // drops as it sounds, and a bass line moves between notes, sliding energy from one bin to the
        // next without any more of it; only a thump makes the whole low end jump.
        let (bass_lo, bass_hi) = self.bass_bins;
        let bass_energy = power[bass_lo..bass_hi].iter().sum::<f32>() / (bass_hi - bass_lo).max(1) as f32;
        let bass_level = (1.0 + 1000.0 * bass_energy.sqrt()).ln();
        let bass_flux = (bass_level - self.bass_level).max(0.0);
        self.bass_level = bass_level;
        let memory = (FLUX_MEMORY / dt).round() as usize;
        let mut sorted: Vec<f32> = self.flux_history.iter().copied().collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
        self.flux_history.push_back(flux);
        if self.flux_history.len() > memory {
            self.flux_history.pop_front();
        }
        let threshold = median * 1.6 + 0.004;
        self.since_hit += dt;
        let hit = if sounding && self.since_hit >= HIT_COOLDOWN && flux > threshold && self.flux_history.len() > 4 {
            self.since_hit = 0.0;
            ((flux - threshold) / threshold.max(1e-6)).clamp(0.05, 1.0)
        } else {
            0.0
        };

        // Bass hits, the same way over the lowest bands only, with a higher bar.
        let bass_memory = (BASS_FLUX_MEMORY / dt).round() as usize;
        let mut bass_sorted: Vec<f32> = self.bass_flux_history.iter().copied().collect();
        bass_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let bass_median = bass_sorted.get(bass_sorted.len() / 2).copied().unwrap_or(0.0);
        self.bass_flux_history.push_back(bass_flux);
        if self.bass_flux_history.len() > bass_memory {
            self.bass_flux_history.pop_front();
        }
        let bass_threshold = bass_median * BASS_HIT_BAR + BASS_HIT_FLOOR;
        self.since_bass_hit += dt;
        let bass_hit = if sounding && self.since_bass_hit >= BASS_HIT_COOLDOWN && bass_flux > bass_threshold && self.bass_flux_history.len() > 4 {
            self.since_bass_hit = 0.0;
            ((bass_flux - bass_threshold) / bass_threshold).clamp(0.05, 1.0)
        } else {
            0.0
        };

        // Brightness (spectral centroid) and noisiness (spectral flatness), over 30 Hz to 16 kHz.
        let bin_hz = self.rate / WINDOW as f32;
        let (lo, hi) = (self.band_bins[0].0, self.band_bins[BANDS - 1].1);
        let total: f32 = power[lo..hi].iter().sum();
        let (mut brightness, mut noisiness) = (self.brightness, 0.0);
        if sounding && total > 0.0 {
            let centroid = power[lo..hi].iter().enumerate().map(|(i, p)| (lo + i) as f32 * bin_hz * p).sum::<f32>() / total;
            let target = ((centroid.max(100.0) / 100.0).log2() / 80f32.log2()).clamp(0.0, 1.0);
            self.brightness = follow(self.brightness, target, 0.12, dt);
            brightness = self.brightness;
            let n = (hi - lo) as f32;
            let log_mean = power[lo..hi].iter().map(|p| p.max(1e-12).ln()).sum::<f32>() / n;
            noisiness = (log_mean.exp() / (total / n)).clamp(0.0, 1.0).sqrt();
        }

        // Section: the last stretch's loudness against the session's, while there's music.
        if sounding {
            if self.session_db <= SILENCE_DB {
                self.section_db = db;
                self.session_db = db;
            }
            self.section_db = follow(self.section_db, db, SECTION_SECS, dt);
            self.session_db = follow(self.session_db, db, SESSION_SECS, dt);
        }
        let section = if self.session_db > SILENCE_DB { squash(self.section_db - self.session_db, 3.0) } else { 0.5 };

        Features {
            level: ((db + 60.0) / 60.0).clamp(0.0, 1.0),
            bands,
            bass,
            mid,
            high,
            hit,
            hits: u32::from(hit > 0.0),
            bass_hit,
            bass_hits: u32::from(bass_hit > 0.0),
            brightness,
            noisiness,
            section,
            active,
        }
    }
}

/// Folds frames into one for sending: the latest values, with the strongest hit and every hit
/// counted, so none is lost between sends.
pub fn merge(into: &mut Option<Features>, next: Features) {
    match into {
        None => *into = Some(next),
        Some(prev) => {
            let hit = prev.hit.max(next.hit);
            let hits = prev.hits + next.hits;
            let bass_hit = prev.bass_hit.max(next.bass_hit);
            let bass_hits = prev.bass_hits + next.bass_hits;
            *prev = Features { hit, hits, bass_hit, bass_hits, ..next };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn sine(hz: f32, amp: f32, secs: f32) -> Vec<f32> {
        (0..(RATE * secs) as usize).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / RATE).sin()).collect()
    }

    fn last(frames: &[Features]) -> Features {
        frames.last().cloned().unwrap()
    }

    #[test]
    fn silence_is_inactive_and_still() {
        let mut a = Analyzer::new(RATE);
        let f = last(&a.push(&vec![0.0; (RATE * 2.0) as usize]));
        assert!(!f.active);
        assert_eq!(f.level, 0.0);
        assert_eq!(f.bass, 0.0);
        assert_eq!(f.hit, 0.0);
    }

    #[test]
    fn a_low_tone_is_dark_and_a_high_one_bright() {
        let low = last(&Analyzer::new(RATE).push(&sine(150.0, 0.3, 1.0)));
        let high = last(&Analyzer::new(RATE).push(&sine(5000.0, 0.3, 1.0)));
        assert!(low.active && high.active);
        assert!(low.brightness < 0.3, "low tone brightness {}", low.brightness);
        assert!(high.brightness > 0.7, "high tone brightness {}", high.brightness);
        // A pure tone is tonal, not noise.
        assert!(low.noisiness < 0.2, "tone noisiness {}", low.noisiness);
    }

    #[test]
    fn a_steady_sound_settles_to_usual_however_loud() {
        // The same tone, quiet and loud: after a while each band reads "as usual" either way.
        for amp in [0.02, 0.6] {
            let f = last(&Analyzer::new(RATE).push(&sine(80.0, amp, 20.0)));
            assert!((f.bass - 0.5).abs() < 0.1, "amp {amp}: bass {}", f.bass);
        }
    }

    #[test]
    fn a_swell_reads_above_usual() {
        let mut a = Analyzer::new(RATE);
        a.push(&sine(80.0, 0.05, 8.0));
        let f = last(&a.push(&sine(80.0, 0.4, 0.2)));
        assert!(f.bass > 0.8, "bass after swell {}", f.bass);
    }

    #[test]
    fn clicks_are_hits_and_steady_tones_are_not() {
        // A click every half second over a quiet tone: about one hit each.
        let mut samples = sine(220.0, 0.05, 4.0);
        for k in 0..8 {
            let at = (RATE * (0.25 + 0.5 * k as f32)) as usize;
            for (j, s) in samples[at..at + 200].iter_mut().enumerate() {
                *s += 0.8 * (-(j as f32) / 40.0).exp() * if j % 2 == 0 { 1.0 } else { -1.0 };
            }
        }
        let frames = Analyzer::new(RATE).push(&samples);
        let hits: u32 = frames.iter().map(|f| f.hits).sum();
        assert!((7..=9).contains(&hits), "hits {hits}");

        let steady: u32 = Analyzer::new(RATE).push(&sine(220.0, 0.3, 4.0)).iter().skip(20).map(|f| f.hits).sum();
        assert_eq!(steady, 0);
    }

    /// A kick drum: a low thump that drops in pitch and dies away in about a tenth of a second.
    fn kick(samples: &mut [f32], at: usize, amp: f32) {
        for j in 0..(RATE * 0.15) as usize {
            let t = j as f32 / RATE;
            let hz = 55.0 + 60.0 * (-t / 0.02).exp();
            samples[at + j] += amp * (-t / 0.06).exp() * (2.0 * std::f32::consts::PI * hz * t).sin();
        }
    }

    #[test]
    fn kicks_are_bass_hits() {
        let mut samples = sine(220.0, 0.05, 4.0);
        for k in 0..8 {
            kick(&mut samples, (RATE * (0.25 + 0.5 * k as f32)) as usize, 0.8);
        }
        let bass_hits: u32 = Analyzer::new(RATE).push(&samples).iter().map(|f| f.bass_hits).sum();
        assert!((7..=9).contains(&bass_hits), "bass hits {bass_hits}");

        // The same kicks over a steady bass line, as in most music: still one each.
        let mut over_bass = sine(70.0, 0.2, 4.0);
        for k in 0..8 {
            kick(&mut over_bass, (RATE * (0.25 + 0.5 * k as f32)) as usize, 0.8);
        }
        let bass_hits: u32 = Analyzer::new(RATE).push(&over_bass).iter().map(|f| f.bass_hits).sum();
        assert!((7..=9).contains(&bass_hits), "bass hits over a bass line {bass_hits}");
    }

    #[test]
    fn clicks_and_a_moving_bass_line_are_not_bass_hits() {
        // Hi-hat-like clicks: hits, but not in the bass.
        let mut clicks = sine(220.0, 0.05, 4.0);
        for k in 0..8 {
            let at = (RATE * (0.25 + 0.5 * k as f32)) as usize;
            for (j, s) in clicks[at..at + 200].iter_mut().enumerate() {
                *s += 0.8 * (-(j as f32) / 40.0).exp() * if j % 2 == 0 { 1.0 } else { -1.0 };
            }
        }
        let frames = Analyzer::new(RATE).push(&clicks);
        assert!(frames.iter().map(|f| f.hits).sum::<u32>() >= 7);
        assert_eq!(frames.iter().map(|f| f.bass_hits).sum::<u32>(), 0);

        // A steady bass line stepping between notes, with no attack: no thumps.
        let line: Vec<f32> = (0..8).flat_map(|k| sine(if k % 2 == 0 { 70.0 } else { 98.0 }, 0.3, 0.5)).collect();
        let stepped: u32 = Analyzer::new(RATE).push(&line).iter().skip(40).map(|f| f.bass_hits).sum();
        assert!(stepped <= 1, "bass line counted as {stepped} bass hits");
    }

    #[test]
    fn merging_keeps_every_hit() {
        let mut merged = None;
        merge(&mut merged, Features { hit: 0.3, hits: 1, level: 0.2, ..Default::default() });
        merge(&mut merged, Features { hit: 0.0, hits: 0, level: 0.4, ..Default::default() });
        merge(&mut merged, Features { hit: 0.7, hits: 1, level: 0.5, ..Default::default() });
        let f = merged.unwrap();
        assert_eq!(f.hits, 2);
        assert_eq!(f.hit, 0.7);
        assert_eq!(f.level, 0.5);
    }
}
