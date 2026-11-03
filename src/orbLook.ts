import { useEffect, useState } from "react";
import type { OrbLook } from "./components/PressureBlob";

const KEY = "orb-look";

/** What each look is called in the app. */
export const ORB_LOOK_NAMES: Record<OrbLook, string> = { crystal: "Demian", glass: "Roth", porcelain: "Ophelia", film: "Oren", resin: "Penelope", opal: "Edith", aura: "Ephedra" };

/**
 * The looks offered in Settings, in order. Roth (glass) and Ophelia (porcelain) are set aside for
 * now: still built, just not offered.
 */
export const ORB_LOOKS: OrbLook[] = ["crystal", "film", "resin", "opal", "aura"];

/**
 * Kept in localStorage like the theme, so the chosen orb shows from the first frame. Looks that
 * have since been retired or set aside fall back to Demian.
 */
export function storedOrbLook(): OrbLook {
  const look = localStorage.getItem(KEY);
  // A look that's set aside or retired falls back to Demian.
  return (ORB_LOOKS as (string | null)[]).includes(look) ? (look as OrbLook) : "crystal";
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

/** The current orb's name (Demian, Roth, Ophelia, Oren, Penelope, Edith, Ephedra), following changes in Settings. */
export function useOrbName(): string {
  const [look, setLook] = useState<OrbLook>(storedOrbLook);
  useEffect(() => {
    const onChange = () => setLook(storedOrbLook());
    window.addEventListener(LOOK_EVENT, onChange);
    return () => window.removeEventListener(LOOK_EVENT, onChange);
  }, []);
  return ORB_LOOK_NAMES[look];
}
