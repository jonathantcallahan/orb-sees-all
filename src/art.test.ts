import { describe, expect, it } from "vitest";
import { DEPARTMENTS, fetchPainting, fitFramed, fitsAFrame, frameWidth, paintingFrom, pickDepartment, searchUrl } from "./art";

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
    });
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

describe("fitFramed", () => {
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
