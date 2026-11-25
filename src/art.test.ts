import { describe, expect, it } from "vitest";
import { cardPlacement, sizeFrom, DEPARTMENTS, fetchDetails, fetchPainting, fitFramed, fitsAFrame, frameBorder, frameForTheme, frameLayout, frameWidth, needsDetails, Painting, paintingDetails, paintingFrom, pickDepartment, plainText, searchUrl } from "./art";

const artwork = (over: Record<string, unknown> = {}) => ({
  id: 101,
  title: " Water Lilies ",
  creation_date: "c. 1915–26",
  url: "https://clevelandart.org/art/1960.81",
  creators: [{ description: "Claude Monet (French, 1840–1926)" }],
  images: { web: { url: "https://openaccess-cdn.clevelandart.org/1960.81/1960.81_web.jpg", width: "893", height: "600" } },
  ...over,
});

describe("pickDepartment", () => {
  it("weighs departments by how many paintings they have", () => {
    expect(pickDepartment(0).name).toBe(DEPARTMENTS[0].name);
    const total = DEPARTMENTS.reduce((s, d) => s + d.count, 0);
    expect(pickDepartment((DEPARTMENTS[0].count + 1) / total).name).toBe(DEPARTMENTS[1].name);
    expect(pickDepartment(0.999999).name).toBe(DEPARTMENTS[2].name);
  });
});

describe("searchUrl", () => {
  it("asks for one CC0 painting with an image, at a whole-number place", () => {
    const u = new URL(searchUrl("American Painting and Sculpture", 12.7));
    expect(u.origin).toBe("https://openaccess-api.clevelandart.org");
    expect(Object.fromEntries(u.searchParams)).toEqual({ type: "Painting", has_image: "1", cc0: "1", department: "American Painting and Sculpture", limit: "1", skip: "12" });
  });
});

describe("paintingFrom", () => {
  it("reads the title, artist, date, web image and its size", () => {
    expect(paintingFrom(artwork(), "2026-11-24")).toEqual({
      id: 101,
      title: "Water Lilies",
      artist: "Claude Monet (French, 1840–1926)",
      date: "c. 1915–26",
      image: "https://openaccess-cdn.clevelandart.org/1960.81/1960.81_web.jpg",
      width: 893,
      height: 600,
      link: "https://clevelandart.org/art/1960.81",
      day: "2026-11-24",
      blurb: null,
      fact: null,
      medium: null,
      size: null,
    });
  });

  it("reads the museum's words about it as plain text", () => {
    const p = paintingFrom(artwork({ description: "Monet painted <em>water lilies</em> at Giverny&nbsp;&amp; kept at it.<br/>For years.", did_you_know: " He had cataracts. ", technique: "oil on canvas" }), "d");
    expect(p).toMatchObject({ blurb: "Monet painted water lilies at Giverny & kept at it. For years.", fact: "He had cataracts.", medium: "oil on canvas" });
    expect(needsDetails(p!)).toBe(false);
  });

  it("leaves the artist and date out when the museum has none", () => {
    const p = paintingFrom(artwork({ creators: [], creation_date: "" }), "d");
    expect(p?.artist).toBeNull();
    expect(p?.date).toBeNull();
  });

  it("is null without a web image or a title", () => {
    expect(paintingFrom(artwork({ images: { web: null } }), "d")).toBeNull();
    expect(paintingFrom(artwork({ images: null }), "d")).toBeNull();
    expect(paintingFrom(artwork({ title: "  " }), "d")).toBeNull();
    expect(paintingFrom({ nope: true }, "d")).toBeNull();
  });
});

describe("a painting's words", () => {
  it("are cleaned of the museum's tags and entities", () => {
    expect(plainText("It&#39;s <i>late</i> &ldquo;work&rdquo; &mdash; 1915&ndash;26")).toBe("It’s late “work” — 1915–26");
    expect(plainText("  <p> </p> ")).toBeNull();
    expect(plainText(null)).toBeNull();
  });

  it("give the canvas's size, unframed, in metric", () => {
    expect(sizeFrom("Framed: 199.3 x 133.1 x 12.7 cm (78 7/16 x 52 3/8 x 5 in.); Unframed: 175 x 106 cm (68 7/8 x 41 3/4 in.)")).toBe("175 x 106 cm");
    expect(sizeFrom("Unframed: 106 x 78 cm (41 3/4 x 30 11/16 in)")).toBe("106 x 78 cm");
    expect(sizeFrom("Overall: 50 x 40 cm")).toBe("50 x 40 cm");
    expect(sizeFrom("50 x 40 cm")).toBe("50 x 40 cm");
    expect(sizeFrom(null)).toBeNull();
  });

  it("are read by id for a painting kept from before them", async () => {
    const kept = { id: 101, title: "A", artist: null, date: null, image: "https://x.example/a.jpg", width: 3, height: 4, link: null, day: "d" };
    expect(needsDetails(kept)).toBe(true);
    const urls: string[] = [];
    const p = await fetchDetails(kept, async (url) => (urls.push(url), { data: artwork({ description: "A blurb." }) }));
    expect(urls).toEqual(["https://openaccess-api.clevelandart.org/api/artworks/101"]);
    expect(p).toMatchObject({ id: 101, title: "A", blurb: "A blurb.", fact: null, medium: null, size: null });
    expect(needsDetails(p)).toBe(false);
  });
});

describe("the painting's card", () => {
  const view = { width: 1400, height: 900 };
  const card = { width: 300, height: 200 };
  const painting = { left: 500, top: 200, right: 900, bottom: 700 };

  it("lies a quarter over the painting, the rest to its right, level with its middle", () => {
    expect(cardPlacement(painting, card, view)).toEqual({ left: 825, top: 350, side: "right" });
  });

  it("stays at the right without room there, further over the painting", () => {
    expect(cardPlacement({ ...painting, left: 900, right: 1300 }, card, view)).toEqual({ left: 1088, top: 350, side: "right" });
    expect(cardPlacement({ left: 100, top: 200, right: 1300, bottom: 700 }, card, view)).toEqual({ left: 1088, top: 350, side: "right" });
    // Never off the window's left edge, however narrow it is.
    expect(cardPlacement(painting, card, { width: 250, height: 900 }).left).toBe(12);
  });

  it("keeps inside its column, as far in from its right edge as the column is from the window's", () => {
    // The column ends 1100 in a 1400 window, 300 from its edge: the card's right edge 300 in from 1100.
    expect(cardPlacement(painting, card, view, 12, 1100)).toEqual({ left: 500, top: 350, side: "right" });
    // A column 20 from the window's edge: the card ends 20 in from it, at 1360.
    expect(cardPlacement({ ...painting, left: 900, right: 1300 }, card, view, 12, 1380).left).toBe(1060);
    // A column flush with the window: the card ends the usual 12 in.
    expect(cardPlacement({ ...painting, left: 900, right: 1300 }, card, view, 12, 1400).left).toBe(1088);
  });

  it("stays in the window top to bottom", () => {
    expect(cardPlacement({ ...painting, top: 0, bottom: 100 }, card, view).top).toBe(12);
    expect(cardPlacement({ ...painting, top: 850, bottom: 950 }, card, view).top).toBe(688);
  });
});

describe("paintingDetails", () => {
  const p = { title: "Water Lilies", date: "c. 1915–26", artist: "Claude Monet (French, 1840–1926)" };

  it("gives the work with its date, and the painter by name", () => {
    expect(paintingDetails(p)).toEqual({ work: "Water Lilies, c. 1915–26", by: "Claude Monet" });
  });

  it("gives the museum's nationality and years in full", () => {
    expect(paintingDetails(p, true).by).toBe("Claude Monet (French, 1840–1926)");
  });

  it("leaves out a missing date and names a missing painter", () => {
    expect(paintingDetails({ title: "Untitled", date: null, artist: null })).toEqual({ work: "Untitled", by: "Artist unknown" });
  });

  it("keeps a name with no years as it is", () => {
    expect(paintingDetails({ title: "A Ship", date: "1850", artist: "American" }).by).toBe("American");
  });
});

describe("fitsAFrame", () => {
  it("leaves out scrolls and long panoramas", () => {
    expect(fitsAFrame(478, 893)).toBe(true);
    expect(fitsAFrame(300, 900)).toBe(false);
    expect(fitsAFrame(900, 300)).toBe(false);
  });
});

describe("fetchPainting", () => {
  const search = (data: unknown[], total = 300) => ({ info: { total }, data });

  it("returns the painting at a random place", async () => {
    const urls: string[] = [];
    const p = await fetchPainting({ day: "d", random: () => 0.5, get: async (url) => (urls.push(url), search([artwork()])) });
    expect(p.title).toBe("Water Lilies");
    expect(urls).toHaveLength(1);
  });

  it("picks again within a department that has shrunk past the place picked", async () => {
    const urls: string[] = [];
    const p = await fetchPainting({
      day: "d",
      random: () => 0.9,
      get: async (url) => (urls.push(url), new URL(url).searchParams.get("skip") === "45" ? search([artwork()], 50) : search([], 50)),
    });
    expect(p.id).toBe(101);
    expect(urls.map((u) => new URL(u).searchParams.get("skip"))).toEqual(["218", "45"]);
  });

  it("skips the painting already up, and ones that don't fit a frame", async () => {
    const answers = [search([artwork({ id: 7 })]), search([artwork({ id: 8, images: { web: { url: "https://x.example/a.jpg", width: 200, height: 900 } } })]), search([artwork({ id: 9 })])];
    const p = await fetchPainting({ day: "d", exclude: 7, random: () => 0.1, get: async () => answers.shift() });
    expect(p.id).toBe(9);
  });

  it("gives up after a few tries", async () => {
    await expect(fetchPainting({ day: "d", random: () => 0.1, get: async () => search([]) })).rejects.toThrow();
  });
});

describe("frameWidth", () => {
  it("is about 7.5% of the painting's size, within 12 to 40", () => {
    expect(frameWidth(360, 450)).toBe(30);
    expect(frameWidth(600, 200)).toBe(26);
    expect(frameWidth(80, 80)).toBe(12);
    expect(frameWidth(1200, 900)).toBe(40);
  });
});

describe("frameLayout", () => {
  it("draws the gilt moulding at its width, the canvas a pixel under its lip", () => {
    expect(frameLayout("gilt", 360, 450)).toEqual({ moulding: frameWidth(360, 450), gap: 0, over: 1 });
  });

  it("gives each floater a thin face and a strip of its back in shadow inside it", () => {
    expect(frameLayout("wood", 360, 450)).toEqual({ moulding: 4, gap: 3, over: 0 });
    expect(frameLayout("white", 600, 750)).toEqual({ moulding: 6, gap: 4, over: 0 });
    expect(frameLayout("dark", 600, 750)).toEqual({ moulding: 7, gap: 4, over: 0 });
  });

  it("keeps a small painting's floater and its shadow from vanishing", () => {
    expect(frameLayout("wood", 60, 60)).toEqual({ moulding: 3, gap: 3, over: 0 });
  });

  it("takes the moulding and the gap around the painting", () => {
    expect(frameBorder("wood", 360, 450)).toBe(7);
    expect(frameBorder("gilt", 360, 450)).toBe(30);
  });
});

describe("Painting", () => {
  it("still reads one kept from when it was hung in a frame of its own", () => {
    const kept = { id: 1, title: "A", artist: null, date: null, image: "https://x.example/a.jpg", width: 3, height: 4, link: null, day: "d", frame: "gilt" };
    expect(Painting.safeParse(kept).success).toBe(true);
  });
});

describe("frameForTheme", () => {
  it("hangs the white floater in the light theme and the dark one in the dark", () => {
    expect(frameForTheme(false)).toBe("white");
    expect(frameForTheme(true)).toBe("dark");
  });
});

describe("fitFramed", () => {
  it("leaves room for each frame's border", () => {
    for (const kind of ["gilt", "wood", "dark", "white"] as const) {
      const f = fitFramed(500, 400, 0.75, 540, kind)!;
      expect(f.t).toBe(frameBorder(kind, f.w, f.h));
      expect(f.h + 2 * f.t).toBeLessThanOrEqual(400);
    }
  });

  it("fills the room's height for a tall painting, frame included", () => {
    const f = fitFramed(500, 400, 0.75)!;
    expect(f.h + 2 * f.t).toBeLessThanOrEqual(400);
    expect(f.w + 2 * f.t).toBeLessThanOrEqual(500);
    expect(400 - (f.h + 2 * f.t)).toBeLessThan(2);
    expect(f.t).toBe(frameWidth(f.w, f.h));
  });

  it("fills the room's width for a wide painting", () => {
    const f = fitFramed(300, 600, 1.5)!;
    expect(300 - (f.w + 2 * f.t)).toBeLessThan(2);
    expect(Math.abs(f.w / f.h - 1.5)).toBeLessThan(0.02);
  });

  it("caps the painting's longer side", () => {
    expect(fitFramed(2000, 2000, 0.8, 440)!.h).toBe(440);
    expect(fitFramed(2000, 2000, 1.25, 440)!.w).toBe(440);
  });

  it("is null when there's no room", () => {
    expect(fitFramed(70, 400, 1)).toBeNull();
    expect(fitFramed(0, 0, 1)).toBeNull();
  });
});
