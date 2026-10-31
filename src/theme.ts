import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

const KEY = "theme";

/** Kept in localStorage rather than the database so it applies before the first paint. */
export function storedTheme(): Theme {
  const t = localStorage.getItem(KEY);
  return t === "light" || t === "dark" ? t : "system";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  // The window itself follows too, so macOS draws its edge and shadow for the same light or dark
  // (a light app in a dark-mode window gets a black outline).
  getCurrentWindow()
    .setTheme(theme === "system" ? null : theme)
    .catch(() => {});
}

/** Whether dark colors are showing right now, resolving "system" against macOS. */
export function isDark(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);
  return [theme, setTheme];
}
