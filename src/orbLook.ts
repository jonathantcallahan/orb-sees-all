import { useEffect, useState } from "react";
import type { OrbLook } from "./components/PressureBlob";

const KEY = "orb-look";

/** What each look is called in the app. */
export const ORB_LOOK_NAMES: Record<OrbLook, string> = { crystal: "Demian", glass: "Roth", porcelain: "Ophelia", film: "Oren" };

/**
 * Kept in localStorage like the theme, so the chosen orb shows from the first frame. Looks that
 * have since been retired (Classic, Iridescent) fall back to Demian.
 */
export function storedOrbLook(): OrbLook {
  const look = localStorage.getItem(KEY);
  return look === "glass" || look === "porcelain" || look === "film" ? look : "crystal";
}

/** Told when the orb look changes, so everything showing its name updates. */
const LOOK_EVENT = "orb:look";

export function useOrbLook(): [OrbLook, (look: OrbLook) => void] {
  const [look, setLook] = useState<OrbLook>(storedOrbLook);
  useEffect(() => {
    localStorage.setItem(KEY, look);
    window.dispatchEvent(new Event(LOOK_EVENT));
  }, [look]);
  return [look, setLook];
}

/** The current orb's name (Demian, Roth, Ophelia, Oren), following changes in Settings. */
export function useOrbName(): string {
  const [look, setLook] = useState<OrbLook>(storedOrbLook);
  useEffect(() => {
    const onChange = () => setLook(storedOrbLook());
    window.addEventListener(LOOK_EVENT, onChange);
    return () => window.removeEventListener(LOOK_EVENT, onChange);
  }, []);
  return ORB_LOOK_NAMES[look];
}
