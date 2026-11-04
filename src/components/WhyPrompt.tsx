import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as db from "../db";
import { askLessOften, loadWhyLevel, loadWhyRates, saveWhyRates, WHY_EVENT, WHY_EVERY_MAX, WHY_LEVELS, type WhyRequest } from "../feedback";

/** How long the prompt waits for a reason before fading, unless you start typing. */
const LINGER_MS = 8000;
const WIDTH = 280;

/**
 * The optional "Why?" after a correction (recordCorrection): a one-line field by where you just
 * clicked. Enter saves the reason with the correction; Dismiss, Esc, clicking away or waiting
 * leaves it, and the reason is inferred later instead. Ask less often halves how often it asks
 * about this kind of change. Mounted once, in App.
 */
export function WhyPrompt() {
  const [ask, setAsk] = useState<(WhyRequest & { x: number; y: number }) | null>(null);
  const [text, setText] = useState("");
  const [leaving, setLeaving] = useState(false);
  const pointer = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const timer = useRef(0);

  useEffect(() => {
    const track = (e: PointerEvent) => (pointer.current = { x: e.clientX, y: e.clientY });
    const show = (e: Event) => {
      const detail = (e as CustomEvent<WhyRequest>).detail;
      setText("");
      setLeaving(false);
      setAsk({ ...detail, ...pointer.current });
    };
    window.addEventListener("pointerdown", track, true);
    window.addEventListener(WHY_EVENT, show);
    return () => {
      window.removeEventListener("pointerdown", track, true);
      window.removeEventListener(WHY_EVENT, show);
    };
  }, []);

  const close = () => {
    setLeaving(true);
    window.setTimeout(() => setAsk(null), 180);
  };
  // Fades on its own unless you've started typing.
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (ask && !text) timer.current = window.setTimeout(close, LINGER_MS);
    return () => window.clearTimeout(timer.current);
  }, [ask?.id, !text]);

  if (!ask) return null;
  const left = Math.max(8, Math.min(ask.x - WIDTH / 2, window.innerWidth - WIDTH - 8));
  const below = ask.y + 18 + 64 < window.innerHeight;
  const save = async () => {
    const reason = text.trim();
    if (reason) await db.setFeedbackReason(ask.id, reason, "user").catch(() => {});
    close();
  };
  const lessOften = () => {
    saveWhyRates(askLessOften(loadWhyRates(), ask.kind, WHY_LEVELS[loadWhyLevel()]));
    close();
  };
  const atLeast = Math.max(loadWhyRates()[ask.kind]?.every ?? 1, WHY_LEVELS[loadWhyLevel()]) >= WHY_EVERY_MAX;
  // Buttons act on mouse down so the field's blur (which closes the prompt) doesn't beat them.
  const press = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    fn();
  };
  return createPortal(
    <form
      className={`why-prompt${leaving ? " leaving" : ""}`}
      style={{ left, width: WIDTH, ...(below ? { top: ask.y + 18 } : { bottom: window.innerHeight - ask.y + 18 }) }}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <span className="why-label">{ask.label}</span>
      <input
        value={text}
        placeholder="Why? (optional)"
        aria-label="Why? (optional)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && close()}
        onBlur={() => (text.trim() ? save() : close())}
      />
      <div className="why-actions">
        {!atLeast && (
          <button type="button" className="link-button small" onMouseDown={press(lessOften)}>
            Ask less often
          </button>
        )}
        <button type="button" className="link-button small" onMouseDown={press(close)}>
          Dismiss
        </button>
      </div>
    </form>,
    document.body,
  );
}
