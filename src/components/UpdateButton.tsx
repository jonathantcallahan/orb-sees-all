import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

/** How often to look for a new release while the app runs (it also checks at launch). */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Shows "Update to x.y.z" in the header when GitHub has a newer release. Clicking downloads and
 * installs it, then restarts the app. Checks fail quietly (offline, dev builds).
 */
export function UpdateButton() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const look = () => check().then((u) => u && setUpdate(u), () => {});
    look();
    const id = setInterval(look, CHECK_EVERY_MS);
    return () => clearInterval(id);
  }, []);

  if (!update) return null;

  const install = async () => {
    setFailed(null);
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") {
          done += e.data.chunkLength;
          setProgress(total ? `Downloading ${Math.round((done / total) * 100)}%` : "Downloading…");
        }
        if (e.event === "Finished") setProgress("Restarting…");
      });
      await relaunch();
    } catch (e) {
      setProgress(null);
      setFailed(String(e));
    }
  };

  return (
    <button
      className="update-button"
      disabled={!!progress}
      onClick={install}
      title={failed ? `Update failed: ${failed}` : update.body ? `What's new: ${update.body}` : `Version ${update.version} is ready`}
    >
      {progress ?? (failed ? "Retry update" : `Update to ${update.version}`)}
    </button>
  );
}
