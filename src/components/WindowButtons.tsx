import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The window's close, minimize and zoom buttons, drawn by the app (macOS's own are hidden): plain
 * gray dots that take on their usual red, yellow and green while the pointer is over them, with no
 * symbols inside. Close hides the window to the menu bar, like the native one.
 */
export function WindowButtons() {
  const win = getCurrentWindow();
  return (
    <div className="window-buttons">
      <button className="window-button close" aria-label="Close" onClick={() => win.close()} />
      <button className="window-button minimize" aria-label="Minimize" onClick={() => win.minimize()} />
      <button className="window-button zoom" aria-label="Zoom" onClick={() => win.toggleMaximize()} />
    </div>
  );
}
