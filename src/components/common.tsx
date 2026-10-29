import { openUrl } from "@tauri-apps/plugin-opener";
import type { CSSProperties, ReactNode } from "react";
import { setTaskState } from "../db";
import type { ViewTask } from "../tasks";

export function ExternalLink({
  href,
  children,
  className,
  title,
  style,
}: {
  href?: string | null;
  children: ReactNode;
  className?: string;
  title?: string;
  style?: CSSProperties;
}) {
  if (!href)
    return (
      <span className={className} title={title} style={style}>
        {children}
      </span>
    );
  return (
    <a
      className={className}
      title={title}
      style={style}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

export function RefreshButton({ busy, onClick, title }: { busy: boolean; onClick: () => void; title: string }) {
  return (
    <button className={`icon-button refresh${busy ? " busy" : ""}`} onClick={onClick} disabled={busy} title={title} aria-label={title}>
      <span className={busy ? "spin" : undefined}>↻</span>
    </button>
  );
}

export function Checklist({ tasks, onChange, empty }: { tasks: ViewTask[]; onChange: () => void; empty?: string }) {
  if (!tasks.length) return empty ? <p className="muted small">{empty}</p> : null;
  return (
    <ul className="checklist">
      {tasks.map((t) => (
        <li key={t.id} className={t.done ? "done" : undefined}>
          <input
            type="checkbox"
            checked={t.done}
            onChange={async (e) => {
              await setTaskState(t.id, { status: e.target.checked ? "done" : "todo" });
              onChange();
            }}
          />
          <div className="task-body">
            <ExternalLink href={t.link} className="task-title">
              {t.title}
            </ExternalLink>
            {(t.detail || t.due) && (
              <div className="muted small">
                {t.detail}
                {t.detail && t.due && " · "}
                {t.due && <span className="due">due {t.due}</span>}
              </div>
            )}
          </div>
          <button
            className="icon-button dismiss"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={async () => {
              await setTaskState(t.id, { dismissed: true });
              onChange();
            }}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Updated({ at }: { at: string | null | undefined }) {
  if (!at) return <span className="muted small">never refreshed</span>;
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  const text = d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return <span className={`muted small${today ? "" : " stale"}`}>updated {text}</span>;
}
