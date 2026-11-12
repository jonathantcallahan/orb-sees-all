import { useId, type ReactNode } from "react";
import { openPlayer, songClock, useNowPlaying, type MediaAction, type NowPlaying } from "../nowPlaying";

/** Previous, play, pause and next, drawn small in the text's color. */
const ICONS: Record<"previous" | "play" | "pause" | "next", ReactNode> = {
  previous: <path d="M2.2 2.2h1.7v7.6H2.2zM10.2 2.3v7.4L4.6 6z" />,
  play: <path d="M3.4 1.9v8.2L10.2 6z" />,
  pause: <path d="M2.9 2.2h2.2v7.6H2.9zM6.9 2.2h2.2v7.6H6.9z" />,
  next: <path d="M9.8 2.2H8.1v7.6h1.7zM1.8 2.3v7.4L7.4 6z" />,
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

/**
 * The player's mark, drawn in the text's color: TIDAL's four diamonds, Spotify's circle and waves,
 * Music's beamed notes, and a plain note for any other player (a browser, a podcast app).
 */
function PlayerIcon({ bundle }: { bundle: string }) {
  const mask = useId();
  const b = bundle.toLowerCase();
  const svg = (children: ReactNode) => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {children}
    </svg>
  );
  if (b.startsWith("com.tidal.")) {
    return svg(<path d="M5 5 8.5 8.5 5 12 1.5 8.5ZM12 5l3.5 3.5L12 12 8.5 8.5ZM19 5l3.5 3.5L19 12l-3.5-3.5ZM12 12l3.5 3.5L12 19l-3.5-3.5Z" />);
  }
  if (b === "com.spotify.client") {
    return svg(
      <>
        <mask id={mask}>
          <rect width="24" height="24" fill="white" />
          <g fill="none" stroke="black" strokeLinecap="round">
            <path d="M5.6 9q6.4-2.4 12.8.9" strokeWidth="2.1" />
            <path d="M6.4 12.5q5.4-1.8 10.6.9" strokeWidth="1.8" />
            <path d="M7.2 15.8q4.4-1.2 8.4.9" strokeWidth="1.5" />
          </g>
        </mask>
        <circle cx="12" cy="12" r="11" mask={`url(#${mask})`} />
      </>,
    );
  }
  if (b === "com.apple.music" || b === "com.apple.itunes") {
    return svg(
      <>
        <path d="M9 5.2 19 2.8v2.8L9 8Z" />
        <rect x="9" y="5.6" width="1.6" height="11.6" />
        <rect x="17.4" y="3.2" width="1.6" height="11.8" />
        <ellipse cx="7.6" cy="17.2" rx="3" ry="2.3" transform="rotate(-18 7.6 17.2)" />
        <ellipse cx="16" cy="15" rx="3" ry="2.3" transform="rotate(-18 16 15)" />
      </>,
    );
  }
  return svg(
    <>
      <rect x="13" y="3" width="1.7" height="13.6" />
      <path d="M14.7 3c1.8 1.5 4.3 2 4.5 5-1.2-1.4-2.8-1.6-4.5-1.8Z" />
      <ellipse cx="11.4" cy="16.6" rx="3.1" ry="2.4" transform="rotate(-18 11.4 16.6)" />
    </>,
  );
}

/**
 * The song playing on the Mac, at the bottom right across from Settings: its player's icon (which
 * opens the player), its artist (fainter) and title, where it is and how long it is, then previous,
 * play/pause and next in a glass pill like Settings. Nothing when there's no song, playing or paused.
 */
export function NowPlayingBar({ look }: { look: string }) {
  const { song, position, control } = useNowPlaying();
  if (!song) return null;
  return <NowPlayingView song={song} position={position} look={look} onControl={control} />;
}

/** The bar for a given song, with what its buttons do. */
export function NowPlayingView({ song, position, look, onControl }: { song: NowPlaying; position: number; look: string; onControl: (action: MediaAction) => void }) {
  const about = [song.title, song.artist && `by ${song.artist}`, song.app && `in ${song.app}`].filter(Boolean).join(" ");
  return (
    <div className="now-playing" role="group" aria-label="Now playing" title={about}>
      {song.bundle ? (
        <button type="button" className="now-playing-app" title={`Open ${song.app || "the player"}`} aria-label={`Open ${song.app || "the player"}`} onClick={() => openPlayer(song.bundle)}>
          <PlayerIcon bundle={song.bundle} />
        </button>
      ) : (
        <span className="now-playing-app">
          <PlayerIcon bundle="" />
        </span>
      )}
      {song.artist && <span className="now-playing-artist">{song.artist}</span>}
      <span className="now-playing-title">{song.title}</span>
      {song.duration > 0 && (
        <span className="now-playing-time">
          {songClock(position)} / {songClock(song.duration)}
        </span>
      )}
      <span className={`glass-button now-playing-controls look-${look}`}>
        <button type="button" aria-label="Previous" title="Previous" onClick={() => onControl("previous")}>
          <Icon name="previous" />
        </button>
        <button type="button" aria-label={song.playing ? "Pause" : "Play"} title={song.playing ? "Pause" : "Play"} onClick={() => onControl("playpause")}>
          <Icon name={song.playing ? "pause" : "play"} />
        </button>
        <button type="button" aria-label="Next" title="Next" onClick={() => onControl("next")}>
          <Icon name="next" />
        </button>
      </span>
    </div>
  );
}
