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
const PASSTHROUGH_ENV: [&str; 8] = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "SSH_AUTH_SOCK"];

/// Apps launched from Finder don't inherit the login shell's PATH, so add the
/// usual install locations for claude, gh and git.
fn search_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts = vec![
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(":")
}

fn passthrough_env() -> Vec<(&'static str, String)> {
    PASSTHROUGH_ENV
        .iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| (*key, value)))
        .collect()
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

fn resolve(program: &str, path: &str) -> Option<PathBuf> {
    path.split(':')
        .map(|dir| PathBuf::from(dir).join(program))
        .find(|candidate| candidate.is_file())
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
        let output = Command::new(exe)
            .args(&args)
            .current_dir(dir)
            .env_clear()
            .envs(passthrough_env())
            .env("PATH", path)
            .stdin(Stdio::null())
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
        let mut child = Command::new(exe)
            .args(&args)
            .current_dir(dir)
            .env_clear()
            .envs(passthrough_env())
            .env("PATH", path)
            .stdin(Stdio::null())
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
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:dayplanner.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![run_cli, run_cli_stream])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Orb Sees All", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh all", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Orb Sees All")
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
        .expect("error while building Orb Sees All");

    app.run(|app, event| {
        if let RunEvent::Reopen { .. } = event {
            show_main(app);
        }
    });
}
