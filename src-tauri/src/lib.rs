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

/// The user's home folder: HOME on macOS and Linux, USERPROFILE on Windows.
pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
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

fn passthrough_env() -> Vec<(&'static str, String)> {
    PASSTHROUGH_ENV
        .iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| (*key, value)))
        .collect()
}

/// A child process with only the passthrough environment, the search path, and (on Windows) no
/// console window flashing up.
fn command(exe: &PathBuf, args: &[String], dir: &PathBuf, path: &std::ffi::OsString) -> Command {
    let mut cmd = Command::new(exe);
    cmd.args(args).current_dir(dir).env_clear().envs(passthrough_env()).env("PATH", path).stdin(Stdio::null());
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

fn resolve(program: &str, path: &std::ffi::OsString) -> Option<PathBuf> {
    // Windows programs carry an extension; npm installs claude as a .cmd shim.
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd"].iter().map(|ext| format!("{program}.{ext}")).collect()
    } else {
        vec![program.to_string()]
    };
    std::env::split_paths(path).find_map(|dir| names.iter().map(|n| dir.join(n)).find(|candidate| candidate.is_file()))
}

#[tauri::command]
async fn run_cli(
    app: AppHandle,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<CliOutput, String> {
    if !ALLOWED_PROGRAMS.contains(&program.as_str()) {
        return Err(format!("{program} is not an allowed program"));
    }
    let path = search_path();
    let exe = resolve(&program, &path).ok_or_else(|| format!("{program} not found on PATH"))?;
    let dir = work_dir(&app, cwd)?;

    tauri::async_runtime::spawn_blocking(move || {
        let output = command(&exe, &args, &dir, &path)
            .output()
            .map_err(|e| e.to_string())?;
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
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<CliOutput, String> {
    use std::io::{BufRead, BufReader, Read};

    if !ALLOWED_PROGRAMS.contains(&program.as_str()) {
        return Err(format!("{program} is not an allowed program"));
    }
    let path = search_path();
    let exe = resolve(&program, &path).ok_or_else(|| format!("{program} not found on PATH"))?;
    let dir = work_dir(&app, cwd)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = command(&exe, &args, &dir, &path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;

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
    let app = tauri::Builder::default()
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
            sessions::find_session,
            sessions::read_session_progress
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Demian", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh all", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Demian")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "refresh" => {
                        show_main(app);
                        let _ = app.emit("tray-refresh-all", ());
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
