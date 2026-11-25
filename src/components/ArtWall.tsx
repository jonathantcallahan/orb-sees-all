import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import gilt from "../assets/moulding.jpg";
import woodFloater from "../assets/floater-wood.jpg";
import darkFloater from "../assets/floater-dark.jpg";
import whiteFloater from "../assets/floater-white.jpg";
import { cardPlacement, fetchDetails, fetchPainting, fitFramed, frameForTheme, frameLayout, MOULDINGS, needsDetails, paintingDetails, storedPainting, storePainting, type FrameKind, type Painting } from "../art";
import { localDate } from "../scheduler";
import { useDarkPage } from "../theme";
import { ExternalLink, HoverTip, RefreshButton, Spinner } from "./common";

/** Each frame's moulding tile. */
const TILES: Record<FrameKind, string> = { gilt, wood: woodFloater, dark: darkFloater, white: whiteFloater };

/** Room kept for the details line under the frame and its gap. */
const LABEL_ROOM = 34;

/**
 * Room kept under the details, so the blur along the bottom of the window never reaches them: as the
 * docked chat's reply box does, the blur's height (--mist-fade-height) less its faintest 30px.
 */
function blurClear(): number {
  const fade = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--mist-fade-height"));
  return (Number.isFinite(fade) ? fade : 150) - 30;
}

/** Room kept between the frame and what's at the top of the columns. */
const GAP = 24;

/** How far the line between the columns takes to fade out above the painting, and back in below it. */
const FADE = 44;

/** The room under the details line, which is matched above the frame: enough for the frame to clear the columns' tops (`top`), and the blur. */
const room0 = (top: number | null) => Math.max((top ?? 0) + GAP - LABEL_ROOM, blurClear());

/** Loads and decodes an image, so a new painting is only hung once it can be drawn whole. */
async function preload(src: string): Promise<void> {
  const img = new Image();
  img.src = src;
  await img.decode();
}

/**
 * The painting that's up, shared by the painting in the left column and the line and ↻ in the right:
 * kept here (and in localStorage), with whether another is being found and whether finding one failed.
 */
interface Wall {
  painting: Painting | null;
  busy: boolean;
  failed: boolean;
}
let wall: Wall | null = null;
const listeners = new Set<() => void>();
const current = (): Wall => (wall ??= { painting: storedPainting(), busy: false, failed: false });
const update = (patch: Partial<Wall>) => {
  wall = { ...current(), ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const usePainting = () => useSyncExternalStore(subscribe, current);

/** Finds and hangs another painting. `quiet`: the day's change, which says nothing if it fails (the last one stays up). */
async function hangPainting(quiet = false) {
  if (current().busy) return;
  update({ busy: true, failed: false });
  try {
    const day = localDate(new Date());
    // One more try if a painting's image won't load.
    let next = await fetchPainting({ day, exclude: current().painting?.id });
    try {
      await preload(next.image);
    } catch {
      next = await fetchPainting({ day, exclude: next.id });
      await preload(next.image);
    }
    storePainting(next);
    update({ painting: next });
  } catch {
    if (!quiet || !current().painting) update({ failed: true });
  } finally {
    update({ busy: false });
  }
}

/** The left column's title while the painting is up, in place of its sections, all caught up. */
export function ArtHeading() {
  // A title's size, in the gray of "All caught up".
  return <p className="section-title caught-up art-heading">Clean inbox. Take a breath, enjoy some art.</p>;
}

/**
 * What the Updates area shows once the briefing, its updates and its inbox are all read: a painting in
 * the floater that suits the theme, hung across its two columns (`split`), over the line between them, centered in the area
 * top to bottom and sized to clear what's at the top of either, with its title (and ↻ to hang
 * another) and its painter under it. A new one is found each day.
 */
export function ArtWall({ split }: { split: HTMLElement | null }) {
  const { painting, busy, failed } = usePainting();
  // Its frame suits the theme, and changes with it.
  const frame = frameForTheme(useDarkPage());

  // The bottom of the lowest of what's at the top of either column, measured as they change: the frame
  // stays clear of it.
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!split) return;
    const measure = () => {
      const base = split.getBoundingClientRect().top;
      let bottom = 0;
      for (const child of split.querySelectorAll(":scope > .detail-pane > *")) bottom = Math.max(bottom, child.getBoundingClientRect().bottom - base);
      setTop(Math.ceil(bottom));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(split);
    split.querySelectorAll(":scope > .detail-pane > *").forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [split]);

  // None yet, or yesterday's: find one (yesterday's stays up until it's found). One kept from before
  // the museum's words about it were read has them read now, for its card.
  useEffect(() => {
    const p = current().painting;
    if (!p || p.day !== localDate(new Date())) void hangPainting(true);
    else if (needsDetails(p))
      fetchDetails(p)
        .then((full) => {
          if (current().painting?.id !== full.id) return;
          storePainting(full);
          update({ painting: full });
        })
        .catch(() => {});
  }, []);

  // The space the frame and its details can fill, measured as the pane resizes.
  const ref = useRef<HTMLElement>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Inside its padding.
    const measure = () => {
      const cs = getComputedStyle(el);
      const px = (v: string) => parseFloat(v) || 0;
      setRoom({ w: el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight), h: el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = painting && room ? fitFramed(room.w, room.h - LABEL_ROOM, painting.width / painting.height, undefined, frame) : null;

  // Where the painting and its details run, from the top of the two columns: the line between the
  // columns fades out before it reaches them and back in after. Measured again as the room changes too,
  // since the painting is centered in it and moves when it does, at the same size.
  const [span, setSpan] = useState<{ from: number; to: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const framed = el?.querySelector(".framed")?.getBoundingClientRect();
    if (!split || !framed) {
      setSpan(null);
      return;
    }
    const base = split.getBoundingClientRect().top;
    const details = el!.querySelector(".art-details")?.getBoundingClientRect();
    setSpan({ from: framed.top - base, to: (details ?? framed).bottom - base });
  }, [split, top, painting, frame, room?.w, room?.h, fit?.w, fit?.h, fit?.t]);

  return (
    <>
    {span && (
      <div
        className="art-divider"
        aria-hidden
        style={{ background: `linear-gradient(to bottom, var(--border) ${span.from - FADE - 12}px, transparent ${span.from - 12}px, transparent ${span.to + 12}px, var(--border) ${span.to + 12 + FADE}px)` }}
      />
    )}
    {/* The frame centered in the area top to bottom: as much room above it as under it, the details
        line counted in what's under it, and enough above it to clear the columns' tops (and under it
        to keep the details out of the blur along the bottom of the window). */}
    <section
      className="art-wall"
      ref={ref}
      aria-label="A painting"
      style={{ paddingTop: room0(top) + LABEL_ROOM, paddingBottom: room0(top), visibility: top === null ? "hidden" : undefined }}
    >
      {!painting && busy && <Spinner />}
      {painting && fit ? (
        <>
          {/* Clicking it opens it on the museum's site; resting on it shows its card. */}
          <PaintingCard painting={painting}>
            <ExternalLink href={painting.link} className="art-link" label={`Open ${painting.title} on the Cleveland Museum of Art's site`}>
              <FramedPainting painting={painting} kind={frame} {...fit} />
            </ExternalLink>
          </PaintingCard>
          {/* Its details under it, lined up with the painting's edges (not the frame's): the title and
              date at the left, ↻ after them to hang a new painting, the painter at the right. Short of
              room the title is cut short with "…", never the painter, and the whole line shows on hover. */}
          <div className="art-details-row" style={{ width: fit.w }}>
            <div className="art-details-work-line">
              <HoverTip text={`${paintingDetails(painting, true).work} · ${paintingDetails(painting, true).by}`} whenClipped>
                <p className="art-details art-details-work clip-text">
                  <span className="art-details-title">{painting.title}</span>
                  {painting.date && `, ${painting.date}`}
                </p>
              </HoverTip>
              <RefreshButton busy={busy} onClick={() => void hangPainting()} title="Hang a new painting" status="Finding a new painting" />
            </div>
            <p className="art-details art-details-by">{paintingDetails(painting).by}</p>
          </div>
          {failed && <span className="error small">Couldn't reach the museum just now.</span>}
        </>
      ) : (
        !painting &&
        !busy &&
        failed && (
          <p className="muted small art-error">
            Couldn't reach the museum for a painting just now.{" "}
            <button className="link-button small" onClick={() => void hangPainting()}>
              Try again
            </button>
          </p>
        )
      )}
    </section>
    </>
  );
}

/** How long the pointer rests on the painting before its card shows, so passing over it doesn't flash it. */
const CARD_DELAY_MS = 300;

/**
 * The painting's card while the pointer rests on it: the museum's words about it in Apple's glass, at
 * the painting's right, a quarter of it over the painting and the rest beside it, or further over it
 * when the window's narrow (see cardPlacement). Its title and date, its
 * painter in full, its medium and its size (each on a line), then its blurb and its "did you know" where the museum has
 * them. It lets the pointer through, so it never takes the hover from the painting.
 */
function PaintingCard({ painting, children }: { painting: Painting; children: ReactNode }) {
  const [over, setOver] = useState<DOMRect | null>(null);
  const timer = useRef(0);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  // A new painting puts it away, and so does a scroll that moves the painting: only one of what holds
  // it, not any scroll at all (the calendar beside it scrolls itself a pixel at a time as the day goes
  // on, and would put it away while you're reading it).
  useEffect(() => setOver(null), [painting.id]);
  useEffect(() => {
    if (!over) return;
    const hide = () => setOver(null);
    const scrolled = (e: Event) => {
      const t = e.target;
      if (t === document || (t instanceof Node && anchor.current && t.contains(anchor.current))) hide();
    };
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("blur", hide);
    };
  }, [over]);
  return (
    <div
      className="art-hover"
      ref={anchor}
      onMouseEnter={(e) => {
        const canvas = e.currentTarget.querySelector(".framed-canvas") ?? e.currentTarget;
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setOver(canvas.getBoundingClientRect()), CARD_DELAY_MS);
      }}
      onMouseLeave={() => {
        clearTimeout(timer.current);
        setOver(null);
      }}
    >
      {children}
      {over && createPortal(<CardBox painting={painting} over={over} />, document.body)}
    </div>
  );
}

function CardBox({ painting, over }: { painting: Painting; over: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<ReturnType<typeof cardPlacement> | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The column the painting hangs in: the Updates area's panel.
    const column = document.querySelector(".detail-panel")?.getBoundingClientRect().right;
    setPlace(cardPlacement(over, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, 12, column));
  }, [over, painting]);
  const by = paintingDetails(painting, true).by;
  return (
    <div
      ref={ref}
      className={`art-card${place ? ` on-${place.side}` : ""}`}
      role="tooltip"
      style={place ? { left: place.left, top: place.top } : { left: -9999, top: 0, visibility: "hidden" }}
    >
      <p className="art-card-title">
        {painting.title}
        {painting.date && <span className="art-card-date">, {painting.date}</span>}
      </p>
      <p className="art-card-by">{by}</p>
      {painting.medium && <p className="art-card-medium">{painting.medium[0].toUpperCase() + painting.medium.slice(1)}</p>}
      {painting.size && <p className="art-card-medium">{painting.size}</p>}
      {painting.blurb && <p className="art-card-blurb">{painting.blurb}</p>}
      {painting.fact && (
        <p className="art-card-fact">
          <span className="art-card-fact-label">Did you know? </span>
          {painting.fact}
        </p>
      )}
    </div>
  );
}

/**
 * A painting w×h in its frame, t all round (see frameLayout): four lengths of the frame's moulding,
 * each mitered at the corners and turned so its outer edge faces out. The gilt frame's joints show by
 * the light falling differently on each side, and its sight edge's shadow falls on the painting. In a floater the painting floats in front, in a gap filled with shadow, its edges rolling
 * away as a canvas does over its stretcher.
 */
function FramedPainting({ painting, kind, w, h, t }: { painting: Painting; kind: FrameKind; w: number; h: number; t: number }) {
  const floater = kind !== "gilt";
  const { moulding: m, over } = frameLayout(kind, w, h);
  const W = w + 2 * t;
  const H = h + 2 * t;
  const tile = Math.round((MOULDINGS[kind].width * m) / MOULDINGS[kind].height);
  // Each side is a length of moulding laid along the top edge, then turned into place; its ends are
  // cut at 45° where they meet. Light from straight above: the gilt moulding's sloping sides catch it
  // unevenly, its two sides a little darker than its top and its bottom darker still; a floater's
  // flat face, square to the light, doesn't.
  const side = (length: number, shade: number, place: CSSProperties): CSSProperties => ({
    width: length,
    height: m,
    backgroundImage: `linear-gradient(rgba(0, 0, 0, ${floater ? 0 : shade}), rgba(0, 0, 0, ${floater ? 0 : shade})), url(${TILES[kind]})`,
    backgroundSize: `100% 100%, ${tile}px ${m}px`,
    backgroundRepeat: "no-repeat, repeat-x",
    clipPath: `polygon(0 0, 100% 0, calc(100% - ${m}px) 100%, ${m}px 100%)`,
    ...place,
  });
  return (
    <div className={`framed framed-${kind}${floater ? " framed-floater" : ""}`} style={{ width: W, height: H }}>
      <div className="framed-side" style={side(W, 0, { left: 0, top: 0 })} />
      <div className="framed-side" style={side(H, 0.06, { left: W, top: 0, transformOrigin: "0 0", transform: "rotate(90deg)" })} />
      <div className="framed-side" style={side(W, 0.16, { left: 0, top: H - m, transform: "rotate(180deg)" })} />
      <div className="framed-side" style={side(H, 0.06, { left: 0, top: H, transformOrigin: "0 0", transform: "rotate(-90deg)" })} />
      {floater && <div className="framed-gap" style={{ inset: m }} />}
      {/* The canvas runs `over` past the moulding's inner edge, under the gilt lip. Decoded before it's
          hung (see hangPainting), so drawing it at once costs nothing and it never shows half there. */}
      <div className="framed-canvas" style={{ left: t - over, top: t - over, width: w + 2 * over, height: h + 2 * over }}>
        <img src={painting.image} alt={painting.artist ? `${painting.title}, by ${painting.artist}` : painting.title} decoding="sync" draggable={false} />
      </div>
    </div>
  );
}
