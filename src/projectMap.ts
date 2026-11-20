import type { MapItem, MapLink, ProjectMap } from "./schema";

/**
 * A project's map of tasks and dependencies (see mapProject): its Jira tickets and the tasks Demian
 * assumes, laid out left to right in the order the work has to happen, one row per track.
 */

/**
 * The map as it can be drawn: one item per id, links only between items on the map, and a link
 * counted as Jira's only when both its ends are Jira tickets (anything else is Demian's assumption).
 * One link per pair; Jira's wins over an assumed one.
 */
export function normalizeMap(map: ProjectMap): ProjectMap {
  const items: MapItem[] = [];
  const ids = new Set<string>();
  for (const raw of map.items) {
    const id = raw.id.trim();
    if (!id || !raw.title.trim() || ids.has(id)) continue;
    ids.add(id);
    const key = raw.jira?.key?.trim().toUpperCase();
    items.push({ ...raw, id, title: raw.title.trim(), jira: key ? { key, link: raw.jira?.link ?? null } : null });
  }
  const isJira = new Set(items.filter((i) => i.jira).map((i) => i.id));
  const links = new Map<string, MapLink>();
  for (const raw of map.links) {
    const from = raw.from.trim();
    const to = raw.to.trim();
    if (!ids.has(from) || !ids.has(to) || from === to) continue;
    const link: MapLink = { ...raw, from, to, source: raw.source === "jira" && isJira.has(from) && isJira.has(to) ? "jira" : "assumed" };
    const key = `${from}>${to}`;
    const had = links.get(key);
    if (!had || (had.source === "assumed" && link.source === "jira")) links.set(key, link);
  }
  return { items, links: [...links.values()], note: map.note?.trim() || null };
}

/** Where an item sits: its column (left to right), its lane (track) and its row within that lane. */
export interface MapPlace {
  item: MapItem;
  col: number;
  lane: number;
  row: number;
}

export interface MapLayout {
  /** One lane per track, in the path's order, then any others, then "Other"; one unnamed lane when there are no tracks. */
  lanes: { name: string; rows: number }[];
  cols: number;
  places: MapPlace[];
  /** The links, each marked when it closes a loop (Jira links can point both ways); those aren't used for the order. */
  links: (MapLink & { loop: boolean })[];
}

/** Without a link to place it, done work sits left, work underway in the middle, and what's next to the right. */
const FLOOR: Record<MapItem["status"], number> = { done: 0, in_progress: 1, blocked: 1, next: 2 };
const STATUS_ORDER: Record<MapItem["status"], number> = { done: 0, in_progress: 1, blocked: 2, next: 3 };

/**
 * Lays a map out left to right: an item's column is after every item it waits on (and no further left
 * than its status puts it), its lane is its track, and items sharing a column in a lane stack in rows,
 * ordered to keep each near what it waits on. Empty columns are dropped.
 */
export function layoutMap(map: ProjectMap, trackOrder: string[] = []): MapLayout {
  const items = map.items;
  const preds = new Map<string, string[]>();
  for (const l of map.links) preds.set(l.to, [...(preds.get(l.to) ?? []), l.from]);

  // A link that closes a loop is left out of the order, so every item has a place.
  const loops = new Set<string>();
  const seen = new Map<string, "on" | "done">();
  const walk = (id: string) => {
    seen.set(id, "on");
    for (const p of preds.get(id) ?? []) {
      const s = seen.get(p);
      if (s === "on") loops.add(`${p}>${id}`);
      else if (!s) walk(p);
    }
    seen.set(id, "done");
  };
  for (const i of items) if (!seen.has(i.id)) walk(i.id);

  const byId = new Map(items.map((i) => [i.id, i]));
  const rawCol = new Map<string, number>();
  const colOf = (id: string): number => {
    const known = rawCol.get(id);
    if (known !== undefined) return known;
    rawCol.set(id, 0);
    let c = FLOOR[byId.get(id)!.status];
    for (const p of preds.get(id) ?? []) if (!loops.has(`${p}>${id}`)) c = Math.max(c, colOf(p) + 1);
    rawCol.set(id, c);
    return c;
  };
  for (const i of items) colOf(i.id);
  const used = [...new Set(rawCol.values())].sort((a, b) => a - b);
  const col = (id: string) => used.indexOf(rawCol.get(id)!);

  // Lanes: the path's tracks in its order, then others as they come, then the untracked.
  const names: string[] = [];
  const laneKey = (t: string | null | undefined) => t?.trim().toLowerCase() ?? "";
  for (const t of [...trackOrder, ...items.map((i) => i.track ?? "")]) {
    const k = laneKey(t);
    if (k && items.some((i) => laneKey(i.track) === k) && !names.some((n) => laneKey(n) === k)) names.push(t.trim());
  }
  const untracked = items.some((i) => !laneKey(i.track) || !names.some((n) => laneKey(n) === laneKey(i.track)));
  const lanes = untracked ? [...names, names.length ? "Other" : ""] : names;
  const laneOf = (i: MapItem) => {
    const at = names.findIndex((n) => laneKey(n) === laneKey(i.track));
    return at >= 0 ? at : lanes.length - 1;
  };

  // Rows, column by column, so each cell can sit near what its items wait on.
  const placed = new Map<string, MapPlace>();
  const cells = new Map<string, MapItem[]>();
  for (const i of items) {
    const key = `${laneOf(i)}:${col(i.id)}`;
    cells.set(key, [...(cells.get(key) ?? []), i]);
  }
  const height = new Map<number, number>();
  for (let c = 0; c < used.length; c++) {
    for (let lane = 0; lane < lanes.length; lane++) {
      const cell = cells.get(`${lane}:${c}`);
      if (!cell) continue;
      const near = (i: MapItem) => {
        const ps = (preds.get(i.id) ?? []).map((p) => placed.get(p)).filter((p): p is MapPlace => !!p);
        return ps.length ? ps.reduce((sum, p) => sum + p.lane * 1000 + p.row, 0) / ps.length : Infinity;
      };
      const order = [...cell].sort((a, b) => near(a) - near(b) || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || items.indexOf(a) - items.indexOf(b));
      order.forEach((item, row) => placed.set(item.id, { item, col: c, lane, row }));
      height.set(lane, Math.max(height.get(lane) ?? 0, order.length));
    }
  }
  return {
    lanes: lanes.map((name, i) => ({ name, rows: Math.max(1, height.get(i) ?? 0) })),
    cols: Math.max(1, used.length),
    places: items.map((i) => placed.get(i.id)!),
    links: map.links.map((l) => ({ ...l, loop: loops.has(`${l.from}>${l.to}`) })),
  };
}

/** What an item waits on and what waits on it, each with the link between them. */
export function itemLinks(map: ProjectMap, id: string) {
  const byId = new Map(map.items.map((i) => [i.id, i]));
  const pick = (l: MapLink, other: string) => (byId.has(other) ? [{ item: byId.get(other)!, link: l }] : []);
  return {
    waitsOn: map.links.filter((l) => l.to === id).flatMap((l) => pick(l, l.from)),
    neededFor: map.links.filter((l) => l.from === id).flatMap((l) => pick(l, l.to)),
  };
}
