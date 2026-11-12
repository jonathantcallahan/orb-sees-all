import { describe, expect, it } from "vitest";
import { songClock, songPosition, type NowPlaying } from "./nowPlaying";

const song: NowPlaying = { app: "TIDAL", bundle: "com.tidal.desktop", system: true, playing: true, title: "A", artist: "B", position: 30, duration: 120 };

describe("songClock", () => {
  it("writes minutes and seconds, and hours past an hour", () => {
    expect(songClock(0)).toBe("0:00");
    expect(songClock(187.9)).toBe("3:07");
    expect(songClock(3729)).toBe("1:02:09");
  });
});

describe("songPosition", () => {
  it("moves on while it plays, not while paused", () => {
    expect(songPosition(song, 1000, 6000)).toBe(35);
    expect(songPosition({ ...song, playing: false }, 1000, 6000)).toBe(30);
  });
  it("stops at the end of the song", () => {
    expect(songPosition(song, 0, 500_000)).toBe(120);
  });
});
