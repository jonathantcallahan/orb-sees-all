import { describe, expect, it } from "vitest";
import { itemLinks, layoutMap, normalizeMap } from "./projectMap";
import { ProjectMap } from "./schema";

// Recency review score's tickets as Jira links them, plus a launch Demian assumes.
const ticket = (key: string, title: string, status = "next", track: string | null = "Backend") => ({ id: key, title, status, owner: "Kim", track, jira: { key, link: `https://example.atlassian.net/browse/${key}` } });
const raw = {
  items: [
    ticket("PAY-8608", "Ratings endpoint", "done"),
    ticket("PAY-8609", "Eligibility table", "done"),
    ticket("PAY-8612", "Classify job", "in_progress"),
    ticket("PAY-8614", "Score job"),
    ticket("PAY-8615", "Search ranking", "next", "Search"),
    { id: "t1", title: "Launch", status: "next", track: null, owner: "Raj", reason: "The path ends with a launch." },
  ],
  links: [
    { from: "PAY-8608", to: "PAY-8612", source: "jira" },
    { from: "PAY-8609", to: "PAY-8612", source: "jira" },
    { from: "PAY-8612", to: "PAY-8614", source: "jira" },
    { from: "PAY-8614", to: "PAY-8615", source: "jira" },
    { from: "PAY-8615", to: "t1", source: "assumed", reason: "Ranking ships before launch." },
  ],
};
const map = normalizeMap(ProjectMap.parse(raw));
const place = (layout: ReturnType<typeof layoutMap>, id: string) => layout.places.find((p) => p.item.id === id)!;

describe("a project's map of tasks and dependencies", () => {
  it("keeps one item per id and only links between items on the map", () => {
    const m = normalizeMap(
      ProjectMap.parse({
        items: [...raw.items, ticket("PAY-8608", "Again"), { id: " ", title: "Nameless" }],
        links: [...raw.links, { from: "PAY-8612", to: "PAY-9999", source: "jira" }, { from: "t1", to: "t1", source: "assumed" }],
      }),
    );
    expect(m.items.map((i) => i.id)).toEqual(["PAY-8608", "PAY-8609", "PAY-8612", "PAY-8614", "PAY-8615", "t1"]);
    expect(m.links).toHaveLength(5);
  });

  it("counts a link as Jira's only when both ends are Jira tickets, and prefers Jira's link for a pair", () => {
    const m = normalizeMap(
      ProjectMap.parse({
        items: raw.items,
        links: [
          { from: "PAY-8615", to: "t1", source: "jira" },
          { from: "PAY-8612", to: "PAY-8614", source: "assumed", reason: "guess" },
          { from: "PAY-8612", to: "PAY-8614", source: "jira" },
        ],
      }),
    );
    expect(m.links.map((l) => `${l.from}>${l.to}:${l.source}`)).toEqual(["PAY-8615>t1:assumed", "PAY-8612>PAY-8614:jira"]);
  });

  it("reads an item without a ticket as Demian's assumption, and a ticket's key in capitals", () => {
    const m = normalizeMap(ProjectMap.parse({ items: [{ id: "x", title: "X", jira: { key: " pay-1 " } }, { id: "t2", title: "Sign-off", jira: "none" }] }));
    expect(m.items[0].jira).toEqual({ key: "PAY-1", link: null });
    expect(m.items[1].jira).toBeNull();
  });

  it("runs left to right in the order the work has to happen", () => {
    const layout = layoutMap(map, ["Backend", "Search"]);
    expect(["PAY-8608", "PAY-8609", "PAY-8612", "PAY-8614", "PAY-8615", "t1"].map((id) => place(layout, id).col)).toEqual([0, 0, 1, 2, 3, 4]);
    expect(layout.cols).toBe(5);
  });

  it("puts work with no links by its status, done left, underway in the middle, next right, and drops empty columns", () => {
    const layout = layoutMap(normalizeMap(ProjectMap.parse({ items: [ticket("A-1", "Next", "next"), ticket("A-2", "Done", "done")] })));
    expect(place(layout, "A-2").col).toBe(0);
    // No work underway, so the middle column goes and what's next moves up beside what's done.
    expect(place(layout, "A-1").col).toBe(1);
    expect(layout.cols).toBe(2);
  });

  it("gives each track a lane, in the path's order, with untracked work in Other", () => {
    const layout = layoutMap(map, ["Search", "backend"]);
    expect(layout.lanes.map((l) => l.name)).toEqual(["Search", "backend", "Other"]);
    expect(place(layout, "PAY-8615").lane).toBe(0);
    expect(place(layout, "PAY-8612").lane).toBe(1);
    expect(place(layout, "t1").lane).toBe(2);
    // Two done tickets in one column of one lane stack in rows.
    expect([place(layout, "PAY-8608").row, place(layout, "PAY-8609").row].sort()).toEqual([0, 1]);
    expect(layout.lanes[1].rows).toBe(2);
  });

  it("has one unnamed lane when nothing has a track", () => {
    const layout = layoutMap(normalizeMap(ProjectMap.parse({ items: [ticket("A-1", "One", "next", null)] })));
    expect(layout.lanes).toEqual([{ name: "", rows: 1 }]);
  });

  it("still places everything when Jira's links form a loop, and marks the link that closes it", () => {
    const loop = normalizeMap(
      ProjectMap.parse({
        items: [ticket("G-3", "Add the flag"), ticket("G-6", "Roll out"), ticket("G-7", "Clean up")],
        links: [
          { from: "G-7", to: "G-6", source: "jira" },
          { from: "G-6", to: "G-3", source: "jira" },
          { from: "G-3", to: "G-7", source: "jira" },
        ],
      }),
    );
    const layout = layoutMap(loop);
    expect(layout.places.every((p) => p.col >= 0)).toBe(true);
    expect(layout.links.filter((l) => l.loop)).toHaveLength(1);
  });

  it("lists what an item waits on and what it holds up", () => {
    const { waitsOn, neededFor } = itemLinks(map, "PAY-8612");
    expect(waitsOn.map((w) => w.item.id)).toEqual(["PAY-8608", "PAY-8609"]);
    expect(neededFor.map((n) => `${n.item.id}:${n.link.source}`)).toEqual(["PAY-8614:jira"]);
  });
});
