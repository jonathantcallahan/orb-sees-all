import { useEffect, useState } from "react";
import type { OrbLook } from "./components/PressureBlob";

const KEY = "orb-look";

/** Kept in localStorage like the theme, so the chosen orb shows from the first frame. */
export function storedOrbLook(): OrbLook {
  const look = localStorage.getItem(KEY);
  return look === "glass" || look === "iridescent" ? look : "classic";
}

export function useOrbLook(): [OrbLook, (look: OrbLook) => void] {
  const [look, setLook] = useState<OrbLook>(storedOrbLook);
  useEffect(() => localStorage.setItem(KEY, look), [look]);
  return [look, setLook];
}
