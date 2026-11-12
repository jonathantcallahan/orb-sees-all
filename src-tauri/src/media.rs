//! What's playing, and play/pause, next and previous for it.
//!
//! On macOS the song comes from the system's Now Playing (what Control Center shows: TIDAL, Spotify,
//! Music, a browser tab), read through MediaRemote. Since macOS 15.4 only Apple's own programs may
//! read it, so Demian asks osascript, which may, to run a short JavaScript that reads it (and sends
//! play/pause and skips to the same player). That isn't a public interface: if a macOS update closes
//! it, the read fails and Demian falls back to asking Spotify and Music themselves through their
//! AppleScript (macOS asks you once per player to let Demian control it; see
//! NSAppleEventsUsageDescription in Info.plist). Elsewhere, nothing is ever playing.

/// Reads Now Playing: prints the song as NowPlaying's JSON, nothing when there's no song, and fails
/// (so the players are asked instead) when MediaRemote won't answer. The position is where the song
/// is now: Now Playing gives it as of a moment, and how fast it's moving since.
#[cfg(target_os = "macos")]
const SYSTEM_READ: &str = r#"function run() {
  const nil = (o) => !o || (typeof o.isNil === "function" && o.isNil());
  $.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/MediaRemote.framework/").load;
  const R = $.NSClassFromString("MRNowPlayingRequest");
  if (nil(R)) throw new Error("No MRNowPlayingRequest");
  const item = R.localNowPlayingItem;
  if (nil(item) || nil(item.nowPlayingInfo)) return "";
  const info = item.nowPlayingInfo;
  const get = (k) => { const v = info.valueForKey("kMRMediaRemoteNowPlayingInfo" + k); return nil(v) ? null : ObjC.unwrap(v); };
  const title = get("Title");
  if (!title) return "";
  const rate = Number(get("PlaybackRate")) || 0;
  const duration = Number(get("Duration")) || 0;
  let position = Number(get("ElapsedTime")) || 0;
  const at = info.valueForKey("kMRMediaRemoteNowPlayingInfoTimestamp");
  if (!nil(at)) position += (Date.now() / 1000 - at.timeIntervalSince1970) * rate;
  if (duration > 0) position = Math.min(position, duration);
  const playing = R.localIsPlaying;
  const path = R.localNowPlayingPlayerPath;
  const client = nil(path) ? null : path.client;
  return JSON.stringify({
    app: nil(client) ? "" : ObjC.unwrap(client.displayName) || "",
    bundle: nil(client) ? "" : ObjC.unwrap(client.bundleIdentifier) || "",
    system: true,
    playing: playing === undefined ? rate > 0 : !!ObjC.unwrap(playing),
    title: String(title),
    artist: String(get("Artist") || ""),
    position: Math.max(0, position),
    duration,
  });
}"#;

/// What a button asks the player to do; anything else is turned away before it gets here.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum MediaAction {
    Playpause,
    Next,
    Previous,
}

#[cfg(target_os = "macos")]
impl MediaAction {
    /// Its MediaRemote command.
    fn command(self) -> u8 {
        match self {
            MediaAction::Playpause => 2,
            MediaAction::Next => 4,
            MediaAction::Previous => 5,
        }
    }

    /// Its AppleScript verb, for Spotify and Music.
    fn verb(self) -> &'static str {
        match self {
            MediaAction::Playpause => "playpause",
            MediaAction::Next => "next track",
            MediaAction::Previous => "previous track",
        }
    }
}

/// Sends MediaRemote command `command` to the Now Playing app. The command goes out after the call
/// returns, so the script waits a moment before it quits; quitting at once drops it most of the time.
#[cfg(target_os = "macos")]
fn system_send(command: u8) -> String {
    format!(
        r#"$.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/MediaRemote.framework/").load;
ObjC.bindFunction("MRMediaRemoteSendCommand", ["bool", ["int", "id"]]);
if (!$.MRMediaRemoteSendCommand({command}, $())) throw new Error("Now Playing didn't take the command");
$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.3));"#
    )
}

/// The players asked, in order, when Now Playing can't be read: the first one playing wins, else the
/// first one paused on a track.
#[cfg(target_os = "macos")]
const PLAYERS: [Player; 2] = [
    Player {
        name: "Spotify",
        bundle: "com.spotify.client",
        // Spotify gives a track's length in milliseconds.
        script: r#"tell application "Spotify"
  with timeout of 3 seconds
    set s to player state as string
    if s is "stopped" then return ""
    set t to current track
    return s & tab & (name of t) & tab & (artist of t) & tab & (player position as string) & tab & ((duration of t) / 1000 as string)
  end timeout
end tell"#,
    },
    Player {
        name: "Music",
        bundle: "com.apple.Music",
        // A radio stream has no current track: nothing to show.
        script: r#"tell application "Music"
  with timeout of 3 seconds
    set s to player state as string
    if s is "stopped" then return ""
    try
      set t to current track
      return s & tab & (name of t) & tab & (artist of t) & tab & (player position as string) & tab & (duration of t as string)
    on error
      return ""
    end try
  end timeout
end tell"#,
    },
];

#[cfg(target_os = "macos")]
struct Player {
    /// Its app's name, which is also its process name.
    name: &'static str,
    /// Its app's bundle identifier.
    bundle: &'static str,
    /// Prints its state, title, artist, position and length (seconds), tab-separated, or nothing.
    /// It gives up after a few seconds, so a player that hangs doesn't hold the read.
    script: &'static str,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct NowPlaying {
    /// The player, as it names itself: "TIDAL", "Spotify", "Music"…
    pub app: String,
    /// The player app's bundle identifier ("com.tidal.desktop"), to show its icon and open it; empty
    /// when Now Playing doesn't say.
    #[serde(default)]
    pub bundle: String,
    /// Read from Now Playing (so controlled through it), rather than from the player itself.
    pub system: bool,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    /// Where it is in the track, and how long the track is, in seconds.
    pub position: f64,
    pub duration: f64,
}

/// Now Playing's answer, read: None when there's no song.
#[cfg(any(target_os = "macos", test))]
fn parse_system(out: &str) -> Option<NowPlaying> {
    let out = out.trim();
    if out.is_empty() {
        return None;
    }
    serde_json::from_str(out).ok()
}

/// One player's answer, read; None when it has no track. AppleScript writes numbers the way the
/// Mac's region does, so a decimal comma reads as a point.
#[cfg(any(target_os = "macos", test))]
fn parse(app: &str, bundle: &str, line: &str) -> Option<NowPlaying> {
    let parts: Vec<&str> = line.trim_end_matches(['\n', '\r']).split('\t').collect();
    let [state, title, artist, position, duration] = parts[..] else { return None };
    let number = |s: &str| s.trim().replace(',', ".").parse::<f64>().ok();
    Some(NowPlaying {
        app: app.to_string(),
        bundle: bundle.to_string(),
        system: false,
        playing: state == "playing",
        title: title.to_string(),
        artist: artist.to_string(),
        position: number(position).unwrap_or(0.0),
        duration: number(duration).unwrap_or(0.0),
    })
}

#[cfg(target_os = "macos")]
fn osascript(language: &str, script: &str) -> Result<String, String> {
    let out = std::process::Command::new("osascript")
        .args(["-l", language, "-e", script])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Asking a player that isn't running would open it, and a script naming one that isn't installed
/// won't even compile: only running ones are asked.
#[cfg(target_os = "macos")]
fn running(name: &str) -> bool {
    std::process::Command::new("pgrep").args(["-x", name]).output().map(|o| o.status.success()).unwrap_or(false)
}

/// When the Now Playing read last failed (ms since 1970), so that once macOS has closed it, the read
/// isn't paid for on every poll: it's tried again a minute later.
#[cfg(target_os = "macos")]
static SYSTEM_FAILED_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(target_os = "macos")]
fn now_playing_blocking() -> Option<NowPlaying> {
    use std::sync::atomic::Ordering;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    if now.saturating_sub(SYSTEM_FAILED_AT.load(Ordering::Relaxed)) > 60_000 {
        match osascript("JavaScript", SYSTEM_READ) {
            Ok(out) => return parse_system(&out),
            Err(_) => SYSTEM_FAILED_AT.store(now, Ordering::Relaxed),
        }
    }
    let mut paused = None;
    for player in PLAYERS.iter().filter(|p| running(p.name)) {
        let Some(found) = osascript("AppleScript", player.script).ok().and_then(|line| parse(player.name, player.bundle, &line)) else { continue };
        if found.playing {
            return Some(found);
        }
        paused.get_or_insert(found);
    }
    paused
}

/// What's playing (or paused) now, if anything.
#[tauri::command]
pub async fn now_playing() -> Option<NowPlaying> {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(now_playing_blocking).await.ok().flatten();
    #[cfg(not(target_os = "macos"))]
    None
}

/// Play or pause, next track or previous track: through Now Playing when that's where the song was
/// read (`system`), else in the player `app` itself.
#[tauri::command]
pub async fn media_control(app: String, system: bool, action: MediaAction) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (language, script) = if system {
            ("JavaScript", system_send(action.command()))
        } else {
            let Some(player) = PLAYERS.iter().find(|p| p.name == app) else { return Err(format!("Not a player Demian knows: {app}")) };
            ("AppleScript", format!("with timeout of 3 seconds\ntell application \"{}\" to {}\nend timeout", player.name, action.verb()))
        };
        return tauri::async_runtime::spawn_blocking(move || osascript(language, &script).map(|_| ())).await.map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, system, action);
        Err("Only on macOS".into())
    }
}

/// A bundle identifier as macOS writes them ("com.tidal.desktop"): letters, digits, dots, dashes and
/// underscores, not starting with a dot or dash (so it can't read as a flag to `open`).
fn is_bundle_id(id: &str) -> bool {
    !id.is_empty() && !id.starts_with(['.', '-']) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// Brings the player with this bundle identifier to the front (opening it if it isn't running).
#[tauri::command]
pub async fn open_player(bundle: String) -> Result<(), String> {
    if !is_bundle_id(&bundle) {
        return Err(format!("Not an app: {bundle}"));
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("open").args(["-b", &bundle]).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    Err("Only on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_now_playing() {
        assert_eq!(
            parse_system(r#"{"app":"TIDAL","bundle":"com.tidal.desktop","system":true,"playing":true,"title":"So What","artist":"Miles Davis","position":83.5,"duration":562.32}"#),
            Some(NowPlaying { app: "TIDAL".into(), bundle: "com.tidal.desktop".into(), system: true, playing: true, title: "So What".into(), artist: "Miles Davis".into(), position: 83.5, duration: 562.32 })
        );
        assert_eq!(parse_system("\n"), None);
    }

    #[test]
    fn reads_a_players_answer() {
        assert_eq!(
            parse("Spotify", "com.spotify.client", "playing\tSo What\tMiles Davis\t83.5\t562.32\n"),
            Some(NowPlaying { app: "Spotify".into(), bundle: "com.spotify.client".into(), system: false, playing: true, title: "So What".into(), artist: "Miles Davis".into(), position: 83.5, duration: 562.32 })
        );
    }

    #[test]
    fn reads_decimal_commas_and_pauses() {
        let found = parse("Music", "com.apple.Music", "paused\tA\tB\t12,25\t200,5").unwrap();
        assert!(!found.playing);
        assert_eq!((found.position, found.duration), (12.25, 200.5));
    }

    #[test]
    fn nothing_when_there_is_no_track() {
        assert_eq!(parse("Music", "com.apple.Music", ""), None);
        assert_eq!(parse("Music", "com.apple.Music", "\n"), None);
    }

    #[test]
    fn opens_only_bundle_ids() {
        assert!(is_bundle_id("com.tidal.desktop"));
        assert!(is_bundle_id("com.apple.Music"));
        assert!(!is_bundle_id(""));
        assert!(!is_bundle_id("-a"));
        assert!(!is_bundle_id("com.x; rm"));
    }

    /// Play then pause through Now Playing, on this Mac, checking the player follows each. It changes
    /// what's playing, so it only runs when asked, and ends paused.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn now_playing_takes_commands() {
        let playing = || parse_system(&osascript("JavaScript", SYSTEM_READ).unwrap()).map(|s| s.playing);
        for (command, want) in [(0, true), (1, false)] {
            osascript("JavaScript", &system_send(command)).expect("send");
            std::thread::sleep(std::time::Duration::from_millis(1200));
            assert_eq!(playing(), Some(want), "after command {command}");
        }
    }

    /// The real read, on this Mac: it answers (a song or nothing) rather than failing.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn now_playing_answers() {
        let out = osascript("JavaScript", SYSTEM_READ).expect("Now Playing read");
        println!("{out}");
        if !out.trim().is_empty() {
            assert!(parse_system(&out).is_some(), "{out}");
        }
    }
}
