import { z } from "zod";

/**
 * The painting the Updates area hangs when both its lists are clear: a public-domain painting from
 * the Cleveland Museum of Art's Open Access API (no key, CC0 images), in a gilt frame cut from a
 * photo of moulding. Kept pure apart from `fetchPainting`, so it can be tested.
 */

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
  creators: z.array(z.object({ description: z.string().nullish() })).nullish(),
  images: z
    .object({ web: z.object({ url: z.string().url(), width: z.coerce.number().positive(), height: z.coerce.number().positive() }).nullish() })
    .nullish(),
});

const Search = z.object({ info: z.object({ total: z.number() }), data: z.array(z.unknown()) });

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
  };
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

/** The moulding tile in src/assets: its outer (ornate) edge on top, the beaded sight edge below. */
export const MOULDING = { width: 770, height: 177 } as const;

/**
 * How wide the frame is for a painting shown at w×h: a moulding about 7.5% of the painting's size
 * (the square root of its area, so a long painting's frame isn't thin), as a framer would choose.
 */
export function frameWidth(w: number, h: number): number {
  return Math.round(Math.min(40, Math.max(12, 0.075 * Math.sqrt(Math.max(0, w) * Math.max(0, h)))));
}

/**
 * The painting's size and its frame's width to fill a space of roomW×roomH, frame included, keeping
 * the painting's shape, its longer side at most `maxSide`. Null when there isn't room for it.
 */
export function fitFramed(roomW: number, roomH: number, aspect: number, maxSide = 440): { w: number; h: number; t: number } | null {
  const cap = aspect >= 1 ? maxSide : maxSide * aspect;
  const size = (t: number) => {
    const w = Math.max(0, Math.min(roomW - 2 * t, (roomH - 2 * t) * aspect, cap));
    return { w, h: w / aspect };
  };
  let t = 0;
  for (let i = 0; i < 4; i++) {
    const { w, h } = size(t);
    t = frameWidth(w, h);
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
