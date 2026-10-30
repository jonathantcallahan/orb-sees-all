/** The few places the app talks or behaves differently on Windows than on macOS. */
export const isWindows = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

/** The shortcut modifier as shown in hints: "⌘" on macOS, "Ctrl+" on Windows. */
export const MOD = isWindows ? "Ctrl+" : "⌘";

/** Where the user runs commands. */
export const TERMINAL = isWindows ? "PowerShell" : "Terminal";

/** The one-line Claude Code installer for this platform. */
export const INSTALL_CLAUDE = isWindows ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash";
