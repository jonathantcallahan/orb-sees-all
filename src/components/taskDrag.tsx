/**
 * Dragging tasks to reorder them, within Today and All tasks or from one to the other, with the
 * motion people expect from native apps:
 * - a press becomes a drag only after a few pixels, so clicks, selection and menus still work;
 * - the card lifts (a copy of its header scales up, tilts a hair and gains a deep shadow) and follows
 *   the pointer;
 * - the cards under the pointer slide apart to open a gap the card's size where it would land, and the
 *   list it left closes up behind it, so where it'll go is always visible;
 * - on drop the card settles into the gap and anything that moved glides to its new place (FLIP);
 *   a drop outside the lists, or Escape, glides it back home.
 * Pointer-based rather than native HTML drag, whose ghost image can't be styled or animated.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type DropZoneId = "today" | "rest";

/**
 * Runs a state change that moves cards and animates every card from where it was to where it lands.
 * Given to the drop handler for later changes it makes (a task settling into its sorted place).
 */
export type Flip = (change: () => void) => void;

/** Movement before a press counts as a drag. */
const DRAG_THRESHOLD = 4;
/** The lifted look the drop glide starts from. */
const LIFT_SCALE = 1.03;
const LIFT_SHADOW = "0 18px 40px rgb(0 0 0 / 0.22), 0 4px 10px rgb(0 0 0 / 0.12)";
const SETTLE_MS = 340;
const GLIDE_MS = 280;
const RETURN_MS = 240;
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A card in a list, as it sat when the drag started. */
interface Slot {
  id: string;
  el: HTMLElement;
  top: number;
  bottom: number;
}

interface Drag {
  id: string;
  from: DropZoneId;
  over: DropZoneId | null;
  /** Where it would land: before this card, or at the end of the list (null). */
  before: string | null;
  origin: DOMRect;
  grabX: number;
  grabY: number;
  header: HTMLElement;
}

/** Where every card was just before a change, so each can glide from there to its new place. */
interface Settle {
  rects: Map<string, DOMRect>;
  /** The dropped card, which settles from its lifted copy instead. */
  dropped?: { id: string; rect: DOMRect };
  done: Set<string>;
}

interface DragApi {
  draggingId: string | null;
  over: DropZoneId | null;
  settle: Settle | null;
  press: (e: React.PointerEvent, id: string, zone: DropZoneId, card: HTMLElement) => void;
}

const DragContext = createContext<DragApi | null>(null);
const ZoneContext = createContext<DropZoneId>("rest");

const cardsIn = (zone: DropZoneId): Slot[] =>
  [...document.querySelectorAll<HTMLElement>(`.task-card[data-zone="${zone}"]`)].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.taskId!, el, top: r.top, bottom: r.bottom };
  });

/** Every card's on-screen box, transforms included. */
const snapshot = () => new Map([...document.querySelectorAll<HTMLElement>(".task-card[data-task-id]")].map((el) => [el.dataset.taskId!, el.getBoundingClientRect()]));

/** Wraps the Tasks column; `onDrop` puts a task in a list, before `before` (or at the end). */
export function TaskDragProvider({
  onDrop,
  children,
}: {
  onDrop: (id: string, to: DropZoneId, before: string | null, flip: Flip) => Promise<void>;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [settle, setSettle] = useState<Settle | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const pending = useRef<{ x: number; y: number; id: string; zone: DropZoneId; card: HTMLElement } | null>(null);
  const slots = useRef<Record<DropZoneId, Slot[]>>({ today: [], rest: [] });
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const flip: Flip = useCallback((change) => {
    setSettle(reducedMotion() ? null : { rects: snapshot(), done: new Set() });
    change();
  }, []);
  // A settle only matters for the render right after it.
  useEffect(() => {
    if (!settle) return;
    const t = setTimeout(() => setSettle(null), SETTLE_MS + 50);
    return () => clearTimeout(t);
  }, [settle]);

  const place = () => {
    const d = dragRef.current;
    if (d && preview.current) preview.current.style.transform = `translate(${pointer.current.x - d.grabX}px, ${pointer.current.y - d.grabY}px)`;
  };

  const zoneAt = (x: number, y: number): DropZoneId | null =>
    ((document.elementFromPoint(x, y)?.closest("[data-drop-zone]") as HTMLElement | null)?.dataset.dropZone as DropZoneId | undefined) ?? null;

  /**
   * Opens the gap where the card would land and closes the one it left, by sliding the other cards;
   * returns the card it would land before. Positions come from the drag's start, so the gap moving
   * doesn't feed back into where the pointer is.
   */
  const shift = (d: Drag, over: DropZoneId | null, y: number): string | null => {
    const source = [...slots.current.today, ...slots.current.rest].find((s) => s.id === d.id);
    const size = (source ? source.bottom - source.top : 0) + gapOf(slots.current[d.from], d.id);
    let before: string | null = null;
    for (const zone of ["today", "rest"] as DropZoneId[]) {
      const list = slots.current[zone];
      const s = list.findIndex((x) => x.id === d.id);
      const others = list.filter((x) => x.id !== d.id);
      // With the dragged card lifted out, cards below it in its own list move up into its place.
      const base = (x: Slot) => x.top - (s >= 0 && list.indexOf(x) > s ? size : 0);
      let t = -1;
      if (zone === over) {
        t = others.findIndex((x) => y < base(x) + (x.bottom - x.top) / 2);
        if (t < 0) t = others.length;
        before = others[t]?.id ?? null;
      }
      others.forEach((x, k) => {
        const dy = base(x) - x.top + (t >= 0 && k >= t ? size : 0);
        x.el.style.transform = dy ? `translateY(${dy}px)` : "";
      });
    }
    return before;
  };

  const clearShifts = (animate: boolean) => {
    for (const s of [...slots.current.today, ...slots.current.rest]) {
      if (!animate) s.el.style.transition = "none";
      s.el.style.transform = "";
      if (!animate) requestAnimationFrame(() => (s.el.style.transition = ""));
    }
  };

  const end = useCallback(
    async (cancelled: boolean) => {
      const d = dragRef.current;
      pending.current = null;
      if (!d) return;
      // The click that ends a drag shouldn't also open the card under it.
      const swallow = (e: MouseEvent) => e.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      const to = cancelled ? null : d.over;
      const src = slots.current[d.from];
      const s = src.findIndex((x) => x.id === d.id);
      const unchanged = to === d.from && (d.before === null ? s === src.length - 1 : src[s + 1]?.id === d.before);
      if (to && !unchanged) {
        // Every card glides from where it shows now (gaps and all) to its new place; the dropped card
        // settles in from its lifted copy.
        const rects = snapshot();
        const lifted = preview.current?.firstElementChild?.getBoundingClientRect() ?? d.origin;
        clearShifts(false);
        document.body.classList.remove("task-dragging");
        setSettle(reducedMotion() ? null : { rects, dropped: { id: d.id, rect: lifted }, done: new Set() });
        setDrag(null);
        await onDrop(d.id, to, d.before, flip).catch(() => {});
        return;
      }
      // Nothing changes: the gaps close and the lifted copy glides back home.
      clearShifts(true);
      document.body.classList.remove("task-dragging");
      const el = preview.current;
      if (el && !reducedMotion()) {
        el.style.transition = `transform ${RETURN_MS}ms ${EASE_OUT}`;
        el.style.transform = `translate(${d.origin.left}px, ${d.origin.top}px)`;
        el.firstElementChild?.classList.add("returning");
        await new Promise((r) => setTimeout(r, RETURN_MS));
      }
      setDrag(null);
    },
    [onDrop, flip],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      const p = pending.current;
      if (p && !dragRef.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
        slots.current = { today: cardsIn("today"), rest: cardsIn("rest") };
        const origin = p.card.getBoundingClientRect();
        const header = (p.card.querySelector(".task-card-header") ?? p.card).cloneNode(true) as HTMLElement;
        document.body.classList.add("task-dragging");
        window.getSelection()?.removeAllRanges();
        const d: Drag = { id: p.id, from: p.zone, over: p.zone, before: null, origin, grabX: p.x - origin.left, grabY: p.y - origin.top, header };
        d.before = shift(d, p.zone, e.clientY);
        setDrag(d);
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      place();
      const over = zoneAt(e.clientX, e.clientY);
      const before = shift(d, over, e.clientY);
      if (over !== d.over || before !== d.before) setDrag({ ...d, over, before });
    };
    const onUp = () => {
      if (dragRef.current) end(false);
      else pending.current = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) end(true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [end]);

  // Put the preview under the pointer as soon as it mounts, and drop the header copy into it.
  useLayoutEffect(() => {
    const el = preview.current;
    if (!drag || !el) return;
    const card = el.firstElementChild as HTMLElement;
    if (!card.firstChild) card.appendChild(drag.header);
    place();
  }, [drag?.id]);

  const api: DragApi = {
    draggingId: drag?.id ?? null,
    over: drag && drag.over !== drag.from ? drag.over : null,
    settle,
    press: (e, id, zone, card) => {
      if (e.button !== 0 || dragRef.current) return;
      // Typing, picking from a menu or pressing a button never starts a drag.
      if ((e.target as HTMLElement).closest("input, textarea, select, button, a, [contenteditable]")) return;
      pending.current = { x: e.clientX, y: e.clientY, id, zone, card };
      pointer.current = { x: e.clientX, y: e.clientY };
    },
  };

  return (
    <DragContext.Provider value={api}>
      {children}
      {drag &&
        createPortal(
          <div ref={preview} className="task-drag-preview" style={{ width: drag.origin.width }} aria-hidden>
            <article className={`card task-card drag-lifted${reducedMotion() ? " still" : ""}`} />
          </div>,
          document.body,
        )}
    </DragContext.Provider>
  );
}

/**
 * The space between two cards (for sizing the gap a dragged card opens): the dragged card's own
 * list's spacing, read from its container's CSS rather than measured, since neighbors measured
 * across two groups would count the heading between them.
 */
function gapOf(list: Slot[], id: string): number {
  const el = list.find((s) => s.id === id)?.el.parentElement;
  const gap = el ? parseFloat(getComputedStyle(el).rowGap) : NaN;
  return Number.isFinite(gap) ? gap : 10;
}

/** A place tasks can be dropped; it lights up while a task from the other list is over it. */
export function DropZone({ zone, className, children }: { zone: DropZoneId; className?: string; children: ReactNode }) {
  const api = useContext(DragContext);
  const Tag = zone === "rest" ? "section" : "div";
  return (
    <ZoneContext.Provider value={zone}>
      <Tag data-drop-zone={zone} className={`${className ?? ""}${api?.over === zone ? " drop" : ""}`}>
        {children}
      </Tag>
    </ZoneContext.Provider>
  );
}

/**
 * Makes a task card draggable. Spread `attrs` on the card: its pointer handler, its place for the
 * drag to find it, and its drag class (hidden while lifted, since the gap shows where it'll go).
 * After a drop or reorder the card glides from its old place to its new one.
 */
export function useTaskDrag(id: string, card: React.RefObject<HTMLElement | null>) {
  const api = useContext(DragContext);
  const zone = useContext(ZoneContext);
  const settle = api?.settle;

  useLayoutEffect(() => {
    const el = card.current;
    if (!settle || !el || settle.done.has(id)) return;
    settle.done.add(id);
    const dropped = settle.dropped?.id === id;
    const from = dropped ? settle.dropped!.rect : settle.rects.get(id);
    if (!from) return;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (!dropped && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate(
      dropped
        ? [
            { transform: `translate(${dx}px, ${dy}px) scale(${LIFT_SCALE})`, boxShadow: LIFT_SHADOW, zIndex: 20 },
            { transform: "none", boxShadow: getComputedStyle(el).boxShadow, zIndex: 20 },
          ]
        : [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
      { duration: dropped ? SETTLE_MS : GLIDE_MS, easing: EASE_OUT },
    );
  }, [settle]);

  return {
    attrs: {
      onPointerDown: (e: React.PointerEvent) => card.current && api?.press(e, id, zone, card.current),
      "data-task-id": id,
      "data-zone": zone,
    },
    className: api?.draggingId === id ? " drag-source" : "",
  };
}
