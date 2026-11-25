import { z } from "zod";

/**
 * The painting the Updates area hangs when both its lists are clear: a public-domain painting from
 * the Cleveland Museum of Art's Open Access API (no key, CC0 images), in a gilt frame cut from a
 * photo of moulding. Kept pure apart from `fetchPainting`, so it can be tested.
 */

/**
 * The frames: gilt, and wooden, dark and white floaters (see MOULDINGS). For now a painting hangs in
 * the floater that suits the theme (frameForTheme); the gilt and wooden ones are kept for later.
 */
export const FRAMES = ["gilt", "wood", "dark", "white"] as const;
export type FrameKind = (typeof FRAMES)[number];

/** The frame for the theme showing: the white floater in the light theme, the dark one in the dark. */
export const frameForTheme = (dark: boolean): FrameKind => (dark ? "dark" : "white");

/** One painting, as shown and as kept between launches. */
export const Painting = z.object({
  id: z.number(),
  title: z.string(),
  /** "Claude Monet (French, 1840–1926)", as the museum writes it. */
  artist: z.string().nullable(),
  date: z.string().nullable(),
  image: z.string().url(),
  width: z.number().positive(),
  height: z.number().positive(),
  /** Its page on the museum's site. */
  link: z.string().nullable(),
  /** The local day it was hung: a new one is found the next day. */
  day: z.string(),
  /**
   * The museum's words about it, for its card on hover: its blurb, a "did you know", its medium ("oil
   * on canvas") and its size ("175 x 106 cm", unframed, in metric). Null when the museum has
   * none; missing on one kept from before they were read (see needsDetails).
   */
  blurb: z.string().nullish(),
  fact: z.string().nullish(),
  medium: z.string().nullish(),
  size: z.string().nullish(),
});
export type Painting = z.infer<typeof Painting>;

/** The museum's painting departments whose works suit a gilt frame, with about how many CC0 paintings each has. */
export const DEPARTMENTS = [
  { name: "European Painting and Sculpture", count: 310 },
  { name: "Modern European Painting and Sculpture", count: 321 },
  { name: "American Painting and Sculpture", count: 243 },
] as const;

/** A department, by weight of how many paintings it has, for `r` in [0, 1). */
export function pickDepartment(r: number): (typeof DEPARTMENTS)[number] {
  const total = DEPARTMENTS.reduce((s, d) => s + d.count, 0);
  let at = r * total;
  for (const d of DEPARTMENTS) {
    if (at < d.count) return d;
    at -= d.count;
  }
  return DEPARTMENTS[DEPARTMENTS.length - 1];
}

const API = "https://openaccess-api.clevelandart.org/api/artworks/";

/** The search for the `skip`th CC0 painting with an image in a department. */
export function searchUrl(department: string, skip: number): string {
  const q = new URLSearchParams({ type: "Painting", has_image: "1", cc0: "1", department, limit: "1", skip: String(Math.max(0, Math.floor(skip))) });
  return `${API}?${q}`;
}

const Artwork = z.object({
  id: z.number(),
  title: z.string(),
  creation_date: z.string().nullish(),
  url: z.string().nullish(),
  description: z.string().nullish(),
  did_you_know: z.string().nullish(),
  technique: z.string().nullish(),
  measurements: z.string().nullish(),
  creators: z.array(z.object({ description: z.string().nullish() })).nullish(),
  images: z
    .object({ web: z.object({ url: z.string().url(), width: z.coerce.number().positive(), height: z.coerce.number().positive() }).nullish() })
    .nullish(),
});

const Search = z.object({ info: z.object({ total: z.number() }), data: z.array(z.unknown()) });

/** The museum's text as plain words: its few tags (<em>, <i>, <br>) and entities taken out, its spaces tidied. Null when empty. */
export function plainText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/**
 * A painting's size from the museum's measurements ("Framed: 199 x 133 cm (…); Unframed: 175 x 106 cm
 * (…)"): the canvas, unframed, in metric alone ("175 x 106 cm"), without its label or its inches; else
 * the first one given.
 */
export function sizeFrom(measurements: string | null | undefined): string | null {
  const parts = (plainText(measurements) ?? "").split(";").map((m) => m.trim()).filter(Boolean);
  const part = parts.find((m) => /^unframed:/i.test(m)) ?? parts[0];
  return part ? part.replace(/^[a-z ]+:\s*/i, "").replace(/\s*\([^()]*\bin\.?\)\s*$/i, "").trim() || null : null;
}

/** An artwork's words for its card (see Painting). */
const detailsOf = (a: z.infer<typeof Artwork>) => ({
  blurb: plainText(a.description),
  fact: plainText(a.did_you_know),
  medium: plainText(a.technique),
  size: sizeFrom(a.measurements),
});

/** A search result's artwork as a painting, or null without a web image or a title. */
export function paintingFrom(raw: unknown, day: string): Painting | null {
  const a = Artwork.safeParse(raw);
  if (!a.success || !a.data.images?.web || !a.data.title.trim()) return null;
  const web = a.data.images.web;
  return {
    id: a.data.id,
    title: a.data.title.trim(),
    artist: a.data.creators?.find((c) => c.description?.trim())?.description?.trim() ?? null,
    date: a.data.creation_date?.trim() || null,
    image: web.url,
    width: web.width,
    height: web.height,
    link: a.data.url ?? null,
    day,
    ...detailsOf(a.data),
  };
}

/** A painting kept from before its words were read: they're read once, by its id (see fetchDetails). */
export const needsDetails = (p: Painting) => p.blurb === undefined || p.size === undefined;

/** A painting with its words from the museum, read by its id. */
export async function fetchDetails(
  p: Painting,
  get = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`The museum answered ${r.status}`)))),
): Promise<Painting> {
  const a = Artwork.parse(z.object({ data: z.unknown() }).parse(await get(`${API}${p.id}`)).data);
  return { ...p, ...detailsOf(a) };
}

/**
 * Where a painting's card goes, in the window: always at the painting's right, a quarter of it over the
 * painting's right edge and the rest beside it; where there isn't room for that, shifted left, further
 * over the painting, until it fits. Its right edge stays inside the column the painting hangs in (its
 * right edge, `column`), as far in from it as the column is from the window's right edge (and at least
 * `margin`). Level with the painting's middle, kept in the window.
 */
export function cardPlacement(
  painting: { left: number; top: number; right: number; bottom: number },
  card: { width: number; height: number },
  view: { width: number; height: number },
  margin = 12,
  column: number = view.width,
): { left: number; top: number; side: "right" } {
  const top = Math.max(margin, Math.min((painting.top + painting.bottom) / 2 - card.height / 2, view.height - margin - card.height));
  const edge = Math.min(view.width, column) - Math.max(margin, view.width - column);
  const left = Math.max(margin, Math.min(painting.right - card.width / 4, edge - card.width));
  return { left, top, side: "right" };
}

/**
 * A painting's details for the line under it: the work ("Title, date") and the painter, by name alone
 * or, `full`, with the museum's nationality and years, as "Claude Monet (French, 1840–1926)".
 */
export function paintingDetails(p: Pick<Painting, "title" | "date" | "artist">, full = false): { work: string; by: string } {
  const by = p.artist && !full ? p.artist.replace(/\s*\([^()]*\)\s*$/, "") : p.artist;
  return { work: p.date ? `${p.title}, ${p.date}` : p.title, by: by || "Artist unknown" };
}

/** Not a scroll or a long panorama: those look odd in a gilt frame. */
export const fitsAFrame = (width: number, height: number) => width / height >= 0.45 && width / height <= 2.2;

/**
 * A random painting, other than `exclude`. Picks a department by its size and a random place in it;
 * if the department has shrunk past that place, picks again within what it has.
 */
export async function fetchPainting({
  day,
  exclude,
  random = Math.random,
  get = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`The museum answered ${r.status}`)))),
}: {
  day: string;
  exclude?: number;
  random?: () => number;
  get?: (url: string) => Promise<unknown>;
}): Promise<Painting> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const dept = pickDepartment(random());
    let found = Search.parse(await get(searchUrl(dept.name, random() * dept.count)));
    if (!found.data.length && found.info.total > 0) found = Search.parse(await get(searchUrl(dept.name, random() * found.info.total)));
    const p = found.data.length ? paintingFrom(found.data[0], day) : null;
    if (p && p.id !== exclude && fitsAFrame(p.width, p.height)) return p;
  }
  throw new Error("No painting found");
}

/**
 * The frames' moulding tiles in src/assets, each with the outer edge on top: the gilt one's ornate
 * edge over its beaded sight edge; each floater's face, out to its lip, the frame's back inside it
 * left out (it's drawn in shadow; see frameLayout).
 */
export const MOULDINGS: Record<FrameKind, { width: number; height: number }> = {
  gilt: { width: 770, height: 177 },
  wood: { width: 820, height: 16 },
  dark: { width: 330, height: 51 },
  white: { width: 600, height: 23 },
};

/**
 * Each floater's face, as a share of the painting's size, and the strip of the frame's back that
 * shows in shadow between it and the canvas, as a share of the face. A floater is thin, a sliver
 * beside the canvas: about 1% of the painting's size, the dark one a touch broader.
 */
const FLOATERS: Record<Exclude<FrameKind, "gilt">, { face: number; gap: number }> = {
  wood: { face: 0.009, gap: 0.6 },
  dark: { face: 0.011, gap: 0.6 },
  white: { face: 0.009, gap: 0.6 },
};

/** A painting's size, the square root of its area, so a long painting's frame isn't thin. */
const sizeOf = (w: number, h: number) => Math.sqrt(Math.max(0, w) * Math.max(0, h));
const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)));

/** How wide the gilt frame is for a painting shown at w×h: a moulding about 7.5% of its size, as a framer would choose. */
export function frameWidth(w: number, h: number): number {
  return clamp(0.075 * sizeOf(w, h), 12, 40);
}

/**
 * How a frame sits around a painting shown at w×h: how wide its moulding is drawn, the gap between the
 * moulding and the canvas, and how far the canvas runs past the moulding's inner edge. The gilt
 * frame's canvas runs a pixel under its lip, so no gap shows at its edges; a floater's canvas sits
 * flush against the frame's back, a strip of it showing in shadow inside the face.
 */
export function frameLayout(kind: FrameKind, w: number, h: number): { moulding: number; gap: number; over: number } {
  if (kind === "gilt") return { moulding: frameWidth(w, h), gap: 0, over: 1 };
  const f = FLOATERS[kind];
  const face = clamp(f.face * sizeOf(w, h), 3, 10);
  return { moulding: face, gap: Math.max(3, Math.round(face * f.gap)), over: 0 };
}

/** All a frame takes around a painting shown at w×h: its moulding and any gap. */
export function frameBorder(kind: FrameKind, w: number, h: number): number {
  const { moulding, gap } = frameLayout(kind, w, h);
  return moulding + gap;
}

/**
 * The painting's size and all its frame takes around it (`t`) to fill a space of roomW×roomH, frame
 * included, keeping the painting's shape, its longer side at most `maxSide`. Null when there isn't
 * room for it.
 */
export function fitFramed(roomW: number, roomH: number, aspect: number, maxSide = 760, kind: FrameKind = "gilt"): { w: number; h: number; t: number } | null {
  const cap = aspect >= 1 ? maxSide : maxSide * aspect;
  const size = (t: number) => {
    const w = Math.max(0, Math.min(roomW - 2 * t, (roomH - 2 * t) * aspect, cap));
    return { w, h: w / aspect };
  };
  let t = 0;
  for (let i = 0; i < 4; i++) {
    const { w, h } = size(t);
    t = frameBorder(kind, w, h);
  }
  const { w, h } = size(t);
  if (Math.min(w, h) < 60) return null;
  // A hair added before rounding down, so a float error (439.9999…) doesn't cost a pixel.
  return { w: Math.floor(w + 1e-6), h: Math.floor(h + 1e-6), t };
}

const STORE = "art:painting";

/** The painting kept from last time, if any. */
export function storedPainting(): Painting | null {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const p = Painting.safeParse(JSON.parse(raw));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export function storePainting(p: Painting): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(p));
  } catch {
    // Kept for this launch only.
  }
}
