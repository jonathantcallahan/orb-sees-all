import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The song playing on the Mac (src-tauri/src/media.rs): TIDAL, Spotify, Music or anything else that
 * shows in Control Center. It's read every couple of seconds while the window shows, and its time
 * moves on smoothly in between.
 */
export interface NowPlaying {
  /** The player, as it names itself ("TIDAL", "Spotify"…). */
  app: string;
  /** The player app's bundle identifier ("com.tidal.desktop"), to show its icon and open it; may be empty. */
  bundle: string;
  /** Read from the Mac's Now Playing (and controlled through it), rather than the player itself. */
  system: boolean;
  playing: boolean;
  title: string;
  artist: string;
  /** Where it was in the song when read, and the song's length, in seconds. */
  position: number;
  duration: number;
}

export type MediaAction = "playpause" | "next" | "previous";

/** How often the song is read: often while it plays, less while paused or when nothing is. */
const READ_PLAYING_MS = 2000;
const READ_IDLE_MS = 4000;

/** A time in a song: 3:07, or 1:02:09 past an hour. */
export function songClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Where the song is at `now` (ms), read at `readAt`: on from where it was while it plays, never past its end. */
export function songPosition(song: NowPlaying, readAt: number, now: number): number {
  const at = song.position + (song.playing ? Math.max(0, now - readAt) / 1000 : 0);
  return song.duration > 0 ? Math.min(at, song.duration) : at;
}

/** The song playing now (null when nothing is, or off macOS), where it is, and its controls. */
export function useNowPlaying(): { song: NowPlaying | null; position: number; control: (action: MediaAction) => void } {
  const [read, setRead] = useState<{ song: NowPlaying | null; at: number }>({ song: null, at: 0 });
  const [now, setNow] = useState(() => performance.now());
  // A read is stale if a control was pressed after it started, or while one is still going through
  // (it takes the player most of a second to switch): until then, reads are dropped.
  const generation = useRef(0);
  const pending = useRef(0);
  const readNow = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let busy = false;
    // Asked to read again while a read was out: it reads again as soon as that one lands.
    let again = false;
    let playing = false;
    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, ms);
    };
    const tick = async () => {
      if (!alive) return;
      if (busy) {
        again = true;
        return;
      }
      // Hidden, it stops; it reads again as soon as it's shown (onVisible).
      if (document.hidden) return;
      busy = true;
      again = false;
      const started = generation.current;
      const song = await invoke<NowPlaying | null>("now_playing").catch(() => null);
      busy = false;
      if (!alive) return;
      if (started === generation.current && pending.current === 0) {
        const at = performance.now();
        setRead({ song, at });
        setNow(at);
        playing = !!song?.playing;
      }
      schedule(again ? 0 : playing ? READ_PLAYING_MS : READ_IDLE_MS);
    };
    readNow.current = () => schedule(0);
    const onVisible = () => {
      if (!document.hidden) schedule(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // The time moves on between reads while it plays.
  const playing = !!read.song?.playing;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(id);
  }, [playing]);

  const control = useCallback(
    (action: MediaAction) => {
      const song = read.song;
      if (!song) return;
      pending.current++;
      // Play/pause shows at once; a skip shows when the player has moved to the next song.
      if (action === "playpause") {
        const at = performance.now();
        setRead({ song: { ...song, playing: !song.playing, position: songPosition(song, read.at, at) }, at });
        setNow(at);
      }
      invoke("media_control", { app: song.app, system: song.system, action })
        .catch(() => {})
        .finally(() => {
          // Players take a moment to report the change; reads that went out before it are stale.
          window.setTimeout(() => {
            pending.current--;
            generation.current++;
            readNow.current();
          }, 350);
        });
    },
    [read],
  );

  return { song: read.song, position: read.song ? songPosition(read.song, read.at, now) : 0, control };
}

/** Brings the player to the front, opening it if it isn't running. */
export function openPlayer(bundle: string): void {
  if (bundle) invoke("open_player", { bundle }).catch(() => {});
}
