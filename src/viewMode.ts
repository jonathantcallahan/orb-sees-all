import { useEffect, useState } from "react";

/**
 * The app's one layout: the orb and calendar, then one area at a time (Updates, Tasks or
 * Projects), picked from a rail of icons. The open area is kept in localStorage, so it shows from
 * the first frame.
 */
export type DetailTab = "updates" | "tasks" | "projects";

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
    return t === "tasks" || t === "projects" ? t : "updates";
  });
  useEffect(() => localStorage.setItem(TAB_KEY, tab), [tab]);
  useEffect(() => {
    const onShow = (e: Event) => setTab((e as CustomEvent<DetailTab>).detail);
    window.addEventListener(TAB_EVENT, onShow);
    return () => window.removeEventListener(TAB_EVENT, onShow);
  }, []);
  return [tab, setTab];
}
