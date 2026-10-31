import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { setTaskState } from "../db";
import { formatWhen } from "../scheduler";
import type { ViewTask } from "../tasks";
import { MOD } from "../platform";

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

/** A message to post, editable in a centered modal before it goes out. Esc cancels; ⌘↩ (Ctrl+↩) sends. */
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
  actions,
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
  /** Without it there's nothing to send from here (an email you reply to in Gmail): Cancel reads Close. */
  onSend?: () => void;
  /** Extra footer actions, beside Cancel (e.g. Copy, Open thread). */
  actions?: ReactNode;
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
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSend?.();
          }}
        />
        <footer className="plan-modal-actions edit-actions">
          <span className={`small ${failed ? "error" : "muted"} remind-status`}>{status ?? note}</span>
          {actions}
          <button className="cta-ghost" disabled={busy} onClick={onCancel}>
            {onSend ? "Cancel" : "Close"}
          </button>
          {onSend && (
            <button className="cta-primary" disabled={busy || !text.trim()} onClick={onSend} title={`Send (${MOD}↩)`}>
              Send
            </button>
          )}
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

/**
 * Content that opens and closes smoothly, the same way task cards do: its height animates through a
 * one-row grid, its content fades in just after and out just before. The content is rendered once
 * it's first opened, then kept so closing can animate; while closed it's inert.
 */
export function Reveal({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open && !mounted) {
      // Mount closed first, then open on the next frame, so the height has somewhere to animate from.
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    } else setShown(open);
  }, [open]);
  return (
    <div className={`reveal${shown ? "" : " closed"}${className ? ` ${className}` : ""}`} inert={!shown} aria-hidden={!shown}>
      <div className="reveal-inner">{mounted && children}</div>
    </div>
  );
}

/** Characters a scrambling letter flips through: punctuation and a few funky ones. */
const SCRAMBLE_GLYPHS = "!<>-_/\\[]{}=+*^?#%&$@░▒▓◆◇○●◎※¤§¶∆∑∂ƒ≈≠∞λΩ";
const SCRAMBLE_MS = 500;

/**
 * Text that, when it changes, morphs from the old string into the new one: each letter flips
 * through random characters (some funky) and lands on its new letter at its own random moment,
 * all within half a second. With reduced motion it just changes.
 */
export function ScrambleText({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const current = useRef(text);
  useEffect(() => {
    const from = current.current;
    if (from === text) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      current.current = text;
      setShown(text);
      return;
    }
    const length = Math.max(from.length, text.length);
    // Each position starts scrambling and settles at its own moment within the half second.
    const starts = Array.from({ length }, () => Math.random() * SCRAMBLE_MS * 0.4);
    const ends = starts.map((s) => s + SCRAMBLE_MS * 0.3 + Math.random() * (SCRAMBLE_MS * 0.6 - s));
    const begin = performance.now();
    let frame = 0;
    const glyph = () => SCRAMBLE_GLYPHS[Math.floor(Math.random() * SCRAMBLE_GLYPHS.length)];
    const step = (now: number) => {
      const t = now - begin;
      let out = "";
      for (let i = 0; i < length; i++) {
        if (t >= ends[i]) out += text[i] ?? "";
        else if (t >= starts[i]) out += glyph();
        else out += from[i] ?? "";
      }
      current.current = out;
      setShown(out);
      if (t < SCRAMBLE_MS) frame = requestAnimationFrame(step);
      else {
        current.current = text;
        setShown(text);
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return <span className="scramble">{shown}</span>;
}
