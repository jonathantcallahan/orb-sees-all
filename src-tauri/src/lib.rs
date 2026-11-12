mod listen;
mod media;
mod runs;
mod sessions;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_sql::{Migration, MigrationKind};

/// The only programs the frontend may run.
const ALLOWED_PROGRAMS: [&str; 3] = ["claude", "git", "gh"];

#[derive(serde::Serialize)]
struct CliOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Environment passed through to child processes. Everything else is dropped:
/// if the app was started from a shell that carries another tool's Anthropic
/// credentials (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ...), claude would use
/// those instead of the user's own login and lose the claude.ai connectors.
#[cfg(not(windows))]
const PASSTHROUGH_ENV: &[&str] = &["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "SSH_AUTH_SOCK"];
/// On Windows, Claude Code finds its login and config through the profile folders, and Git Bash
/// (which it needs) through the program folders.
#[cfg(windows)]
const PASSTHROUGH_ENV: &[&str] = &[
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SystemRoot",
    "SystemDrive", "windir", "ComSpec", "PATHEXT", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
    "CLAUDE_CODE_GIT_BASH_PATH",
];

/// The user's home folder: HOME on macOS and Linux. On Windows, USERPROFILE first: that's where
/// Claude Code keeps its sessions, and HOME there is often a Git Bash path like /c/Users/me.
pub(crate) fn home_dir() -> Option<PathBuf> {
    let (first, second) = if cfg!(windows) { ("USERPROFILE", "HOME") } else { ("HOME", "USERPROFILE") };
    std::env::var_os(first).or_else(|| std::env::var_os(second)).map(PathBuf::from)
}

/// Apps launched from Finder or the Start menu don't inherit the login shell's
/// PATH, so add the usual install locations for claude, gh and git.
fn search_path() -> std::ffi::OsString {
    let home = home_dir().unwrap_or_default();
    let mut parts: Vec<PathBuf> = vec![home.join(".local").join("bin")];
    #[cfg(windows)]
    {
        let env_dir = |var: &str, rest: &[&str]| std::env::var_os(var).map(|v| rest.iter().fold(PathBuf::from(v), |p, r| p.join(r)));
        parts.extend(
            [
                env_dir("APPDATA", &["npm"]),
                env_dir("ProgramFiles", &["Git", "cmd"]),
                env_dir("ProgramFiles", &["GitHub CLI"]),
                env_dir("LOCALAPPDATA", &["Programs", "Git", "cmd"]),
            ]
            .into_iter()
            .flatten(),
        );
    }
    #[cfg(not(windows))]
    {
        // Where npm-installed tools land under the common Node version managers and npm setups, so
        // a claude installed that way is found too (and setup doesn't offer to install a second).
        parts.extend([".npm-global/bin", ".volta/bin", ".bun/bin", ".asdf/shims"].map(|d| home.join(d)));
        if let Ok(versions) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut bins: Vec<PathBuf> = versions.flatten().map(|v| v.path().join("bin")).collect();
            // Roughly newest first, by name: any one of them with claude in it will do.
            bins.sort();
            parts.extend(bins.into_iter().rev());
        }
        parts.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    }
    if let Some(existing) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(parts).unwrap_or_default()
}

/// Network and certificate settings Claude Code may need to reach claude.ai on a company network
/// (a proxy, a company root certificate), and where its config lives if moved. Never credentials.
const NETWORK_ENV: &[&str] = &[
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_USE_SYSTEM_CA", "CLAUDE_CONFIG_DIR",
];

/// Those settings from the user's login shell, read once. An app opened from Finder doesn't get what
/// the shell profile exports, so Claude Code would run without the proxy or certificate that their
/// Terminal has. Gives up after a few seconds if the profile hangs.
#[cfg(not(windows))]
fn login_shell_env() -> &'static Vec<(String, String)> {
    static ENV: std::sync::OnceLock<Vec<(String, String)>> = std::sync::OnceLock::new();
    ENV.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let out = Command::new(shell).args(["-ilc", "env"]).stdin(Stdio::null()).stderr(Stdio::null()).output();
            let _ = tx.send(out);
        });
        let Ok(Ok(out)) = rx.recv_timeout(Duration::from_secs(4)) else { return vec![] };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| line.split_once('='))
            .filter(|(k, _)| NETWORK_ENV.contains(k))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    })
}

fn passthrough_env() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = PASSTHROUGH_ENV
        .iter()
        .chain(NETWORK_ENV)
        .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_string(), value)))
        .collect();
    #[cfg(not(windows))]
    for (k, v) in login_shell_env() {
        if !env.iter().any(|(have, _)| have == k) {
            env.push((k.clone(), v.clone()));
        }
    }
    env
}

/// A child process with only the passthrough environment, the search path, and (on Windows) no
/// console window flashing up.
fn command(exe: &Program, args: &[String], dir: &PathBuf, path: &std::ffi::OsString, stdin: bool) -> Command {
    let mut cmd = Command::new(&exe.path);
    cmd.args(&exe.leading_args)
        .args(args)
        .current_dir(dir)
        .env_clear()
        .envs(passthrough_env())
        .env("PATH", path)
        // Newer Claude Code doesn't wait for MCP servers to connect in a headless run, so a run can
        // start, and even finish, before the claude.ai connectors (Slack, Gmail, Calendar) arrive.
        .env("MCP_CONNECTION_NONBLOCKING", "false")
        // A connector call that hangs fails after five minutes, as an error the run can work
        // around, instead of holding the run until it's stopped (see runs.rs).
        .env("MCP_TOOL_TIMEOUT", "300000")
        .stdin(if stdin { Stdio::piped() } else { Stdio::null() });
    // Each run leads its own process group, so stopping it stops everything it started.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Where child processes run. claude runs outside any repo so it doesn't pick
/// up a project's CLAUDE.md.
fn work_dir(app: &AppHandle, cwd: Option<String>) -> Result<PathBuf, String> {
    match cwd {
        // Said plainly, rather than as the OS's error from starting a program in it (a Claude
        // session carried on in its own folder, once that folder has been removed).
        Some(dir) if !Path::new(&dir).is_dir() => Err(format!("The folder {dir} isn't there anymore")),
        Some(dir) => Ok(PathBuf::from(dir)),
        None => {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("work");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            Ok(dir)
        }
    }
}

/// What to start for an allowed program: an executable, and any arguments that come before the
/// caller's (the script, when a program runs through node).
struct Program {
    path: PathBuf,
    leading_args: Vec<String>,
}

fn find_on(path: &std::ffi::OsString, name: &str) -> Option<PathBuf> {
    std::env::split_paths(path).map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
}

/// Finds a program on the search path. On Windows a native .exe anywhere on the path wins over an
/// npm .cmd shim: a .cmd runs through cmd.exe, which caps the command line at about 8k characters
/// and rewrites %, ^, & and newlines in arguments. When claude exists only as the npm shim, its
/// script is run with node directly instead.
fn resolve(program: &str, path: &std::ffi::OsString) -> Option<Program> {
    if !cfg!(windows) {
        return find_on(path, program).map(|path| Program { path, leading_args: vec![] });
    }
    if let Some(path) = find_on(path, &format!("{program}.exe")) {
        return Some(Program { path, leading_args: vec![] });
    }
    let shim = find_on(path, &format!("{program}.cmd"))?;
    if program == "claude" {
        let script = shim.parent()?.join("node_modules").join("@anthropic-ai").join("claude-code").join("cli.js");
        if let (true, Some(node)) = (script.is_file(), find_on(path, "node.exe")) {
            return Some(Program { path: node, leading_args: vec![script.to_string_lossy().into_owned()] });
        }
    }
    Some(Program { path: shim, leading_args: vec![] })
}

/// Text for a child process: what goes on its stdin, and a system prompt to append, passed as a
/// file. Long prompts don't fit on a Windows command line (about 32k characters in all).
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CliInput {
    stdin: Option<String>,
    append_system_prompt: Option<String>,
}

/// Writes the system prompt to a temp file in the work folder and adds the flag that reads it;
/// the file is removed when the returned guard is dropped.
struct TempFile(Option<PathBuf>);
impl Drop for TempFile {
    fn drop(&mut self) {
        if let Some(p) = &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

fn with_system_prompt(dir: &PathBuf, args: &mut Vec<String>, text: Option<String>) -> Result<TempFile, String> {
    let Some(text) = text else { return Ok(TempFile(None)) };
    let file = dir.join(format!("system-prompt-{}-{}.txt", std::process::id(), nanos()));
    std::fs::write(&file, text).map_err(|e| e.to_string())?;
    args.push("--append-system-prompt-file".into());
    args.push(file.to_string_lossy().into_owned());
    Ok(TempFile(Some(file)))
}

fn nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// Writes `text` to the child's stdin on its own thread, so a large prompt can't deadlock with
/// output the child is writing meanwhile.
fn feed_stdin(child: &mut std::process::Child, text: Option<String>) {
    use std::io::Write;
    if let (Some(text), Some(mut pipe)) = (text, child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = pipe.write_all(text.as_bytes());
        });
    }
}

/// How long a run may take when the caller doesn't say: a quick git, gh or claude check has five
/// minutes; a Claude run streaming its work is stopped after ten minutes with no output, or an hour
/// in all.
const QUICK_LIMITS: runs::Limits = runs::Limits { idle_secs: None, total_secs: Some(300) };
const STREAM_LIMITS: runs::Limits = runs::Limits { idle_secs: Some(600), total_secs: Some(3600) };

fn finished(out: runs::Finished) -> CliOutput {
    CliOutput { code: out.code, stdout: out.stdout, stderr: out.stderr }
}

/// Runs an allowed program and returns what it printed. `id` lets the app stop it (cancel_run);
/// `limits` caps how long it may take (QUICK_LIMITS when not given).
#[tauri::command]
async fn run_cli(
    app: AppHandle,
    program: String,
    mut args: Vec<String>,
    cwd: Option<String>,
    input: Option<CliInput>,
    id: Option<String>,
    limits: Option<runs::Limits>,
) -> Result<CliOutput, String> {
    if !ALLOWED_PROGRAMS.contains(&program.as_str()) {
        return Err(format!("{program} is not an allowed program"));
    }
    let path = search_path();
    let exe = resolve(&program, &path).ok_or_else(|| format!("{program} not found on PATH"))?;
    let dir = work_dir(&app, cwd)?;

    let input = input.unwrap_or_default();
    let prompt_file = with_system_prompt(&work_dir(&app, None)?, &mut args, input.append_system_prompt)?;
    let has_stdin = input.stdin.is_some();
    let id = id.unwrap_or_else(|| format!("run-{}", nanos()));
    tauri::async_runtime::spawn_blocking(move || {
        let _prompt_file = prompt_file;
        let mut child = command(&exe, &args, &dir, &path, has_stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Couldn't start {program} in {}: {e}", dir.display()))?;
        feed_stdin(&mut child, input.stdin);
        runs::supervise(&app.state::<runs::Runs>(), &id, child, limits.unwrap_or(QUICK_LIMITS), |_| {}).map(finished)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CliLine {
    stream_id: String,
    line: String,
}

/// Like run_cli, but emits each stdout line as a `cli-line` event while the program runs, so the
/// frontend can show progress. The stream id is also the run's id for cancel_run; `limits` defaults
/// to STREAM_LIMITS.
#[tauri::command]
async fn run_cli_stream(
    app: AppHandle,
    stream_id: String,
    program: String,
    mut args: Vec<String>,
    cwd: Option<String>,
    input: Option<CliInput>,
    limits: Option<runs::Limits>,
) -> Result<CliOutput, String> {
    if !ALLOWED_PROGRAMS.contains(&program.as_str()) {
        return Err(format!("{program} is not an allowed program"));
    }
    let path = search_path();
    let exe = resolve(&program, &path).ok_or_else(|| format!("{program} not found on PATH"))?;
    let dir = work_dir(&app, cwd)?;

    let input = input.unwrap_or_default();
    let prompt_file = with_system_prompt(&work_dir(&app, None)?, &mut args, input.append_system_prompt)?;
    let has_stdin = input.stdin.is_some();
    tauri::async_runtime::spawn_blocking(move || {
        let _prompt_file = prompt_file;
        let mut child = command(&exe, &args, &dir, &path, has_stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Couldn't start {program} in {}: {e}", dir.display()))?;
        feed_stdin(&mut child, input.stdin);
        let emitter = app.clone();
        runs::supervise(&app.state::<runs::Runs>(), &stream_id, child, limits.unwrap_or(STREAM_LIMITS), |line| {
            let _ = emitter.emit("cli-line", CliLine { stream_id: stream_id.clone(), line: line.to_string() });
        })
        .map(finished)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops one run (see run_cli). False when it isn't running.
#[tauri::command]
fn cancel_run(runs: tauri::State<'_, runs::Runs>, id: String) -> bool {
    runs.cancel(&id)
}

/// Stops every run at once, before the app relaunches for an update.
#[tauri::command]
fn cancel_all_runs(runs: tauri::State<'_, runs::Runs>) {
    runs.kill_all();
}

/// The first time the window is closed on Windows: a notice that Demian keeps running in the tray.
#[cfg(windows)]
fn tell_once_still_running(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let marker = dir.join("told-still-running");
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&marker, "");
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Demian is still running")
        .body("It keeps refreshing in the background. Click the tray icon to open it, or right-click it to quit.")
        .show();
}

/// How old a GitHub mirror may get before it's fetched again.
const MIRROR_MAX_AGE: Duration = Duration::from_secs(12 * 60 * 60);

/// A read-only copy of a GitHub repo's default branch, for Claude to read code from: a shallow
/// clone (through gh, so private repos work with the user's GitHub sign-in) under the app's data
/// folder, refreshed when it's more than 12 hours old by cloning afresh and swapping it in. Returns
/// its folder. `repo` must look like owner/name.
#[tauri::command]
async fn mirror_repo(app: AppHandle, repo: String) -> Result<String, String> {
    let valid = |part: &str| !part.is_empty() && part != "." && part != ".." && part.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    let Some((owner, name)) = repo.split_once('/') else { return Err(format!("Not a GitHub repo: {repo}")) };
    if !valid(owner) || !valid(name) {
        return Err(format!("Not a GitHub repo: {repo}"));
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("repos");
    let dir = root.join(owner).join(name);
    let fresh = dir
        .join(".git")
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < MIRROR_MAX_AGE);
    if fresh {
        return Ok(dir.to_string_lossy().into_owned());
    }
    let path = search_path();
    let gh = resolve("gh", &path).ok_or("gh not found on PATH")?;
    let parent = dir.parent().ok_or("bad repo folder")?.to_path_buf();
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    // A clone cut short (the app quit mid-way) leaves its staging folder behind; clear those first.
    if let Ok(entries) = std::fs::read_dir(&parent) {
        let prefix = format!(".{name}-");
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let staging = parent.join(format!(".{name}-{}", nanos()));
    let target = staging.to_string_lossy().into_owned();
    let dir2 = dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let child = command(&gh, &["repo".into(), "clone".into(), repo.clone(), target, "--".into(), "--depth".into(), "1".into(), "--single-branch".into()], &parent, &path, false)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        // A shallow clone; a quarter of an hour means the network or GitHub is stuck.
        let limits = runs::Limits { idle_secs: None, total_secs: Some(900) };
        let out = runs::supervise(&app.state::<runs::Runs>(), &format!("mirror-{repo}-{}", nanos()), child, limits, |_| {});
        let failed = match &out {
            Ok(done) if done.code == 0 => None,
            Ok(done) => Some(done.stderr.trim().to_string()),
            Err(why) => Some(why.clone()),
        };
        if let Some(why) = failed {
            let _ = std::fs::remove_dir_all(&staging);
            // A stale copy still beats none.
            if dir2.exists() {
                return Ok(dir2.to_string_lossy().into_owned());
            }
            return Err(why);
        }
        if dir2.exists() {
            std::fs::remove_dir_all(&dir2).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&staging, &dir2).map_err(|e| e.to_string())?;
        Ok(dir2.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where the user's own clones of GitHub repos are: "owner/name" (lowercase) to the checkout's
/// folder, from each checkout's origin remote. Looked for in the home folder and the usual places
/// people keep code, two levels down, skipping system and dependency folders. Rebuilt at most every
/// ten minutes.
fn checkout_index() -> HashMap<String, String> {
    static INDEX: Mutex<Option<(Instant, HashMap<String, String>)>> = Mutex::new(None);
    let mut cached = INDEX.lock().unwrap();
    if let Some((at, index)) = cached.as_ref() {
        if at.elapsed() < Duration::from_secs(600) {
            return index.clone();
        }
    }
    let mut index = HashMap::new();
    if let Some(home) = home_dir() {
        // Never into macOS's protected folders (Desktop, Documents, Downloads): reading them asks the
        // user's permission, and an unsigned app is asked again after every update. Code mapped in
        // Settings can live anywhere.
        const SKIP: &[&str] = &[
            "Library", "Applications", "Pictures", "Movies", "Music", "Public", "node_modules", "AppData", ".Trash", "Desktop", "Documents", "Downloads",
        ];
        // The home folder itself, then where people and tools put code: Xcode-era Developer, the
        // usual hand-made folders, and on Windows Visual Studio's (source/repos) and GitHub
        // Desktop's (Documents/GitHub, which Windows doesn't guard).
        let mut roots = vec!["", "code", "Code", "dev", "src", "projects", "Projects", "repos", "git", "GitHub", "Developer", "workspace"];
        if cfg!(windows) {
            roots.extend(["source/repos", "Documents/GitHub", "Documents/code", "OneDrive/Documents/GitHub"]);
        }
        let mut seen = std::collections::HashSet::new();
        let visit = |dir: &Path, index: &mut HashMap<String, String>| {
            let Some(config) = git_config(dir) else { return false };
            for repo in github_remotes(&config) {
                index.entry(repo).or_insert_with(|| dir.to_string_lossy().into_owned());
            }
            true
        };
        for root in roots {
            let base = if root.is_empty() { home.clone() } else { home.join(root) };
            let Ok(entries) = std::fs::read_dir(&base) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let path = entry.path();
                if name.starts_with('.') || SKIP.contains(&name.as_str()) || !path.is_dir() || !seen.insert(path.clone()) {
                    continue;
                }
                if visit(&path, &mut index) {
                    continue;
                }
                // One level further: an org or group folder of checkouts.
                if let Ok(inner) = std::fs::read_dir(&path) {
                    for sub in inner.flatten() {
                        let sub_name = sub.file_name().to_string_lossy().into_owned();
                        let sub_path = sub.path();
                        if !sub_name.starts_with('.') && sub_name != "node_modules" && sub_path.is_dir() && seen.insert(sub_path.clone()) {
                            visit(&sub_path, &mut index);
                        }
                    }
                }
            }
        }
    }
    *cached = Some((Instant::now(), index.clone()));
    index
}

/// A checkout's git config. `.git` is usually a folder; in a worktree or submodule it's a file
/// pointing at the real git folder ("gitdir: …"), whose config (or, for a worktree, its main
/// repository's) holds the remotes.
fn git_config(dir: &Path) -> Option<String> {
    let dot_git = dir.join(".git");
    if dot_git.is_dir() {
        return std::fs::read_to_string(dot_git.join("config")).ok();
    }
    let pointer = std::fs::read_to_string(&dot_git).ok()?;
    let target = pointer.trim().strip_prefix("gitdir:")?.trim();
    let gitdir = if Path::new(target).is_absolute() { PathBuf::from(target) } else { dir.join(target) };
    std::fs::read_to_string(gitdir.join("config"))
        .ok()
        .or_else(|| std::fs::read_to_string(gitdir.join("commondir")).ok().and_then(|c| std::fs::read_to_string(gitdir.join(c.trim()).join("config")).ok()))
}

/// "owner/name" (lowercase) of a GitHub remote URL, in https or ssh form.
fn github_repo(url: &str) -> Option<String> {
    let rest = url.split_once("github.com").map(|(_, r)| r)?;
    let path = rest.trim_start_matches([':', '/'].as_ref()).trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    (!owner.is_empty() && !name.is_empty()).then(|| format!("{}/{}", owner, name).to_lowercase())
}

/// Every GitHub repo a git config's remotes point at, origin first: a fork's checkout (origin the
/// fork, upstream the original) counts as a checkout of both.
fn github_remotes(config: &str) -> Vec<String> {
    let mut origin = Vec::new();
    let mut others = Vec::new();
    let mut section = "";
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            section = line;
        } else if section.starts_with("[remote ") {
            if let Some(url) = line.strip_prefix("url").map(|r| r.trim_start_matches([' ', '='].as_ref()).trim()) {
                if let Some(repo) = github_repo(url) {
                    if section == r#"[remote "origin"]"# { origin.push(repo) } else { others.push(repo) }
                }
            }
        }
    }
    origin.extend(others);
    origin
}

/// "owner/name" (lowercase) of a git config's origin remote on GitHub, if it has one.
#[cfg(test)]
fn origin_repo(config: &str) -> Option<String> {
    let mut section = "";
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            section = line;
        } else if section == r#"[remote "origin"]"# {
            if let Some(url) = line.strip_prefix("url").map(|r| r.trim_start_matches([' ', '='].as_ref()).trim()) {
                return github_repo(url);
            }
        }
    }
    None
}

/// The user's own checkouts of these GitHub repos, where they have one: (repo as given, folder). A
/// bare name ("payments-api", no owner) finds the checkout of the one repo with that name, if only
/// one has it.
#[tauri::command]
async fn find_checkouts(repos: Vec<String>) -> Vec<(String, String)> {
    let index = tauri::async_runtime::spawn_blocking(checkout_index).await.unwrap_or_default();
    repos
        .into_iter()
        .filter_map(|r| {
            let key = r.to_lowercase();
            if key.contains('/') {
                return index.get(&key).map(|dir| (r, dir.clone()));
            }
            let suffix = format!("/{key}");
            let mut named = index.iter().filter(|(repo, _)| repo.ends_with(&suffix));
            match (named.next(), named.next()) {
                (Some((_, dir)), None) => Some((r, dir.clone())),
                _ => None,
            }
        })
        .collect()
}

/// Home folders macOS guards. Code there is never looked for: even checking whether a path exists
/// inside one makes macOS ask the user to let the app in.
const GUARDED: &[&str] = &["Desktop", "Documents", "Downloads", "Library", "Pictures", "Music", "Movies", "Public"];

/// The git checkout a path is in: the nearest folder above it (or the path itself) with a .git,
/// below the home folder. None for a path in one of the folders macOS guards (decided from the path
/// alone, before touching the disk), or one that isn't in a checkout.
#[tauri::command]
fn checkout_root(path: String) -> Option<String> {
    checkout_root_in(&home_dir()?, Path::new(&path)).map(|dir| dir.to_string_lossy().into_owned())
}

fn checkout_root_in(home: &Path, path: &Path) -> Option<PathBuf> {
    let rest = path.strip_prefix(home).ok()?;
    let first = rest.components().next()?.as_os_str().to_string_lossy().into_owned();
    if GUARDED.contains(&first.as_str()) || first.starts_with('.') {
        return None;
    }
    path.ancestors()
        .take_while(|dir| *dir != home && dir.starts_with(home))
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)
}

#[cfg(test)]
mod checkout_root_tests {
    use super::*;

    #[test]
    fn finds_the_checkout_a_path_is_in_but_never_looks_in_guarded_folders() {
        let home = std::env::temp_dir().join(format!("orb-checkouts-{}", std::process::id()));
        let repo = home.join("storefront-ui");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("apps/web/src")).unwrap();
        std::fs::create_dir_all(home.join("Documents/code/.git")).unwrap();
        std::fs::create_dir_all(home.join("notes")).unwrap();
        assert_eq!(checkout_root_in(&home, &repo.join("apps/web/src")), Some(repo.clone()));
        assert_eq!(checkout_root_in(&home, &repo.join(".git/HEAD")), Some(repo.clone()));
        // A checkout in a guarded folder is turned down from the path alone.
        assert_eq!(checkout_root_in(&home, &home.join("Documents/code/src")), None);
        // Not in a checkout, the home folder itself, or outside it.
        assert_eq!(checkout_root_in(&home, &home.join("notes")), None);
        assert_eq!(checkout_root_in(&home, &home), None);
        assert_eq!(checkout_root_in(&home, Path::new("/usr/share")), None);
        let _ = std::fs::remove_dir_all(&home);
    }
}

/// The folders that exist, of the ones given (project repos the user mapped may have moved).
#[tauri::command]
fn existing_dirs(paths: Vec<String>) -> Vec<String> {
    let home = home_dir();
    paths
        .into_iter()
        .filter_map(|p| {
            let expanded = match (p.strip_prefix("~/"), &home) {
                (Some(rest), Some(h)) => h.join(rest),
                _ => PathBuf::from(&p),
            };
            expanded.is_dir().then(|| expanded.to_string_lossy().into_owned())
        })
        .collect()
}

/// Opens a terminal window running one of setup's own steps, so onboarding can walk someone through
/// installing Claude Code or signing in without typing commands. Only these fixed steps run: the
/// frontend names one, it never supplies a command.
#[tauri::command]
fn open_setup_terminal(step: String) -> Result<(), String> {
    let script = match step.as_str() {
        // Claude's official installer. On Windows it puts claude.exe in .local\bin but leaves that
        // folder off PATH (it says so, and asks the person to add it), so `claude` isn't found in a
        // new PowerShell window. Do what it asks: add the folder to the user's PATH if it's missing,
        // say so, and to this window's too.
        "install" if cfg!(windows) => [
            "irm https://claude.ai/install.ps1 | iex",
            "$bin = Join-Path $env:USERPROFILE '.local\\bin'",
            "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
            "if ((Test-Path (Join-Path $bin 'claude.exe')) -and (($userPath -split ';') -notcontains $bin)) { [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $bin).TrimStart(';')), 'User'); Write-Host ('Added ' + $bin + ' to your PATH, so claude works in new PowerShell windows.') }",
            "$env:Path += ';' + $bin",
        ]
        .join("; "),
        "install" => "curl -fsSL https://claude.ai/install.sh | bash".to_string(),
        // Signing in with a Claude subscription (not an API key); it opens the browser to approve.
        "login" => login_command(),
        _ => return Err(format!("Unknown setup step {step}")),
    };
    // The step goes in a .command file that Terminal opens and runs. Opening a file needs no
    // permission, where scripting Terminal (osascript) needs Automation access that macOS asks for
    // and the person may decline, which the app couldn't see.
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = std::env::temp_dir().join(format!("demian-{step}.command"));
        std::fs::write(&file, format!("#!/bin/zsh -l\nclear\n{script}\n")).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        let out = Command::new("open").args(["-a", "Terminal"]).arg(&file).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/c", "start", "powershell", "-NoExit", "-Command", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = script;
    Ok(())
}

/// A path quoted for the shell the setup steps run in: PowerShell on Windows (in single quotes, a
/// quote doubled), zsh elsewhere (in single quotes, a quote closed, escaped and reopened).
fn shell_quote(text: &str, windows: bool) -> String {
    if windows {
        format!("'{}'", text.replace('\'', "''"))
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

/// How to start a program from the setup shell, by its full path (and, for claude installed with
/// npm on Windows, node and its script). PowerShell runs a quoted path with the call operator.
fn shell_invocation(path: &str, leading_args: &[String], windows: bool) -> String {
    let parts: Vec<String> = std::iter::once(path).chain(leading_args.iter().map(String::as_str)).map(|p| shell_quote(p, windows)).collect();
    if windows { format!("& {}", parts.join(" ")) } else { parts.join(" ") }
}

/// The command that signs Claude Code in, by the path Demian found it at, so it works even where
/// its folder isn't on PATH (a fresh Windows install). Plain `claude …` when it isn't installed.
fn login_command() -> String {
    match resolve("claude", &search_path()) {
        Some(p) => format!("{} auth login --claudeai", shell_invocation(&p.path.to_string_lossy(), &p.leading_args, cfg!(windows))),
        None => "claude auth login --claudeai".to_string(),
    }
}

/// The sign-in command to show for pasting into a terminal (see login_command).
#[tauri::command]
fn setup_login_command() -> String {
    login_command()
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "task cards",
            sql: include_str!("../migrations/002_task_cards.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "task assessments",
            sql: include_str!("../migrations/003_task_assessments.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "task status and today",
            sql: include_str!("../migrations/004_task_status.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "reply drafts",
            sql: include_str!("../migrations/005_reply_drafts.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "task registry and per-row task data",
            sql: include_str!("../migrations/006_task_registry.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "projects as entities with channels and a profile",
            sql: include_str!("../migrations/007_project_entity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "feedback log and distilled lessons",
            sql: include_str!("../migrations/008_feedback.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "user-owned project focus and profile history",
            sql: include_str!("../migrations/009_project_focus.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "project context as entries",
            sql: include_str!("../migrations/010_project_context.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "watched topics",
            sql: include_str!("../migrations/011_watched_topics.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "watched topic project",
            sql: include_str!("../migrations/012_watched_topic_project.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "watched topic history",
            sql: include_str!("../migrations/013_watched_topic_history.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

/// The identifier the app had before it was shared; its data folders move to the current one.
#[cfg(target_os = "macos")]
const OLD_IDENTIFIER: &str = "com.jcallahan.dayplanner";
#[cfg(target_os = "macos")]
const IDENTIFIER: &str = "com.orb.app";

/// Only macOS installs ever had the old identifier.
#[cfg(not(target_os = "macos"))]
fn migrate_old_identifier() {}

/// Moves the old identifier's folders (database, backups, web storage, caches) to the current
/// identifier's, once, before anything opens them. A folder that already exists is left alone.
#[cfg(target_os = "macos")]
fn migrate_old_identifier() {
    let Ok(home) = std::env::var("HOME") else { return };
    let library = PathBuf::from(home).join("Library");
    for dir in ["Application Support", "WebKit", "Caches"] {
        let old = library.join(dir).join(OLD_IDENTIFIER);
        let new = library.join(dir).join(IDENTIFIER);
        if old.exists() && !new.exists() {
            let _ = std::fs::rename(&old, &new);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate_old_identifier();
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_notification::init());
    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:dayplanner.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            run_cli,
            run_cli_stream,
            open_setup_terminal,
            mirror_repo,
            existing_dirs,
            find_checkouts,
            checkout_root,
            sessions::find_session,
            sessions::read_session_progress,
            sessions::list_sessions,
            listen::start_listening,
            listen::stop_listening,
            media::now_playing,
            media::media_control,
            media::open_player,
            cancel_run,
            cancel_all_runs,
            setup_login_command
        ])
        .manage(listen::Listening::default())
        .manage(runs::Runs::default())
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Demian", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh all", true, None::<&str>)?;
            let onboarding = MenuItem::with_id(app, "onboarding", "Replay onboarding", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &onboarding, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Demian")
                .menu(&menu)
                // On macOS a menu-bar icon opens its menu; on Windows a left click on a tray icon
                // opens the app, and the menu is on right click.
                .show_menu_on_left_click(cfg!(not(windows)))
                .on_tray_icon_event(|tray, event| {
                    #[cfg(windows)]
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                    #[cfg(not(windows))]
                    let _ = (tray, event);
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "refresh" => {
                        show_main(app);
                        let _ = app.emit("tray-refresh-all", ());
                    }
                    "onboarding" => {
                        show_main(app);
                        let _ = app.emit("tray-onboarding", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                hide_window_buttons(&window);
            }

            // System prompts left by runs the app didn't outlive (a crash, a forced quit): no run is
            // going yet, so any in the work folder are stale.
            if let Ok(dir) = work_dir(app.handle(), None) {
                for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with("system-prompt-") && name.ends_with(".txt") {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }

            // Wake the frontend's scheduler once a minute, even while the window is hidden.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(60));
                let _ = handle.emit("scheduler-tick", ());
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it; the app keeps running in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
                // Windows users expect closing to quit, so say once that it's still running.
                #[cfg(windows)]
                tell_once_still_running(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Demian");

    app.run(|_app, _event| {
        // Quitting ends every run with it, and whatever each one started, so nothing keeps working
        // (or spending) after the app is gone.
        if let RunEvent::Exit = _event {
            _app.state::<runs::Runs>().kill_all();
        }
        // Clicking the Dock icon while the window is hidden brings it back (macOS only).
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = _event {
            show_main(_app);
        }
    });
}

/// Hides macOS's close, minimize and zoom buttons: the app draws its own, gray until hovered.
#[cfg(target_os = "macos")]
fn hide_window_buttons(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    let Ok(ptr) = window.ns_window() else { return };
    // Safety: Tauri hands back the window's live NSWindow, and setup runs on the main thread.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    for kind in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
        if let Some(button) = ns_window.standardWindowButton(kind) {
            button.setHidden(true);
        }
    }
}

#[cfg(test)]
mod checkout_tests {
    use super::origin_repo;

    #[test]
    fn reads_the_origin_repo_in_https_and_ssh_form() {
        let https = "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://github.com/Acme-Corp/billing-dashboard.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n";
        assert_eq!(origin_repo(https).as_deref(), Some("acme-corp/billing-dashboard"));
        let ssh = "[remote \"upstream\"]\n\turl = git@github.com:someone/else.git\n[remote \"origin\"]\n\turl = git@github.com:Acme-Corp/editor-plugin\n";
        assert_eq!(origin_repo(ssh).as_deref(), Some("acme-corp/editor-plugin"));
        assert_eq!(origin_repo("[remote \"origin\"]\n\turl = https://gitlab.com/a/b.git\n"), None);
    }

    #[test]
    fn counts_a_fork_as_a_checkout_of_the_original_too() {
        let fork = "[remote \"origin\"]\n\turl = https://github.com/someone/editor-plugin.git\n[remote \"upstream\"]\n\turl = https://github.com/Acme-Corp/editor-plugin.git\n";
        assert_eq!(super::github_remotes(fork), vec!["someone/editor-plugin", "acme-corp/editor-plugin"]);
    }

    #[test]
    fn follows_a_worktree_to_its_repository() {
        let root = std::env::temp_dir().join(format!("orb-worktree-{}", std::process::id()));
        let main_git = root.join("main").join(".git");
        let wt_git = main_git.join("worktrees").join("wt");
        std::fs::create_dir_all(&wt_git).unwrap();
        std::fs::write(main_git.join("config"), "[remote \"origin\"]\n\turl = git@github.com:Acme-Corp/web-ui.git\n").unwrap();
        std::fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        let wt = root.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();
        let config = super::git_config(&wt).unwrap();
        assert_eq!(super::github_remotes(&config), vec!["acme-corp/web-ui"]);
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn pipes_a_long_multiline_prompt_on_stdin_and_cleans_up_the_system_prompt_file() {
        let dir = std::env::temp_dir().join(format!("demian-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let prompt = format!("line one\n100% & ^ \"quoted\"\n{}", "x".repeat(200_000));
        let mut args: Vec<String> = vec![];
        let guard = with_system_prompt(&dir, &mut args, Some("be brief\nplease".into())).unwrap();
        assert_eq!(args[0], "--append-system-prompt-file");
        let file = PathBuf::from(&args[1]);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "be brief\nplease");

        let cat = Program { path: PathBuf::from("/bin/cat"), leading_args: vec![] };
        let mut child = command(&cat, &[], &dir, &search_path(), true).stdout(Stdio::piped()).spawn().unwrap();
        feed_stdin(&mut child, Some(prompt.clone()));
        let out = child.wait_with_output().unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), prompt);

        drop(guard);
        assert!(!file.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod setup_tests {
    use super::{shell_invocation, shell_quote};

    #[test]
    fn quotes_a_path_with_an_apostrophe_for_each_shell() {
        assert_eq!(shell_quote(r"C:\Users\O'Brien\.local\bin\claude.exe", true), r"'C:\Users\O''Brien\.local\bin\claude.exe'");
        assert_eq!(shell_quote("/Users/o'brien/.local/bin/claude", false), r"'/Users/o'\''brien/.local/bin/claude'");
    }

    #[test]
    fn signs_in_by_full_path_with_powershells_call_operator() {
        assert_eq!(shell_invocation(r"C:\Users\tom\.local\bin\claude.exe", &[], true), r"& 'C:\Users\tom\.local\bin\claude.exe'");
        assert_eq!(shell_invocation("/Users/tom/.local/bin/claude", &[], false), "'/Users/tom/.local/bin/claude'");
    }

    #[test]
    fn runs_an_npm_installed_claude_through_node_and_its_script() {
        let script = r"C:\Users\tom\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js".to_string();
        assert_eq!(
            shell_invocation(r"C:\Program Files\nodejs\node.exe", &[script], true),
            r"& 'C:\Program Files\nodejs\node.exe' 'C:\Users\tom\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js'"
        );
    }
}
