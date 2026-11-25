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

/** Whether the page shows dark colors, followed as the theme changes (in Settings, or in macOS when it follows macOS). */
export function useDarkPage(): boolean {
  const read = () => isDark((document.documentElement.dataset.theme as Theme | undefined) ?? "system");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const update = () => setDark(read());
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    update();
    return () => {
      scheme.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  return dark;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);
  return [theme, setTheme];
}
