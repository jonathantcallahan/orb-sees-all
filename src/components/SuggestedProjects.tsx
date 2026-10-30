import { useState } from "react";
import { setProjectState, type Project } from "../db";
import { refreshProject } from "../jobs";
import { activeChannels, nameFromChannel } from "../projects";

/**
 * Projects discovery found outside the #tmp- convention. They stay off the board until the user
 * tracks one (which refreshes it right away) or ignores it (discovery won't suggest it again).
 */
export function SuggestedProjects({ projects, onChange }: { projects: Project[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  if (!projects.length) return null;
  return (
    <div className="suggested-projects">
      <button className="link-button small muted" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} {projects.length} suggested project{projects.length === 1 ? "" : "s"}
      </button>
      {open &&
        projects.map((p) => (
          <div key={p.channel_id} className="suggested-project small">
            <div className="body">
              <strong>{p.snapshot?.name || nameFromChannel(p.name)}</strong>{" "}
              <span className="muted">{activeChannels(p).map((c) => `#${c.name}`).join(", ")}</span>
              {p.found_reason && <div className="muted">{p.found_reason}</div>}
            </div>
            <div className="actions">
              <button
                className="small"
                onClick={async () => {
                  await setProjectState(p.channel_id, "tracked");
                  onChange();
                  refreshProject(p.channel_id).catch(() => {});
                }}
              >
                Track
              </button>
              <button
                className="small link-button muted"
                onClick={async () => {
                  await setProjectState(p.channel_id, "ignored");
                  onChange();
                }}
              >
                Ignore
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
