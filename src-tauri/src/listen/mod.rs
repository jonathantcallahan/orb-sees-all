//! The listening orb's ears: while it's showing, Demian hears what's playing on the Mac (not its
//! own sounds) and sends the orb a few numbers about it, about sixty times a second, as soon as it hears it. No audio is
//! kept or sent anywhere; it's reduced to those numbers as it arrives.
//!
//! The frontend starts listening when the orb appears (`start_listening`, with a channel for what
//! it hears) and stops when it goes (`stop_listening`). Only one listener runs at a time.

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod analysis;
#[cfg(target_os = "macos")]
mod capture;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

pub use analysis::Features;

/// What the orb is told: a frame of features, or how listening is going.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Heard {
    Features(Features),
    /// "listening", "unavailable" (no taps on this system) or "error" (with what went wrong; it
    /// keeps retrying).
    Status { state: &'static str, detail: Option<String> },
}

/// The listener now running, by its stop flag.
#[derive(Default)]
pub struct Listening(Mutex<Option<Arc<AtomicBool>>>);

impl Listening {
    fn replace(&self, next: Option<Arc<AtomicBool>>) {
        let mut current = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(stop) = current.take() {
            stop.store(true, Ordering::Relaxed);
        }
        *current = next;
    }
}

#[tauri::command]
pub fn start_listening(state: tauri::State<'_, Listening>, on_heard: Channel<Heard>) {
    let stop = Arc::new(AtomicBool::new(false));
    state.replace(Some(stop.clone()));
    #[cfg(target_os = "macos")]
    std::thread::Builder::new()
        .name("listening".into())
        .spawn(move || run(stop, on_heard))
        .ok();
    #[cfg(not(target_os = "macos"))]
    {
        let _ = stop;
        let _ = on_heard.send(Heard::Status { state: "unavailable", detail: None });
    }
}

#[tauri::command]
pub fn stop_listening(state: tauri::State<'_, Listening>) {
    state.replace(None);
}

/// Sends at most this often while music plays (about 60 a second), and ten a second in silence.
#[cfg(target_os = "macos")]
const SEND_EVERY: std::time::Duration = std::time::Duration::from_millis(16);
#[cfg(target_os = "macos")]
const SEND_EVERY_QUIET: std::time::Duration = std::time::Duration::from_millis(100);

#[cfg(target_os = "macos")]
fn run(stop: Arc<AtomicBool>, channel: Channel<Heard>) {
    use std::time::{Duration, Instant};

    let mut capture: Option<(capture::Capture, rtrb::Consumer<f32>, analysis::Analyzer)> = None;
    let mut checked = Instant::now() - Duration::from_secs(10);
    let mut failed: Option<Instant> = None;
    // Sent as soon as they're analyzed: even through Bluetooth headphones, waiting for the sound to
    // come out made the orb feel late, not in step.
    let mut ready: Option<Features> = None;
    let mut sent = Instant::now();
    let mut buffer = Vec::with_capacity(8192);

    while !stop.load(Ordering::Relaxed) {
        // (Re)build the tap at the start, when the sound moves to another output (headphones in or
        // out), and a few seconds after a failure.
        if checked.elapsed() > Duration::from_secs(1) {
            checked = Instant::now();
            let output = capture::default_output();
            let stale = capture.as_ref().is_some_and(|(c, _, _)| c.output != output);
            let retry = failed.is_none_or(|at| at.elapsed() > Duration::from_secs(5));
            if (capture.is_none() && retry) || stale {
                capture = None;
                match capture::Capture::start() {
                    Ok((c, consumer)) => {
                        let analyzer = analysis::Analyzer::new(c.sample_rate);
                        capture = Some((c, consumer, analyzer));
                        failed = None;
                        if channel.send(Heard::Status { state: "listening", detail: None }).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        failed = Some(Instant::now());
                        if channel.send(Heard::Status { state: "error", detail: Some(e) }).is_err() {
                            return;
                        }
                    }
                }
            }
        }

        if let Some((_, consumer, analyzer)) = capture.as_mut() {
            buffer.clear();
            if let Ok(chunk) = consumer.read_chunk(consumer.slots()) {
                buffer.extend(chunk);
            }
            for frame in analyzer.push(&buffer) {
                analysis::merge(&mut ready, frame);
            }
        }
        let every = if ready.as_ref().is_some_and(|f| f.active) { SEND_EVERY } else { SEND_EVERY_QUIET };
        if sent.elapsed() >= every {
            if let Some(frame) = ready.take() {
                sent = Instant::now();
                if channel.send(Heard::Features(frame)).is_err() {
                    // The window that asked is gone.
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(3));
    }
}
