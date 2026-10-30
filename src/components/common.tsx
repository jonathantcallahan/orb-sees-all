import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { setTaskState } from "../db";
import { formatWhen } from "../scheduler";
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

export function RefreshButton({
  busy,
  onClick,
  title,
  status,
}: {
  busy: boolean;
  onClick: () => void;
  title: string;
  /** What the refresh is doing, shown beside the spinner while it runs. */
  status?: string;
}) {
  return (
    <span className="refresh-wrap">
      {busy && status && (
        <span className="refresh-status" title={status}>
          {status}…
        </span>
      )}
      <button className={`icon-button refresh${busy ? " busy" : ""}`} onClick={onClick} disabled={busy} title={title} aria-label={title}>
        {busy ? <Spinner /> : "↻"}
      </button>
    </span>
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
                {t.due && <span className="due timestamp">due {formatWhen(t.due)}</span>}
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
            <CloseIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Updated({ at }: { at: string | null | undefined }) {
  if (!at) return <span className="timestamp small">never refreshed</span>;
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  const text = d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return <span className={`timestamp small${today ? "" : " stale"}`}>updated {text}</span>;
}

/** Claude Code's working indicator: a star that grows through these glyphs and back. */
const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

export function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="spinner" aria-hidden>
      {SPINNER_FRAMES[frame]}
    </span>
  );
}

/** A message to post, editable in a centered modal before it goes out. Esc cancels; ⌘↩ sends. */
export function ComposeModal({
  heading,
  note,
  text,
  status,
  failed,
  busy,
  onChange,
  onCancel,
  onSend,
}: {
  heading: string;
  /** Where it will go, shown until there's a status to report. */
  note: string;
  text: string;
  status: string | null;
  failed: boolean;
  busy: boolean;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Portaled to <body>; clicks still bubble through React, so stop them before they select the project.
  return createPortal(
    <div
      className="modal-backdrop plan-modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="modal plan-modal" role="dialog" aria-label={heading} onClick={(e) => e.stopPropagation()}>
        <header className="column-header">
          <h2>{heading}</h2>
        </header>
        <textarea
          autoFocus
          className="description-editor"
          rows={6}
          value={text}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSend();
          }}
        />
        <footer className="plan-modal-actions edit-actions">
          <span className={`small ${failed ? "error" : "muted"} remind-status`}>{status ?? note}</span>
          <button className="cta-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="cta-primary" disabled={busy || !text.trim()} onClick={onSend} title="Send (⌘↩)">
            Send
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** A close mark drawn as two strokes, so it centers exactly (the × character sits low in most fonts). */
export function CloseIcon({ size = 10 }: { size?: number }) {
  return (
    <svg className="close-icon" width={size} height={size} viewBox="0 0 10 10" aria-hidden>
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
