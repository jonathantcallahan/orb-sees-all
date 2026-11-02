mod sessions;

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

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
    parts.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
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
        .stdin(if stdin { Stdio::piped() } else { Stdio::null() });
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

#[tauri::command]
async fn run_cli(
    app: AppHandle,
    program: String,
    mut args: Vec<String>,
    cwd: Option<String>,
    input: Option<CliInput>,
) -> Result<CliOutput, String> {
    if !ALLOWED_PROGRAMS.contains(&program.as_str()) {
        return Err(format!("{program} is not an allowed program"));
    }
    let path = search_path();
    let exe = resolve(&program, &path).ok_or_else(|| format!("{program} not found on PATH"))?;
    let dir = work_dir(&app, cwd)?;

    let input = input.unwrap_or_default();
    let _prompt_file = with_system_prompt(&dir, &mut args, input.append_system_prompt)?;
    let has_stdin = input.stdin.is_some();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = command(&exe, &args, &dir, &path, has_stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        feed_stdin(&mut child, input.stdin);
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        Ok(CliOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
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

/// Like run_cli, but emits each stdout line as a `cli-line` event while the
/// program runs, so the frontend can show progress.
#[tauri::command]
async fn run_cli_stream(
    app: AppHandle,
    stream_id: String,
    program: String,
    mut args: Vec<String>,
    cwd: Option<String>,
    input: Option<CliInput>,
) -> Result<CliOutput, String> {
    use std::io::{BufRead, BufReader, Read};

    if !ALLOWED_PROGRAMS.contains(&program.as_str()) {
        return Err(format!("{program} is not an allowed program"));
    }
    let path = search_path();
    let exe = resolve(&program, &path).ok_or_else(|| format!("{program} not found on PATH"))?;
    let dir = work_dir(&app, cwd)?;

    let input = input.unwrap_or_default();
    let prompt_file = with_system_prompt(&dir, &mut args, input.append_system_prompt)?;
    let has_stdin = input.stdin.is_some();
    tauri::async_runtime::spawn_blocking(move || {
        let _prompt_file = prompt_file;
        let mut child = command(&exe, &args, &dir, &path, has_stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        feed_stdin(&mut child, input.stdin);

        // Drain stderr on its own thread so a full pipe can't stall the program.
        let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
        let stderr_reader = std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stderr_pipe.read_to_string(&mut buf);
            buf
        });

        let mut stdout = String::new();
        for line in BufReader::new(child.stdout.take().expect("stdout is piped")).lines() {
            let line = line.map_err(|e| e.to_string())?;
            let _ = app.emit("cli-line", CliLine { stream_id: stream_id.clone(), line: line.clone() });
            stdout.push_str(&line);
            stdout.push('\n');
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        Ok(CliOutput {
            code: status.code().unwrap_or(-1),
            stdout,
            stderr: stderr_reader.join().unwrap_or_default(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
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

/// Opens a terminal window running one of setup's own steps, so onboarding can walk someone through
/// installing Claude Code or signing in without typing commands. Only these fixed steps run: the
/// frontend names one, it never supplies a command.
#[tauri::command]
fn open_setup_terminal(step: String) -> Result<(), String> {
    let path = search_path();
    let claude = resolve("claude", &path).map(|p| p.path.to_string_lossy().into_owned());
    let script = match step.as_str() {
        // Claude's official installer.
        "install" if cfg!(windows) => "irm https://claude.ai/install.ps1 | iex".to_string(),
        "install" => "curl -fsSL https://claude.ai/install.sh | bash".to_string(),
        // Signing in with a Claude subscription (not an API key); it opens the browser to approve.
        "login" => {
            let exe = claude.unwrap_or_else(|| "claude".into());
            if cfg!(windows) { format!("& '{exe}' auth login --claudeai") } else { format!("'{exe}' auth login --claudeai") }
        }
        _ => return Err(format!("Unknown setup step {step}")),
    };
    #[cfg(target_os = "macos")]
    {
        let run = format!("tell application \"Terminal\" to do script \"{}\"", script.replace('\\', "\\\\").replace('"', "\\\""));
        Command::new("osascript")
            .args(["-e", &run, "-e", "tell application \"Terminal\" to activate"])
            .spawn()
            .map_err(|e| e.to_string())?;
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
            sessions::find_session,
            sessions::read_session_progress
        ])
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
