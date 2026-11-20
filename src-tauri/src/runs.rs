//! Watching child processes. A run is stopped when it goes quiet too long, runs too long, is
//! cancelled from the app, or the app quits, and whatever it started (Claude Code's MCP servers,
//! say) goes with it: on macOS and Linux each run leads its own process group, and the whole group
//! is signalled; on Windows its process tree is ended.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a run may take: without printing a line (`idle_secs`), and in all (`total_secs`).
/// None leaves that limit off.
#[derive(serde::Deserialize, Default, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub idle_secs: Option<u64>,
    pub total_secs: Option<u64>,
}

struct Entry {
    pid: u32,
    stop: Arc<AtomicBool>,
    /// Set while the run waits on the user (a permission ask in a chat): the idle limit is off.
    waiting: Arc<AtomicBool>,
    /// The run's stdin, for a run that's written to as it goes (see supervise_open); None once closed.
    input: Option<Input>,
}

/// A run's stdin, kept open so the app can write to it while it runs.
type Input = Arc<Mutex<Option<ChildStdin>>>;

/// The runs in flight, so the app can stop one, and stop them all when it quits.
#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, Entry>>);

impl Runs {
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn add(&self, id: &str, pid: u32, input: Option<Input>) -> (Arc<AtomicBool>, Arc<AtomicBool>) {
        let stop = Arc::new(AtomicBool::new(false));
        let waiting = Arc::new(AtomicBool::new(false));
        self.entries().insert(id.to_string(), Entry { pid, stop: stop.clone(), waiting: waiting.clone(), input });
        (stop, waiting)
    }

    /// Writes `text` to a run's stdin (see supervise_open), after anything written before it.
    pub fn write(&self, id: &str, text: &str) -> Result<(), String> {
        let input = self.entries().get(id).and_then(|e| e.input.clone()).ok_or_else(|| format!("No run {id} to write to"))?;
        let mut pipe = input.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let pipe = pipe.as_mut().ok_or_else(|| format!("Run {id} no longer takes input"))?;
        pipe.write_all(text.as_bytes()).and_then(|_| pipe.flush()).map_err(|e| e.to_string())
    }

    /// Closes a run's stdin, which ends a run that reads until it's closed. False when there's none.
    pub fn close_input(&self, id: &str) -> bool {
        let Some(input) = self.entries().get(id).and_then(|e| e.input.clone()) else { return false };
        let closed = input.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().is_some();
        closed
    }

    /// Marks a run as waiting on the user, or not. While it waits, it isn't stopped for going quiet.
    pub fn set_waiting(&self, id: &str, waiting: bool) -> bool {
        match self.entries().get(id) {
            Some(entry) => {
                entry.waiting.store(waiting, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    fn remove(&self, id: &str) {
        self.entries().remove(id);
    }

    /// Asks one run to stop; it's ended within a moment. False when no run has that id.
    pub fn cancel(&self, id: &str) -> bool {
        match self.entries().get(id) {
            Some(entry) => {
                entry.stop.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Ends every run's processes at once, without waiting on them: the app is quitting or
    /// relaunching, and nothing will be left to watch them.
    pub fn kill_all(&self) {
        let entries = self.entries();
        for entry in entries.values() {
            entry.stop.store(true, Ordering::SeqCst);
            kill_tree(entry.pid, false);
        }
        if entries.is_empty() {
            return;
        }
        // A moment to exit cleanly (Claude Code saves its session), then for good.
        std::thread::sleep(Duration::from_millis(400));
        for entry in entries.values() {
            kill_tree(entry.pid, true);
        }
    }
}

/// Signals a run's whole process group (`hard`: SIGKILL, else SIGTERM). On Windows, ends its
/// process tree.
pub fn kill_tree(pid: u32, hard: bool) {
    #[cfg(unix)]
    {
        let sig = if hard { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: plain signal calls on a process id; no memory is shared.
        unsafe {
            // A run leads its own group (see `command` in lib.rs); if it somehow doesn't, at least
            // the run itself goes.
            if libc::killpg(pid as libc::pid_t, sig) != 0 {
                libc::kill(pid as libc::pid_t, sig);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = hard;
        let taskkill = std::env::var_os("SystemRoot")
            .map(|root| std::path::PathBuf::from(root).join("System32").join("taskkill.exe"))
            .unwrap_or_else(|| "taskkill".into());
        let _ = std::process::Command::new(taskkill)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// What a finished run printed, and how it ended.
pub struct Finished {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// An exit code, or 128 plus the signal for a run a signal ended (as a shell reports it).
fn exit_code(status: ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return 128 + sig;
        }
    }
    status.code().unwrap_or(-1)
}

fn minutes(secs: u64) -> String {
    match secs {
        1 => "a second".into(),
        s if s < 60 => format!("{s} seconds"),
        60..=119 => "a minute".into(),
        s => format!("{} minutes", s / 60),
    }
}

/// Waits for a started run under `id`, passing each line it prints to `on_line`, and stops it
/// (whole process tree) when it goes past `limits` or is cancelled. Err says why it was stopped.
pub fn supervise(runs: &Runs, id: &str, child: Child, limits: Limits, on_line: impl FnMut(&str)) -> Result<Finished, String> {
    supervised(runs, id, child, None, limits, on_line)
}

/// Like supervise, for a run that's written to as it goes (a chat answering Claude Code's
/// permission asks): `first` goes on its stdin, which then stays open for Runs::write until
/// Runs::close_input. The child must have been started with a piped stdin.
pub fn supervise_open(runs: &Runs, id: &str, mut child: Child, first: String, limits: Limits, on_line: impl FnMut(&str)) -> Result<Finished, String> {
    // Written on its own thread, so a long first message can't deadlock with output the child is
    // writing meanwhile. The pipe is handed over for later writes only once it's written, so nothing
    // can go ahead of it (a write before then fails as if the run took no input).
    let input: Input = Arc::new(Mutex::new(None));
    let holder = input.clone();
    let pipe = child.stdin.take();
    std::thread::spawn(move || {
        let Some(mut pipe) = pipe else { return };
        if pipe.write_all(first.as_bytes()).and_then(|_| pipe.flush()).is_ok() {
            *holder.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(pipe);
        }
    });
    supervised(runs, id, child, Some(input), limits, on_line)
}

fn supervised(runs: &Runs, id: &str, mut child: Child, input: Option<Input>, limits: Limits, mut on_line: impl FnMut(&str)) -> Result<Finished, String> {
    let pid = child.id();
    let (stop, waiting) = runs.add(id, pid, input);
    let result = watch(&mut child, pid, &stop, &waiting, limits, &mut on_line);
    runs.remove(id);
    result
}

fn watch(child: &mut Child, pid: u32, stop: &AtomicBool, waiting: &AtomicBool, limits: Limits, on_line: &mut impl FnMut(&str)) -> Result<Finished, String> {
    // Output is read on threads of their own, so the wait below never blocks on a pipe.
    let (line_tx, lines) = mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf).trim_end_matches(['\n', '\r']).to_string();
                        if line_tx.send(line).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    } else {
        drop(line_tx);
    }
    let (err_tx, stderr_done) = mpsc::channel::<String>();
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf);
            let _ = err_tx.send(buf);
        });
    }

    let started = Instant::now();
    let mut last_line = started;
    let mut stdout = String::new();
    let mut eof = false;
    let mut exited: Option<(ExitStatus, Instant)> = None;
    let stopped = loop {
        if eof {
            std::thread::sleep(Duration::from_millis(50));
        } else {
            match lines.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    last_line = Instant::now();
                    on_line(&line);
                    stdout.push_str(&line);
                    stdout.push('\n');
                    continue;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => eof = true,
            }
        }
        if exited.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => exited = Some((status, Instant::now())),
                Ok(None) => {}
                Err(e) => break Some(format!("Couldn't follow the run: {e}")),
            }
        }
        if let Some((_, at)) = exited {
            // Its output ends with it, unless something it started still holds the pipe open.
            if eof || at.elapsed() > Duration::from_secs(2) {
                break None;
            }
            continue;
        }
        if stop.load(Ordering::SeqCst) {
            break Some("Stopped".to_string());
        }
        // Quiet while it waits on the user doesn't count: the idle clock starts once it's answered.
        if waiting.load(Ordering::SeqCst) {
            last_line = Instant::now();
        }
        if let Some(idle) = limits.idle_secs {
            if last_line.elapsed() > Duration::from_secs(idle) {
                break Some(format!("no progress for {}", minutes(idle)));
            }
        }
        if let Some(total) = limits.total_secs {
            if started.elapsed() > Duration::from_secs(total) {
                break Some(format!("still going after {}", minutes(total)));
            }
        }
    };

    if let Some(reason) = stopped {
        // A moment to exit cleanly, then for good, with everything it started.
        kill_tree(pid, false);
        let grace = Instant::now();
        while grace.elapsed() < Duration::from_secs(3) {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        kill_tree(pid, true);
        let _ = child.kill();
        let _ = child.wait();
        return Err(reason);
    }

    // Ended from outside (kill_all, as the app quits) while it was being asked to stop: report that,
    // not the signal it died of.
    if stop.load(Ordering::SeqCst) {
        return Err("Stopped".to_string());
    }
    let (status, _) = exited.expect("the loop only ends without a reason once the run has exited");
    Ok(Finished {
        code: exit_code(status),
        stdout,
        stderr: stderr_done.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    fn start(script: &str) -> Child {
        Command::new("sh").args(["-c", script]).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).spawn().unwrap()
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn passes_each_line_and_returns_the_output() {
        let runs = Runs::default();
        let mut seen = vec![];
        let done = supervise(&runs, "a", start("echo one; echo two >&2; echo three; exit 3"), Limits::default(), |l| seen.push(l.to_string())).unwrap();
        assert_eq!(seen, ["one", "three"]);
        assert_eq!(done.stdout, "one\nthree\n");
        assert_eq!(done.stderr, "two\n");
        assert_eq!(done.code, 3);
        assert!(runs.entries().is_empty());
    }

    #[test]
    fn stops_a_run_that_goes_quiet() {
        let started = Instant::now();
        let err = supervise(&Runs::default(), "b", start("echo hi; sleep 30"), Limits { idle_secs: Some(1), total_secs: None }, |_| {}).err().unwrap();
        assert_eq!(err, "no progress for a second");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn stops_a_run_that_takes_too_long_even_while_it_prints() {
        let err = supervise(&Runs::default(), "c", start("while true; do echo tick; sleep 0.2; done"), Limits { idle_secs: Some(5), total_secs: Some(1) }, |_| {}).err().unwrap();
        assert_eq!(err, "still going after a second");
    }

    #[test]
    fn a_cancel_stops_the_run_and_everything_it_started() {
        let runs = Arc::new(Runs::default());
        let child = start("sleep 30 & echo $!; wait");
        let canceller = runs.clone();
        let handle = std::thread::spawn(move || {
            while !canceller.cancel("d") {
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let mut grandchild = 0;
        let err = supervise(&runs, "d", child, Limits::default(), |l| grandchild = l.trim().parse().unwrap_or(0)).err().unwrap();
        handle.join().unwrap();
        assert_eq!(err, "Stopped");
        assert!(grandchild > 0);
        std::thread::sleep(Duration::from_millis(100));
        assert!(!alive(grandchild), "the run's own child outlived it");
    }

    #[test]
    fn kill_all_ends_every_run_at_once() {
        let runs = Arc::new(Runs::default());
        let watcher = runs.clone();
        let handle = std::thread::spawn(move || supervise(&watcher, "e", start("sleep 30"), Limits::default(), |_| {}));
        while runs.entries().is_empty() {
            std::thread::sleep(Duration::from_millis(20));
        }
        let started = Instant::now();
        runs.kill_all();
        assert!(handle.join().unwrap().is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn writes_to_an_open_run_as_it_goes_and_ends_it_by_closing_its_input() {
        let runs = Arc::new(Runs::default());
        let child = Command::new("cat").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).spawn().unwrap();
        let writer = runs.clone();
        let handle = std::thread::spawn(move || {
            while writer.write("g", "second\n").is_err() {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(writer.close_input("g"));
        });
        let done = supervise_open(&runs, "g", child, "first\n".into(), Limits { idle_secs: Some(5), total_secs: Some(10) }, |_| {}).unwrap();
        handle.join().unwrap();
        assert_eq!(done.stdout, "first\nsecond\n");
        assert!(runs.write("g", "late\n").is_err());
    }

    #[test]
    fn a_run_waiting_on_the_user_isnt_stopped_for_going_quiet() {
        let runs = Arc::new(Runs::default());
        let marker = runs.clone();
        let handle = std::thread::spawn(move || {
            while !marker.set_waiting("h", true) {
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let done = supervise(&runs, "h", start("sleep 2; echo done"), Limits { idle_secs: Some(1), total_secs: Some(10) }, |_| {}).unwrap();
        handle.join().unwrap();
        assert_eq!(done.stdout, "done\n");
    }

    #[test]
    fn reports_a_signal_as_128_plus_it() {
        let done = supervise(&Runs::default(), "f", start("kill -TERM $$"), Limits::default(), |_| {}).unwrap();
        assert_eq!(done.code, 128 + libc::SIGTERM);
    }
}
