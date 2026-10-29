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
    // Run claude outside any repo so it doesn't pick up a project's CLAUDE.md.
    let dir = match cwd {
        Some(dir) => PathBuf::from(dir),
        None => {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("work");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            dir
        }
    };

    tauri::async_runtime::spawn_blocking(move || {
        let env = PASSTHROUGH_ENV
            .iter()
            .filter_map(|key| std::env::var(key).ok().map(|value| (*key, value)));
        let output = Command::new(exe)
            .args(&args)
            .current_dir(dir)
            .env_clear()
            .envs(env)
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
        .invoke_handler(tauri::generate_handler![run_cli])
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
