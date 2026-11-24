import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import moulding from "../assets/moulding.jpg";
import { fetchPainting, fitFramed, MOULDING, storedPainting, storePainting, type Painting } from "../art";
import { localDate } from "../scheduler";
import { ExternalLink, RefreshButton, Spinner } from "./common";

/** Room kept under the frame for its label: the gap above it and two lines. */
const LABEL_ROOM = 64;

/** Loads and decodes an image, so a new painting is only hung once it can be drawn whole. */
async function preload(src: string): Promise<void> {
  const img = new Image();
  img.src = src;
  await img.decode();
}

/**
 * What the Updates area shows once its updates and inbox are both clear: a painting in a gilt frame,
 * sized to the space left, with its museum label and ↻ to hang another. A new one is found each day.
 */
export function ArtWall() {
  const [painting, setPainting] = useState<Painting | null>(storedPainting);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = useRef(painting);
  current.current = painting;

  /** Finds and hangs another painting. `quiet`: the day's change, which says nothing if it fails (the last one stays up). */
  const hang = async (quiet = false) => {
    setBusy(true);
    setFailed(false);
    try {
      const day = localDate(new Date());
      // One more try if a painting's image won't load.
      let next = await fetchPainting({ day, exclude: current.current?.id });
      try {
        await preload(next.image);
      } catch {
        next = await fetchPainting({ day, exclude: next.id });
        await preload(next.image);
      }
      storePainting(next);
      setPainting(next);
    } catch {
      if (!quiet || !current.current) setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  // None yet, or yesterday's: find one (yesterday's stays up until it's found).
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    if (!painting || painting.day !== localDate(new Date())) void hang(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The space the frame and its label can fill, measured as the pane resizes.
  const wall = useRef<HTMLElement>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = wall.current;
    if (!el) return;
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = painting && room ? fitFramed(room.w, room.h - LABEL_ROOM, painting.width / painting.height) : null;

  return (
    <section className="art-wall" ref={wall} aria-label="A painting">
      {painting && fit && <FramedPainting painting={painting} {...fit} />}
      {!painting && busy && <Spinner />}
      {painting && fit ? (
        <div className="art-label" style={{ maxWidth: fit.w + 2 * fit.t }}>
          <div className="art-label-text">
            <span>
              <ExternalLink href={painting.link} className="art-title" title="Open it on the Cleveland Museum of Art's site">
                {painting.title}
              </ExternalLink>
              {painting.date && <span className="muted art-date">, {painting.date}</span>}
            </span>
            <span className="muted small">{painting.artist ?? "Artist unknown"}</span>
            {failed && <span className="error small">Couldn't reach the museum just now.</span>}
          </div>
          <RefreshButton busy={busy} onClick={() => void hang()} title="Hang another painting" status="Finding another painting" />
        </div>
      ) : (
        !painting &&
        !busy &&
        failed && (
          <p className="muted small art-label">
            Couldn't reach the museum for a painting just now.{" "}
            <button className="link-button small" onClick={() => void hang()}>
              Try again
            </button>
          </p>
        )
      )}
    </section>
  );
}

/**
 * A painting w×h in a frame t wide: four lengths of the moulding, each mitered at the corners and
 * turned so its ornate edge faces out, with the sight edge's shadow falling on the painting.
 */
function FramedPainting({ painting, w, h, t }: { painting: Painting; w: number; h: number; t: number }) {
  const W = w + 2 * t;
  const H = h + 2 * t;
  const tile = Math.round((MOULDING.width * t) / MOULDING.height);
  // Each side is a length of moulding laid along the top edge, then turned into place; its ends are
  // cut at 45° where they meet. Light from above and the left: the bottom and right fall darker.
  const side = (length: number, shade: number, place: CSSProperties): CSSProperties => ({
    width: length,
    height: t,
    backgroundImage: `linear-gradient(rgba(0, 0, 0, ${shade}), rgba(0, 0, 0, ${shade})), url(${moulding})`,
    backgroundSize: `100% 100%, ${tile}px ${t}px`,
    backgroundRepeat: "no-repeat, repeat-x",
    clipPath: `polygon(0 0, 100% 0, calc(100% - ${t}px) 100%, ${t}px 100%)`,
    ...place,
  });
  return (
    <div className="framed" style={{ width: W, height: H }}>
      {/* The painting runs a pixel under the frame's lip all round, so no gap shows at its edges. */}
      <div className="framed-canvas" style={{ left: t - 1, top: t - 1, width: w + 2, height: h + 2 }}>
        {/* Decoded before it's hung (see hang), so drawing it at once costs nothing and it never
            shows half there. */}
        <img src={painting.image} alt={painting.artist ? `${painting.title}, by ${painting.artist}` : painting.title} decoding="sync" draggable={false} />
      </div>
      <div className="framed-side" style={side(W, 0, { left: 0, top: 0 })} />
      <div className="framed-side" style={side(H, 0.08, { left: W, top: 0, transformOrigin: "0 0", transform: "rotate(90deg)" })} />
      <div className="framed-side" style={side(W, 0.16, { left: 0, top: H - t, transform: "rotate(180deg)" })} />
      <div className="framed-side" style={side(H, 0.04, { left: 0, top: H, transformOrigin: "0 0", transform: "rotate(-90deg)" })} />
      {/* The joints. */}
      <svg className="framed-miters" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
        <path d={`M0 0L${t} ${t}M${W} 0L${W - t} ${t}M${W} ${H}L${W - t} ${H - t}M0 ${H}L${t} ${H - t}`} />
      </svg>
    </div>
  );
}
