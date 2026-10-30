//! Read-only access to Claude Code session transcripts, so a task can follow
//! the session Orb opened for it. Only reads under ~/.claude/projects.

use serde::Serialize;
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
    pub modified_ms: u64,
}

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
    for line in reader.lines().map_while(Result::ok) {
        let is_user = line.contains("\"type\":\"user\"");
        if !is_user && !line.contains("\"type\":\"assistant\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        // A message the user typed (not a tool result, which also comes as "user").
        if is_user {
            if let Some(text) = entry.pointer("/message/content").and_then(|c| c.as_str()) {
                messages.push(ChatMessage { role: "user", text: text.to_string() });
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
                    // Hand-offs ("[orb] send …") and plan updates ("[orb] plan") carry a block of text up to "[orb] end".
                    let lower = trimmed.to_ascii_lowercase();
                    if lower.starts_with("[orb] send") || lower.starts_with("[orb] plan") {
                        open = Some((trimmed.to_string(), Vec::new()));
                    }
                }
            }
        }
    }
    Ok(SessionProgress { lines, sends, messages, modified_ms: modified_ms(&file_path) })
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
        let send = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here it is.\n[orb] send step 3 to #tmp-x\nHeads up, the filter is live.\n• Use `publisherId=`\n[orb] end"}]}}"#;
        std::fs::write(project.join("abc.jsonl"), format!("{user}\n{reply}\n{waiting}\n{send}\n")).unwrap();
        std::fs::write(project.join("other.jsonl"), r#"{"type":"user","message":{"content":"Orb task: t-7"}}"#).unwrap();
        std::env::set_var("HOME", &home);

        tauri::async_runtime::block_on(async {
            let found = find_session("Orb task: t-42".into(), 0).await.unwrap().expect("found");
            assert_eq!(found.session_id, "abc");
            let progress = read_session_progress(found.path).await.unwrap();
            assert_eq!(
                progress.lines,
                vec!["[orb] step 1 started", "[orb] step 1 done", "[orb] step 2 waiting: need the export", "[orb] send step 3 to #tmp-x"]
            );
            assert_eq!(progress.messages[0].role, "user");
            assert_eq!(progress.messages[0].text, "Orb task: t-42\n\nWrite `[orb] step N done` when finished.");
            assert_eq!(progress.messages.len(), 2);
            assert!(progress.messages[1].text.starts_with("Reading it now."));
            assert_eq!(
                progress.sends,
                vec![SessionSend {
                    header: "[orb] send step 3 to #tmp-x".into(),
                    body: "Heads up, the filter is live.\n• Use `publisherId=`".into()
                }]
            );
            assert!(find_session("Orb task: t-99".into(), 0).await.unwrap().is_none());
            // Paths outside the transcripts folder are refused.
            assert!(read_session_progress("/etc/hosts".into()).await.is_err());
        });
        std::fs::remove_dir_all(&home).unwrap();
    }
}
