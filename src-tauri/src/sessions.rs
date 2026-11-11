//! Read-only access to Claude Code session transcripts, so a task can follow
//! the session Orb opened for it. Only reads under ~/.claude/projects.

use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// How much of a transcript to search for the task marker: it's in the first message.
const MARKER_SCAN_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    pub path: String,
    pub session_id: String,
    pub modified_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProgress {
    /// Lines Claude wrote that start with "[orb]", oldest first.
    pub lines: Vec<String>,
    /// Blocks Claude handed to Orb (messages to send, revised plans), oldest first.
    pub sends: Vec<SessionSend>,
    /// The conversation as typed: the user's messages and Claude's text, each turn of Claude's text
    /// blocks joined into one message. Tool calls and results are left out.
    pub messages: Vec<ChatMessage>,
    /// Paths Claude's file tools were refused because they're outside the session's folders
    /// (Claude Code's blockReadsOutsideWorkingDirectories), oldest first.
    pub blocked: Vec<String>,
    pub modified_ms: u64,
}

/// The setting Claude Code names when it refuses a read outside the session's folders.
const BLOCKED_READ: &str = "blockReadsOutsideWorkingDirectories";

#[derive(Serialize)]
pub struct ChatMessage {
    /// "user" or "assistant".
    pub role: &'static str,
    pub text: String,
}

/// A block handed to Orb: a message to send ("[orb] send …") or a revised plan ("[orb] plan"), and
/// its text up to "[orb] end".
#[derive(Serialize, Debug, PartialEq)]
pub struct SessionSend {
    pub header: String,
    pub body: String,
}

fn projects_dir() -> Result<PathBuf, String> {
    let home = crate::home_dir().ok_or_else(|| "Couldn't find the home folder".to_string())?;
    Ok(home.join(".claude").join("projects"))
}

fn modified_ms(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// True when one of the transcript's user messages contains `marker`.
fn has_marker(path: &Path, marker: &str) -> bool {
    let Ok(file) = File::open(path) else { return false };
    let mut head = String::new();
    if file.take(MARKER_SCAN_BYTES).read_to_string(&mut head).is_err() {
        // A multi-byte character cut at the limit; read lossily instead.
        let Ok(bytes) = std::fs::read(path) else { return false };
        let end = bytes.len().min(MARKER_SCAN_BYTES as usize);
        head = String::from_utf8_lossy(&bytes[..end]).into_owned();
    }
    head.lines().any(|line| line.contains("\"type\":\"user\"") && line.contains(marker))
}

/// The newest session transcript, changed at or after `since_ms`, whose
/// opening message carries `marker`.
#[tauri::command]
pub async fn find_session(marker: String, since_ms: u64) -> Result<Option<SessionFile>, String> {
    let root = projects_dir()?;
    let Ok(projects) = std::fs::read_dir(&root) else { return Ok(None) };
    let mut best: Option<SessionFile> = None;
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let modified = modified_ms(&path);
            if modified < since_ms || best.as_ref().is_some_and(|b| b.modified_ms >= modified) {
                continue;
            }
            if has_marker(&path, &marker) {
                let session_id = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
                best = Some(SessionFile { path: path.to_string_lossy().into_owned(), session_id, modified_ms: modified });
            }
        }
    }
    Ok(best)
}

/// How much of each end of a transcript to read when listing it: the opening message and folder are
/// at the start, and the latest title near the end.
const LIST_SCAN_BYTES: u64 = 256 * 1024;

/// A recent Claude Code session, for connecting one you started yourself to a task.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: String,
    pub session_id: String,
    pub modified_ms: u64,
    /// The folder it runs in, which `claude --resume` needs.
    pub cwd: Option<String>,
    /// Its title in Claude, or the start of its first message.
    pub title: String,
    /// The first thing you asked in it.
    pub prompt: String,
    /// The latest thing you asked, and Claude's latest text, for telling whether it's finished.
    pub last_ask: Option<String>,
    pub last_reply: Option<String>,
}

/// `len` bytes of `file` from `start`, as text even when a character is cut at either end.
fn read_span(file: &mut File, start: u64, len: u64) -> String {
    use std::io::{Seek, SeekFrom};
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err() || file.take(len).read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The text of a message you typed, as written: a plain string, or its first text block. Tool
/// results, commands and system notes (which start with "<"), Claude Code's own notes (isMeta, like
/// the caveat before a command's output) and the summary a compacted session starts again from
/// aren't typed messages.
fn typed_text(entry: &serde_json::Value) -> Option<String> {
    let flag = |key: &str| entry.get(key).and_then(|m| m.as_bool()) == Some(true);
    if flag("isMeta") || flag("isCompactSummary") {
        return None;
    }
    let content = entry.pointer("/message/content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .find(|t| !t.trim_start().starts_with('<'))?
            .to_string(),
        _ => return None,
    };
    let trimmed = text.trim();
    (!trimmed.is_empty() && !trimmed.starts_with('<')).then_some(text)
}

/// A project folder's name under ~/.claude/projects for a working directory: Claude Code turns
/// every character but letters and digits into "-".
fn project_folder_name(dir: &Path) -> String {
    dir.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn summarize(path: &Path, folder: &str) -> Option<SessionSummary> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let head = read_span(&mut file, 0, LIST_SCAN_BYTES);
    // The end, from its first whole line.
    let tail = if len > LIST_SCAN_BYTES {
        let text = read_span(&mut file, len - LIST_SCAN_BYTES, LIST_SCAN_BYTES);
        text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default()
    } else {
        String::new()
    };
    let mut prompt = None;
    let mut cwds: Vec<String> = Vec::new();
    let mut title = None;
    let mut summary = None;
    let mut last_ask = None;
    let mut last_reply: Option<String> = None;
    for line in head.lines().chain(tail.lines()) {
        // Claude's latest text. A reply in several messages reads as the last of them.
        if line.contains("\"type\":\"assistant\"") {
            let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let text: Vec<&str> = entry
                .pointer("/message/content")
                .and_then(|c| c.as_array())
                .into_iter()
                .flatten()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .filter(|t| !t.trim().is_empty())
                .collect();
            if !text.is_empty() {
                last_reply = Some(text.join("\n\n"));
            }
            continue;
        }
        if line.contains("\"type\":\"user\"") && !line.contains("\"tool_result\"") {
            if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(text) = typed_text(&entry) {
                    last_ask = Some(text.trim().to_string());
                }
            }
        }
        let user = prompt.is_none() && line.contains("\"type\":\"user\"");
        let named = line.contains("\"type\":\"custom-title\"") || line.contains("\"type\":\"summary\"");
        let moved = line.contains("\"type\":\"relocated\"");
        let has_cwd = cwds.is_empty() && line.contains("\"cwd\":");
        if !user && !named && !moved && !has_cwd {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if user {
            prompt = typed_text(&entry).map(|t| t.trim().to_string());
        }
        for key in ["relocatedCwd", "cwd"] {
            if let Some(dir) = entry.get(key).and_then(|c| c.as_str()) {
                if !cwds.iter().any(|c| c == dir) {
                    cwds.push(dir.to_string());
                }
            }
        }
        if let Some(t) = entry.get("customTitle").and_then(|t| t.as_str()) {
            title = Some(t.to_string());
        }
        if entry.get("type").and_then(|t| t.as_str()) == Some("summary") {
            summary = entry.get("summary").and_then(|t| t.as_str()).map(str::to_string);
        }
    }
    let prompt = prompt.unwrap_or_default();
    let title = title.or(summary).filter(|t| !t.trim().is_empty()).unwrap_or_else(|| {
        let first = prompt.lines().next().unwrap_or_default();
        if first.chars().count() > 80 { format!("{}…", first.chars().take(79).collect::<String>()) } else { first.to_string() }
    });
    if title.is_empty() {
        return None;
    }
    // The folder whose transcripts this is in; a session that moved names its new folder.
    let cwd = cwds.iter().find(|c| project_folder_name(Path::new(c)) == folder).or(cwds.first()).cloned();
    let session_id = path.file_stem()?.to_str()?.to_string();
    Some(SessionSummary { path: path.to_string_lossy().into_owned(), session_id, modified_ms: modified_ms(path), cwd, title, prompt, last_ask, last_reply })
}

/// A scratch folder (scripted, throwaway runs), whose sessions can't be carried on once it's cleared.
fn in_temp_folder(dir: &str) -> bool {
    ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"].iter().any(|t| dir.starts_with(t))
}

/// Whether a session in `dir` can be carried on: Claude Code resumes it only from that folder, so
/// it has to be there still (a worktree that's been removed isn't), and not a scratch folder.
fn resumable_from(dir: &str) -> bool {
    !in_temp_folder(dir) && Path::new(dir).is_dir()
}

/// Sessions changed at or after `since_ms`, newest first, at most `limit`. Leaves out the project
/// folder named `skip_folder` (Orb's own runs), sessions Orb opened for a task, which are linked
/// already, and sessions whose folder `usable` turns down. `skip_ids` leaves out sessions by id
/// unless they've changed since the time given (ms), before reading them.
fn recent_sessions(root: &Path, skip_folder: &str, skip_ids: &HashMap<String, u64>, since_ms: u64, limit: usize, usable: &dyn Fn(&str) -> bool) -> Vec<SessionSummary> {
    let mut files: Vec<(u64, PathBuf, String)> = Vec::new();
    for project in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let folder = project.file_name().to_string_lossy().into_owned();
        if folder == skip_folder {
            continue;
        }
        for file in std::fs::read_dir(project.path()).into_iter().flatten().flatten() {
            let path = file.path();
            let modified = modified_ms(&path);
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") || modified < since_ms {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            if skip_ids.get(stem).is_some_and(|&until| modified <= until) {
                continue;
            }
            files.push((modified, path, folder.clone()));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files
        .iter()
        .filter_map(|(_, path, folder)| summarize(path, folder))
        .filter(|s| !s.prompt.contains("Orb task:") && s.cwd.as_deref().is_some_and(usable))
        .take(limit)
        .collect()
}

/// Your recent Claude Code sessions that could be carried on, newest first. `skip` leaves sessions
/// out by id, unless they've changed since the time given (ms).
#[tauri::command]
pub async fn list_sessions(app: tauri::AppHandle, since_ms: u64, limit: usize, skip: Option<HashMap<String, u64>>) -> Result<Vec<SessionSummary>, String> {
    let root = projects_dir()?;
    let skip_folder = crate::work_dir(&app, None).map(|d| project_folder_name(&d)).unwrap_or_default();
    let skip = skip.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || recent_sessions(&root, &skip_folder, &skip, since_ms, limit, &resumable_from)).await.map_err(|e| e.to_string())
}

/// The "[orb] …" progress lines Claude has written in a session so far.
#[tauri::command]
pub async fn read_session_progress(path: String) -> Result<SessionProgress, String> {
    let root = projects_dir()?.canonicalize().map_err(|e| e.to_string())?;
    let file_path = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
    if !file_path.starts_with(&root) || file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("Not a Claude Code session transcript".into());
    }
    let reader = BufReader::new(File::open(&file_path).map_err(|e| e.to_string())?);
    let mut lines = Vec::new();
    let mut sends = Vec::new();
    let mut messages: Vec<ChatMessage> = Vec::new();
    let mut blocked: Vec<String> = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let is_user = line.contains("\"type\":\"user\"");
        if !is_user && !line.contains("\"type\":\"assistant\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        // A message the user typed (not a tool result, which also comes as "user", nor a command or
        // note Claude Code adds in a session you run yourself; see typed_text).
        if is_user {
            if let Some(text) = typed_text(&entry) {
                messages.push(ChatMessage { role: "user", text });
            }
            // A file tool refused outside the session's folders: "<path> is outside …".
            if line.contains(BLOCKED_READ) {
                for block in entry.pointer("/message/content").and_then(|c| c.as_array()).into_iter().flatten() {
                    let refused = block.get("type").and_then(|t| t.as_str()) == Some("tool_result") && block.get("is_error").and_then(|e| e.as_bool()) == Some(true);
                    let text = match block.get("content") {
                        Some(serde_json::Value::String(s)) => s.clone(),
                        Some(serde_json::Value::Array(parts)) => parts.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
                        _ => String::new(),
                    };
                    if refused && text.contains(BLOCKED_READ) {
                        if let Some((path, _)) = text.trim_start_matches("Error: ").split_once(" is outside ") {
                            if !blocked.iter().any(|b| b == path) {
                                blocked.push(path.to_string());
                            }
                        }
                    }
                }
            }
            continue;
        }
        let Some(content) = entry.pointer("/message/content").and_then(|c| c.as_array()) else { continue };
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) != Some("text") {
                continue;
            }
            let text = block.get("text").and_then(|t| t.as_str()).unwrap_or_default();
            // Claude's text between two of the user's messages reads as one message.
            match messages.last_mut() {
                Some(last) if last.role == "assistant" => {
                    last.text.push_str("\n\n");
                    last.text.push_str(text);
                }
                _ => messages.push(ChatMessage { role: "assistant", text: text.to_string() }),
            }
            // Only Claude's own messages report progress; the opening prompt quotes the format too.
            if !text.contains("[orb]") {
                continue;
            }
            // A hand-off runs from its "[orb] send" line to "[orb] end"; its body keeps its lines as written.
            let mut open: Option<(String, Vec<&str>)> = None;
            for text_line in text.lines() {
                let trimmed = text_line.trim().trim_matches('`').trim_start_matches("- ").trim();
                if let Some((header, body)) = open.as_mut() {
                    if trimmed.eq_ignore_ascii_case("[orb] end") {
                        sends.push(SessionSend { header: header.clone(), body: body.join("\n") });
                        open = None;
                    } else {
                        body.push(text_line);
                    }
                    continue;
                }
                if trimmed.starts_with("[orb]") {
                    lines.push(trimmed.to_string());
                    // Hand-offs ("[orb] send …"), plan updates ("[orb] plan") and proposed changes ("[orb] action")
                    // carry a block of text up to "[orb] end".
                    let lower = trimmed.to_ascii_lowercase();
                    if lower.starts_with("[orb] send") || lower.starts_with("[orb] plan") || lower.starts_with("[orb] action") || lower.starts_with("[orb] doc") || lower.starts_with("[orb] event") || lower.starts_with("[orb] ticket") {
                        open = Some((trimmed.to_string(), Vec::new()));
                    }
                }
            }
        }
    }
    Ok(SessionProgress { lines, sends, messages, blocked, modified_ms: modified_ms(&file_path) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_marked_session_and_reads_only_claudes_reports() {
        let home = std::env::temp_dir().join(format!("orb-sessions-{}", std::process::id()));
        let project = home.join(".claude/projects/-Users-me-repo");
        std::fs::create_dir_all(&project).unwrap();
        let user = r#"{"type":"user","message":{"role":"user","content":"Orb task: t-42\n\nWrite `[orb] step N done` when finished."}}"#;
        let reply = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading it now.\n[orb] step 1 started\n`[orb] step 1 done`"}]}}"#;
        let waiting = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"[orb] step 2 waiting: need the export"}]}}"#;
        let send = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here it is.\n[orb] send step 3 to #tmp-x\nHeads up, the filter is live.\n• Use `publisherId=`\n[orb] end\n[orb] action\n{\"type\": \"add_note\", \"text\": \"Refunds is paused\"}\n[orb] end"}]}}"#;
        let refused = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"/Users/me/storefront-ui/src is outside /Users/me/work; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories."}]}}"#;
        // What Claude Code adds in a session you run yourself isn't a message of yours; one you type
        // with a note attached (its content as blocks) is.
        let noise = [
            r#"{"type":"user","isMeta":true,"message":{"content":"Caveat: The messages below were generated by the user while running local commands."}}"#,
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued from a previous conversation."}}"#,
        ]
        .join("\n");
        let typed = r#"{"type":"user","message":{"content":[{"type":"text","text":"<system-reminder>x</system-reminder>"},{"type":"text","text":"Send it to Sam"}]}}"#;
        std::fs::write(project.join("abc.jsonl"), format!("{user}\n{reply}\n{refused}\n{noise}\n{waiting}\n{typed}\n{send}\n")).unwrap();
        std::fs::write(project.join("other.jsonl"), r#"{"type":"user","message":{"content":"Orb task: t-7"}}"#).unwrap();
        // Where home_dir() looks first on this platform.
        std::env::set_var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }, &home);

        tauri::async_runtime::block_on(async {
            let found = find_session("Orb task: t-42".into(), 0).await.unwrap().expect("found");
            assert_eq!(found.session_id, "abc");
            let progress = read_session_progress(found.path).await.unwrap();
            assert_eq!(
                progress.lines,
                vec!["[orb] step 1 started", "[orb] step 1 done", "[orb] step 2 waiting: need the export", "[orb] send step 3 to #tmp-x", "[orb] action"]
            );
            assert_eq!(progress.messages[0].role, "user");
            assert_eq!(progress.messages[0].text, "Orb task: t-42\n\nWrite `[orb] step N done` when finished.");
            let typed: Vec<(&str, &str)> = progress.messages.iter().map(|m| (m.role, m.text.as_str())).filter(|(role, _)| *role == "user").collect();
            assert_eq!(typed, vec![("user", "Orb task: t-42\n\nWrite `[orb] step N done` when finished."), ("user", "Send it to Sam")]);
            assert_eq!(progress.messages.len(), 4);
            assert_eq!(progress.blocked, vec!["/Users/me/storefront-ui/src"]);
            assert!(progress.messages[1].text.starts_with("Reading it now."));
            assert_eq!(
                progress.sends,
                vec![
                    SessionSend {
                        header: "[orb] send step 3 to #tmp-x".into(),
                        body: "Heads up, the filter is live.\n• Use `publisherId=`".into()
                    },
                    SessionSend { header: "[orb] action".into(), body: r#"{"type": "add_note", "text": "Refunds is paused"}"#.into() },
                ]
            );
            assert!(find_session("Orb task: t-99".into(), 0).await.unwrap().is_none());
            // Paths outside the transcripts folder are refused.
            assert!(read_session_progress("/etc/hosts".into()).await.is_err());
        });
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn lists_recent_sessions_with_their_titles_and_folders() {
        let root = std::env::temp_dir().join(format!("orb-list-{}", std::process::id()));
        let repo = root.join("-Users-me-repo");
        let own = root.join("-Users-me-orb-work");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&own).unwrap();
        let meta = r#"{"type":"user","isMeta":true,"cwd":"/Users/me/repo","message":{"content":"<command-name>/clear</command-name>"}}"#;
        let asked = r#"{"type":"user","cwd":"/Users/me/repo","message":{"content":[{"type":"text","text":"<system-reminder>x</system-reminder>"},{"type":"text","text":"Fix the checkout filter\nIt drops publishers"}]}}"#;
        let named = r#"{"type":"custom-title","customTitle":"Checkout filter fix"}"#;
        let replied = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Found it."},{"type":"tool_use","id":"t"}]}}"#;
        let again = r#"{"type":"user","message":{"content":"Now open a PR"}}"#;
        let done = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Opened the PR."}]}}"#;
        std::fs::write(repo.join("a1.jsonl"), format!("{meta}\n{asked}\n{replied}\n{named}\n{again}\n{done}\n")).unwrap();
        std::fs::write(repo.join("b2.jsonl"), format!("{asked}\n")).unwrap();
        std::fs::write(repo.join("c3.jsonl"), r#"{"type":"user","cwd":"/Users/me/repo","message":{"content":"Orb task: t-1"}}"#).unwrap();
        std::fs::write(own.join("d4.jsonl"), r#"{"type":"user","message":{"content":"Summarize my inbox"}}"#).unwrap();
        std::fs::write(repo.join("e5.jsonl"), r#"{"type":"user","cwd":"/private/tmp/run","message":{"content":"Call the tool once"}}"#).unwrap();

        // A session whose folder is gone (a removed worktree) can't be carried on.
        std::fs::write(repo.join("f6.jsonl"), r#"{"type":"user","cwd":"/Users/me/gone","message":{"content":"Try the old branch"}}"#).unwrap();
        // Folders as the test has them: the repo is there, the worktree isn't.
        let usable = |dir: &str| !in_temp_folder(dir) && dir != "/Users/me/gone";
        let none = HashMap::new();

        let found = recent_sessions(&root, "-Users-me-orb-work", &none, 0, 10, &usable);
        let mut ids: Vec<&str> = found.iter().map(|s| s.session_id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["a1", "b2"]);
        let a1 = found.iter().find(|s| s.session_id == "a1").unwrap();
        assert_eq!(a1.title, "Checkout filter fix");
        assert_eq!(a1.prompt, "Fix the checkout filter\nIt drops publishers");
        assert_eq!(a1.cwd.as_deref(), Some("/Users/me/repo"));
        assert_eq!(a1.last_ask.as_deref(), Some("Now open a PR"));
        assert_eq!(a1.last_reply.as_deref(), Some("Opened the PR."));
        // Without a title, the start of the first message.
        assert_eq!(found.iter().find(|s| s.session_id == "b2").unwrap().title, "Fix the checkout filter");
        assert_eq!(recent_sessions(&root, "", &none, 0, 1, &usable).len(), 1);
        // Sessions left out by id, until they change after the time given.
        let a1_at = modified_ms(&repo.join("a1.jsonl"));
        let skip = HashMap::from([("a1".to_string(), a1_at), ("b2".to_string(), 0)]);
        let ids: Vec<String> = recent_sessions(&root, "-Users-me-orb-work", &skip, 0, 10, &usable).into_iter().map(|s| s.session_id).collect();
        assert_eq!(ids, vec!["b2"]);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
