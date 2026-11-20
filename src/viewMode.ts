import { useEffect, useState } from "react";

/**
 * The app's one layout: the orb and calendar, then one area at a time (Updates, Tasks, Projects
 * or Watched topics, each of which can be turned off; see features), picked from a rail of icons, or
 * with no rail when only one is on. The open area is kept in localStorage, so it shows from the first
 * frame.
 */
export type DetailTab = "updates" | "tasks" | "projects" | "watched";

const TAB_KEY = "detail-tab";

/** Told when something elsewhere opens a Detail area (View in tasks from a meeting, say). */
const TAB_EVENT = "view:detail-tab";

/** Opens an area from anywhere (View in tasks from a meeting, say). */
export function showDetailTab(tab: DetailTab) {
  window.dispatchEvent(new CustomEvent(TAB_EVENT, { detail: tab }));
}

/** The Detail view's open area, remembered between launches. */
export function useDetailTab(): [DetailTab, (tab: DetailTab) => void] {
  const [tab, setTab] = useState<DetailTab>(() => {
    const t = localStorage.getItem(TAB_KEY);
    // An area that's off shows the first one on instead (see App), and the one kept here comes back
    // when it's on again.
    return t === "tasks" || t === "projects" || t === "watched" || t === "updates" ? t : "updates";
  });
  useEffect(() => localStorage.setItem(TAB_KEY, tab), [tab]);
  useEffect(() => {
    const onShow = (e: Event) => setTab((e as CustomEvent<DetailTab>).detail);
    window.addEventListener(TAB_EVENT, onShow);
    return () => window.removeEventListener(TAB_EVENT, onShow);
  }, []);
  return [tab, setTab];
}
