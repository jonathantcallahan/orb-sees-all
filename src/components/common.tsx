import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { setTaskState } from "../db";
import { formatWhen } from "../scheduler";
import type { ViewTask } from "../tasks";
import type { StepState } from "../sessions";
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

/** A keyboard shortcut as a small hint, e.g. ⌘D ("Ctrl" and the letter on Windows). */
export function Kbd({ keys }: { keys: string }) {
  return (
    <kbd className="kbd" aria-hidden>
      {keys}
    </kbd>
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
  /** What the refresh is doing, for screen readers while it runs (the spinner alone is shown, with no tooltip). */
  status?: string;
}) {
  const label = busy && status ? `${status}…` : title;
  return (
    <span className="refresh-wrap">
      <button className={`icon-button refresh${busy ? " busy" : ""}`} onClick={onClick} disabled={busy} title={busy ? undefined : title} aria-label={label}>
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

/** A time the way the app shows "updated …": just the time today, else the date and time. */
export function updatedText(at: string): string {
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function Updated({ at }: { at: string | null | undefined }) {
  if (!at) return <span className="timestamp small updated-stamp">never refreshed</span>;
  const today = new Date(at).toDateString() === new Date().toDateString();
  return <span className={`timestamp small updated-stamp${today ? "" : " stale"}`}>updated {updatedText(at)}</span>;
}

/** Claude Code's working indicator: a star that grows through these glyphs and back. */
/**
 * Claude Code's working glyph, frame by frame. U+FE0E asks for the plain text form: WebView2 (on
 * Windows) otherwise draws ✳ as a green color emoji.
 */
export const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"].map((f) => (f === "·" ? f : `${f}\uFE0E`));

export function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className={`spinner${SPINNER_FRAMES[frame] === "·" ? " dot" : ""}`} aria-hidden>
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
  sendLabel = "Send",
  tall = false,
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
  /** The primary button's label; Send by default. */
  sendLabel?: string;
  /** A taller editor, for a whole document. */
  tall?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  // The editor grows to show all the text; only when the window would then be taller than the
  // screen does it stop growing and scroll (the modal's max height lets it shrink back to fit).
  const editor = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = editor.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight)}px`;
    };
    fit();
    // Again once layout has settled (fonts, styles), and whenever the window changes size.
    const frame = requestAnimationFrame(fit);
    window.addEventListener("resize", fit);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
    };
  }, [text]);

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
          ref={editor}
          autoFocus
          className="description-editor compose-editor"
          rows={tall ? 18 : 6}
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
            <button className="cta-primary" disabled={busy || !text.trim()} onClick={onSend} title={`${sendLabel} (${MOD}↩)`}>
              {sendLabel}
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
 * all within half a second (or `duration`). With reduced motion it just changes.
 */
export function ScrambleText({ text, duration = SCRAMBLE_MS, from }: { text: string; duration?: number; from?: string }) {
  return <span className="scramble">{useScrambled(text, duration, from)}</span>;
}

/** The scramble as a string (ScrambleText's), for places that can't hold a span, like a placeholder. */
export function useScrambled(text: string, duration = SCRAMBLE_MS, from?: string): string {
  // `from` starts it from other text (scrambled noise, say) and morphs into `text` on first show.
  const [shown, setShown] = useState(from ?? text);
  const current = useRef(from ?? text);
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
    const starts = Array.from({ length }, () => Math.random() * duration * 0.4);
    const ends = starts.map((s) => s + duration * 0.3 + Math.random() * (duration * 0.6 - s));
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
      if (t < duration) frame = requestAnimationFrame(step);
      else {
        current.current = text;
        setShown(text);
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return shown;
}

/** How wide a tooltip can be, so one near the right edge is moved in to fit. */
const TIP_WIDTH = 300;

/**
 * A (?) icon that explains something in a tooltip: on hover, or on focus from the keyboard. Clicking
 * it does nothing else, so it can sit inside a button (a setting's label) without pressing it.
 */
export function InfoTip({ children, label = "More about this" }: { children: ReactNode; label?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const show = (el: HTMLElement) => setAnchor(el.getBoundingClientRect());
  const hide = () => setAnchor(null);
  return (
    <span
      className="info-tip"
      role="img"
      tabIndex={0}
      aria-label={label}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={hide}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={hide}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      {/* A solid gray disc with a white question mark. */}
      <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="7" fill="currentColor" />
        <path d="M5.1 5.3a1.9 1.9 0 1 1 2.75 1.7c-.55.28-.85.65-.85 1.2v.35" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="7" cy="10.6" r="0.85" fill="#fff" />
      </svg>
      {anchor &&
        createPortal(
          <div
            className="card info-tip-body"
            role="tooltip"
            style={{ left: Math.max(8, Math.min(anchor.left - 8, window.innerWidth - TIP_WIDTH - 8)), top: anchor.bottom + 6, maxWidth: TIP_WIDTH }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * A plan step's marker: dashed when not started, turning while in progress, amber and still while waiting on you,
 * checked when done, a red bar when blocked on someone else, struck through when skipped.
 */
export function StepCircle({ state, human = false }: { state?: StepState; human?: boolean }) {
  return (
    <svg className={`step-circle${state ? ` ${state}` : ""}${human ? " human" : ""}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      {state === "skipped" ? (
        <>
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3.2 8.8 8.8 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </>
      ) : state === "blocked" ? (
        <>
          <circle cx="6" cy="6" r="5.5" fill="currentColor" />
          <path d="M3.5 6h5" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : state === "done" ? (
        <>
          <circle cx="6" cy="6" r="5.5" fill="currentColor" />
          <path d="M3.4 6.2 5.2 8l3.4-3.6" fill="none" stroke="var(--bg)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.4 1.8" />
      )}
    </svg>
  );
}

/**
 * Shows `text` in a small card under its child while it's hovered (the webview doesn't show native
 * title tooltips). With no text, renders the child alone.
 */
export function HoverTip({ text, whenClipped = false, children }: { text: string | null; whenClipped?: boolean; children: ReactNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!text) return <>{children}</>;
  return (
    <span
      className="hover-tip-anchor"
      onMouseEnter={(e) => {
        // `whenClipped`: only when the text in it (.clip-text) is cut short, since otherwise it's all there.
        const clip = e.currentTarget.querySelector<HTMLElement>(".clip-text");
        if (whenClipped && (!clip || clip.scrollWidth <= clip.clientWidth)) return;
        setAnchor(e.currentTarget.getBoundingClientRect());
      }}
      onMouseLeave={() => setAnchor(null)}
    >
      {children}
      {anchor &&
        createPortal(
          <div className="card meeting-card hover-tip small" role="tooltip" style={{ left: anchor.left, top: anchor.bottom + 6 }}>
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * Sizes a textarea to what's in it, growing and shrinking as it changes, so it never needs a scroll
 * bar or a resize handle. Pass anything else that changes its height (a placeholder) too.
 */
export function useAutoGrow(...deps: unknown[]) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight leaves out the borders.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, deps);
  return ref;
}

const Chevron = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
    <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * A value you can change, as a badge the width of what it shows: clicking opens a small menu of
 * the choices under it. Every changeable value drawn as a badge uses it, so they look and work
 * alike. Escape or a click elsewhere closes the menu.
 */
export function BadgeSelect<T extends string>({
  label,
  value,
  options,
  empty = false,
  arrow = true,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  /** Nothing chosen yet: the badge's text is muted. */
  empty?: boolean;
  /** The small arrow saying it opens a menu. */
  arrow?: boolean;
  onChange: (value: T) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => setAnchor(null);
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
      button.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    // The chosen item takes focus, so the menu works from the keyboard.
    menu.current?.querySelector<HTMLButtonElement>(".on, button")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor]);
  const text = options.find((o) => o.value === value)?.label ?? value;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`badge badge-select${empty ? " none" : ""}${anchor ? " open" : ""}`}
        aria-label={`${label}: ${text}`}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(e) => (anchor ? close() : setAnchor(e.currentTarget.getBoundingClientRect()))}
      >
        {text}
        {arrow && <Chevron />}
      </button>
      {anchor &&
        createPortal(
          <div
            ref={menu}
            className="card badge-menu"
            role="menu"
            aria-label={label}
            style={{ left: Math.min(anchor.left, window.innerWidth - 240), top: anchor.bottom + 4 }}
            onKeyDown={(e) => {
              // Up and down move between the choices.
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
              const at = items.indexOf(document.activeElement as HTMLButtonElement);
              items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
            }}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={o.value === value}
                className={`badge-menu-item${o.value === value ? " on" : ""}`}
                onClick={() => {
                  onChange(o.value);
                  close();
                  button.current?.focus();
                }}
              >
                {o.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
