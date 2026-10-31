import { useEffect, useState } from "react";
import type { OrbLook } from "./components/PressureBlob";

const KEY = "orb-look";

/** What each look is called in the app. */
export const ORB_LOOK_NAMES: Record<OrbLook, string> = { crystal: "Demian", glass: "Roth", porcelain: "Ophelia" };

/**
 * Kept in localStorage like the theme, so the chosen orb shows from the first frame. Looks that
 * have since been retired (Classic, Iridescent) fall back to Demian.
 */
export function storedOrbLook(): OrbLook {
  const look = localStorage.getItem(KEY);
  return look === "glass" || look === "porcelain" ? look : "crystal";
}

export function useOrbLook(): [OrbLook, (look: OrbLook) => void] {
  const [look, setLook] = useState<OrbLook>(storedOrbLook);
  useEffect(() => localStorage.setItem(KEY, look), [look]);
  return [look, setLook];
}
