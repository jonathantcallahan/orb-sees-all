import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as db from "../db";
import { askLessOften, loadWhyLevel, loadWhyRates, saveWhyRates, WHY_EVENT, WHY_EVERY_MAX, WHY_LEVELS, type WhyRequest } from "../feedback";
import { typingIn, whyKey } from "../whyKeys";
import { Kbd } from "./common";

/** How long the prompt waits for a reason before fading, unless you start typing. */
const LINGER_MS = 8000;
const WIDTH = 280;
/** Between the cursor and the prompt's edge, so the prompt sits right under it. */
const GAP = 4;
/** About the prompt's height, to tell whether it fits below the cursor. */
const HEIGHT = 96;

/**
 * The optional "Why?" after a correction (recordCorrection): a one-line field right under the
 * cursor, focused so you can start typing (unless you've moved on to typing somewhere else). Enter
 * saves the reason with the correction; Dismiss (Space), Esc, clicking away or waiting leaves it, and
 * the reason is inferred later instead. Ask less often (L) halves how often it asks about this kind of
 * change. Space and L act only while the field is empty, since a reason can hold them (see whyKey).
 * Closed from the keyboard, it hands focus back to where it was. Mounted once, in App.
 */
export function WhyPrompt() {
  const [ask, setAsk] = useState<(WhyRequest & { x: number; y: number }) | null>(null);
  const [text, setText] = useState("");
  const [leaving, setLeaving] = useState(false);
  // Where the cursor is now, not where it was last pressed: after a dropdown or a drag it's moved on.
  const pointer = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const timer = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  // Removes the prompt once it has faded; cleared when the next one opens, so it can't take that one away.
  const closeTimer = useRef(0);
  // Set once the prompt is closing, so its field's blur (or a second key) doesn't close it again.
  const ended = useRef(false);
  // What had focus before the field took it, to hand it back when the prompt is closed from the keyboard.
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const track = (e: PointerEvent) => (pointer.current = { x: e.clientX, y: e.clientY });
    const show = (e: Event) => {
      const detail = (e as CustomEvent<WhyRequest>).detail;
      window.clearTimeout(closeTimer.current);
      ended.current = false;
      setText("");
      setLeaving(false);
      setAsk({ ...detail, ...pointer.current });
    };
    window.addEventListener("pointerdown", track, true);
    window.addEventListener("pointermove", track, { capture: true, passive: true });
    window.addEventListener(WHY_EVENT, show);
    return () => {
      window.removeEventListener("pointerdown", track, true);
      window.removeEventListener("pointermove", track, true);
      window.removeEventListener(WHY_EVENT, show);
    };
  }, []);

  /** Fades the prompt out; `restore` hands focus back to where it was (closed from the keyboard). */
  const close = (restore = false) => {
    if (ended.current) return;
    ended.current = true;
    setLeaving(true);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setAsk(null), 180);
    const back = returnTo.current;
    returnTo.current = null;
    if (restore && back?.isConnected) back.focus({ preventScroll: true });
  };
  // Fades on its own unless you've started typing.
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (ask && !text) timer.current = window.setTimeout(close, LINGER_MS);
    return () => window.clearTimeout(timer.current);
  }, [ask?.id, !text]);
  // Focused once the click that made the change is over, so that click's own focus doesn't take it back;
  // but not from a field you've moved on to typing in, where it would swallow your keys.
  useEffect(() => {
    if (!ask) return;
    const later = window.setTimeout(() => {
      const active = document.activeElement;
      if (active === field.current) return;
      if (typingIn(active)) return;
      returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
      field.current?.focus();
    });
    return () => window.clearTimeout(later);
  }, [ask?.id]);

  if (!ask) return null;
  const left = Math.max(8, Math.min(ask.x - WIDTH / 2, window.innerWidth - WIDTH - 8));
  // Centered under the cursor, or over it when there's no room below.
  const below = ask.y + GAP + HEIGHT < window.innerHeight;
  // Closed before the reason is written, so a blur while it's saving can't save it twice.
  const save = async (restore = false) => {
    if (ended.current) return;
    const reason = text.trim();
    close(restore);
    if (reason) await db.setFeedbackReason(ask.id, reason, "user").catch(() => {});
  };
  const lessOften = (restore = false) => {
    if (ended.current) return;
    saveWhyRates(askLessOften(loadWhyRates(), ask.kind, WHY_LEVELS[loadWhyLevel()]));
    close(restore);
  };
  const atLeast = Math.max(loadWhyRates()[ask.kind]?.every ?? 1, WHY_LEVELS[loadWhyLevel()]) >= WHY_EVERY_MAX;
  // Buttons act on mouse down so the field's blur (which closes the prompt) doesn't beat them.
  const press = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    fn();
  };
  // Space dismisses and L asks less often, while nothing's typed yet: a reason can hold either.
  const shortcuts = !text;
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (ended.current) return e.preventDefault();
    const action = whyKey(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing },
      { typed: !shortcuts, canAskLess: !atLeast },
    );
    if (!action) return;
    e.preventDefault();
    // Kept inside the prompt: Esc here mustn't also close a modal or full screen behind it.
    e.stopPropagation();
    if (action === "less_often") lessOften(true);
    else close(true);
  };
  return createPortal(
    <form
      className={`why-prompt${leaving ? " leaving" : ""}`}
      style={{ left, width: WIDTH, ...(below ? { top: ask.y + GAP } : { bottom: window.innerHeight - ask.y + GAP }) }}
      onSubmit={(e) => {
        e.preventDefault();
        save(true);
      }}
    >
      <span className="why-label">{ask.label}</span>
      <input
        ref={field}
        value={text}
        placeholder="Why? (optional)"
        aria-label="Why? (optional)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => (text.trim() ? save() : close())}
      />
      <div className="why-actions">
        {!atLeast && (
          <button type="button" className="cta-ghost" aria-keyshortcuts={shortcuts ? "L" : undefined} onMouseDown={press(() => lessOften())}>
            Ask less often{shortcuts && <Kbd keys="L" />}
          </button>
        )}
        <button type="button" className="cta-ghost" aria-keyshortcuts={shortcuts ? "Space" : undefined} onMouseDown={press(() => close())}>
          Dismiss{shortcuts && <Kbd keys="Space" />}
        </button>
      </div>
    </form>,
    document.body,
  );
}
