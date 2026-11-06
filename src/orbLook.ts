import { useEffect, useState } from "react";
import type { OrbLook } from "./components/PressureBlob";

const KEY = "orb-look";

/** What each look is called in the app. */
export const ORB_LOOK_NAMES: Record<OrbLook, string> = { crystal: "Demian", glass: "Roth", porcelain: "Ophelia", film: "Oren", resin: "Penelope", opal: "Edith", aura: "Ephedra", frost: "Artemis", prism: "Moss" };

/**
 * The looks offered in Settings, in order. Roth (glass) and Ophelia (porcelain) are set aside for
 * now: still built, just not offered.
 */
export const ORB_LOOKS: OrbLook[] = ["crystal", "film", "resin", "opal", "aura", "prism", "frost"];

/** The orb until you pick another in Settings: Moss, as on the app icon. (Onboarding always shows Demian.) */
export const DEFAULT_ORB_LOOK: OrbLook = "prism";

/**
 * Kept in localStorage like the theme, so the chosen orb shows from the first frame. No choice yet,
 * or a look that has since been retired or set aside, means the default.
 */
export function storedOrbLook(): OrbLook {
  const look = localStorage.getItem(KEY);
  return (ORB_LOOKS as (string | null)[]).includes(look) ? (look as OrbLook) : DEFAULT_ORB_LOOK;
}

export function useOrbLook(): [OrbLook, (look: OrbLook) => void] {
  const [look, setLook] = useState<OrbLook>(storedOrbLook);
  useEffect(() => {
    localStorage.setItem(KEY, look);
  }, [look]);
  return [look, setLook];
}
