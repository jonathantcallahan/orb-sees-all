import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
/** The few places the app talks or behaves differently on Windows than on macOS. */
export const isWindows = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

/** The shortcut modifier as shown in hints: "⌘" on macOS, "Ctrl+" on Windows. */
export const MOD = isWindows ? "Ctrl+" : "⌘";

/** Where the user runs commands. */
export const TERMINAL = isWindows ? "PowerShell" : "Terminal";

/** The one-line Claude Code installer for this platform. */
export const INSTALL_CLAUDE = isWindows ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash";

/** Signs Claude Code in with a Claude account (not an API key), from a terminal. */
export const LOGIN_CLAUDE = "claude auth login --claudeai";

/**
 * The sign-in command to show for pasting: Claude Code by the full path Demian found it at, so it
 * works where its folder isn't on PATH (a fresh Windows install leaves .local\bin off it, and
 * `claude` then isn't recognized). LOGIN_CLAUDE until that's known, or if Claude Code isn't found.
 */
export function useLoginCommand(): string {
  const [command, setCommand] = useState(LOGIN_CLAUDE);
  useEffect(() => {
    invoke<string>("setup_login_command").then(setCommand, () => {});
  }, []);
  return command;
}

