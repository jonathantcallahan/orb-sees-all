import { useEffect, useMemo, useRef, useState } from "react";
import { oldMapDependencies } from "../db";
import { planMap } from "../plan";
import { itemLinks, layoutMap, type MapLayout, type MapPlace } from "../projectMap";
import type { MapItem, MapLink, PathStep, PathToShip, ProjectMap } from "../schema";
import { formatWhen } from "../scheduler";
import { ExternalLink } from "./common";

const STATUS_LABEL: Record<MapItem["status"], string> = { done: "Done", in_progress: "In progress", next: "Next", blocked: "Blocked" };

// The map's geometry, in px: blocks, the gaps between columns and rows, and each lane's name above it.
const W = 188;
const H = 64;
const GAP_X = 52;
const GAP_Y = 10;
const LANE_HEAD = 26;
const LANE_GAP = 14;
const PAD = 16;
const CARD_W = 300;

interface Box {
  place: MapPlace;
  x: number;
  y: number;
}

/** Where each block and lane sits on the canvas, and how big the canvas is. */
function geometry(layout: MapLayout) {
  const laneTop: number[] = [];
  let y = PAD;
  for (const lane of layout.lanes) {
    laneTop.push(y);
    y += LANE_HEAD + lane.rows * H + (lane.rows - 1) * GAP_Y + LANE_GAP;
  }
  const boxes = new Map<string, Box>();
  for (const place of layout.places) {
    boxes.set(place.item.id, { place, x: PAD + place.col * (W + GAP_X), y: laneTop[place.lane] + LANE_HEAD + place.row * (H + GAP_Y) });
  }
  return { boxes, laneTop, width: PAD * 2 + layout.cols * W + (layout.cols - 1) * GAP_X, height: y - LANE_GAP + PAD };
}

/** A line from the right edge of the work that comes first to the left edge of the work that waits on it. */
function edgePath(from: Box, to: Box, loop: boolean): string {
  const x1 = from.x + W;
  const y1 = from.y + H / 2;
  const x2 = to.x;
  const y2 = to.y + H / 2;
  if (loop || x2 <= x1) {
    // Points back (a loop in Jira's links): around the top of the two blocks.
    const top = Math.min(from.y, to.y) - 18;
    return `M ${x1} ${y1} C ${x1 + 40} ${top}, ${x2 - 40} ${top}, ${x2} ${y2}`;
  }
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/**
 * The plan's work seen by the order it has to happen in: its stories and tasks run left to right, one
 * row per epic, with a line from each piece of work to what waits on it. Tickets and Jira's Blocks
 * links are drawn solid; work with no ticket yet and the order Demian assumes are dotted. Hovering a
 * block shows it in full. It's the same work as the plan (see planMap), read by the same refresh.
 */
export function DependencyView({ path, tasks = [], projectId }: { path: PathToShip; tasks?: PlanTask[]; projectId: string }) {
  // Until a refresh has read the plan's own dependencies, the ones the project's older map found.
  const hasOwn = path.steps.some((s) => s.items?.some((i) => i.waits_on?.length));
  const [older, setOlder] = useState<MapLink[]>([]);
  useEffect(() => {
    if (hasOwn) return;
    let live = true;
    oldMapDependencies(projectId).then((l) => live && setOlder(l), () => {});
    return () => {
      live = false;
    };
  }, [projectId, hasOwn]);
  const { map, lanes, proposed } = useMemo(() => planMap(path, { tasks, links: hasOwn ? [] : older }), [path, tasks, older, hasOwn]);
  if (!map.items.length) return <p className="muted small">The plan has no work in it yet.</p>;
  return (
    <div className="dependency-view">
      <div className="work-map-bar small">
        <MapLegend mine={map.items.some((i) => i.mine)} proposed={proposed.length > 0} />
        {!map.links.some((l) => !l.from.startsWith("task:")) && <span className="muted">No dependencies yet: the next refresh reads them.</span>}
        {!hasOwn && older.length > 0 && <span className="muted">Dependencies from the earlier map until the next refresh reads them.</span>}
      </div>
      <WorkMapCanvas map={map} tracks={lanes} proposed={proposed} />
    </div>
  );
}

/** One of the user's own tasks on the project, as the dependencies view shows it. */
export interface PlanTask {
  id: string;
  title: string;
  status: PathStep["status"];
  moves: string[];
  due?: string | null;
}

/** What the borders and lines mean. */
function MapLegend({ mine = false, proposed = false }: { mine?: boolean; proposed?: boolean }) {
  return (
    <span className="work-map-legend" aria-label="Legend">
      {proposed && (
        <span>
          <i className="legend-block proposed-epic" /> Proposed epic
        </span>
      )}
      {mine && (
        <span>
          <i className="legend-block mine" /> Your task
        </span>
      )}
      <span>
        <i className="legend-block jira" /> Jira ticket
      </span>
      <span>
        <i className="legend-block assumed" /> No ticket yet
      </span>
      <span>
        <i className="legend-line jira" /> Jira dependency
      </span>
      <span>
        <i className="legend-line assumed" /> Assumed dependency
      </span>
    </span>
  );
}

function WorkMapCanvas({ map, tracks, proposed = [] }: { map: ProjectMap; tracks: string[]; proposed?: string[] }) {
  const layout = useMemo(() => layoutMap(map, tracks), [map, tracks]);
  const geo = useMemo(() => geometry(layout), [layout]);
  const [hover, setHover] = useState<string | null>(null);
  const hide = useRef<number>(0);
  const show = (id: string) => {
    window.clearTimeout(hide.current);
    setHover(id);
  };
  const leave = () => {
    window.clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setHover(null), 140);
  };
  useEffect(() => () => window.clearTimeout(hide.current), []);
  const touches = (l: MapLink) => !!hover && (l.from === hover || l.to === hover);
  const near = useMemo(() => {
    if (!hover) return null;
    const ids = new Set([hover]);
    for (const l of map.links) if (l.from === hover || l.to === hover) ids.add(l.from === hover ? l.to : l.from);
    return ids;
  }, [hover, map.links]);
  const hovered = hover ? geo.boxes.get(hover) : undefined;
  return (
    <div className="work-map-scroll">
      <div className={`work-map${hover ? " focused" : ""}`} style={{ width: geo.width, height: geo.height }}>
        {layout.lanes.map((lane, i) => (
          <div
            key={`${i}:${lane.name}`}
            className={`work-map-lane${proposed.includes(lane.name) ? " proposed" : ""}`}
            style={{ top: geo.laneTop[i] - 6, height: LANE_HEAD + lane.rows * H + (lane.rows - 1) * GAP_Y + 12 }}
          >
            {lane.name && <span className="work-map-lane-name">{lane.name}</span>}
          </div>
        ))}
        <svg className="work-map-lines" width={geo.width} height={geo.height} aria-hidden>
          <defs>
            {["plain", "on", "loop"].map((k) => (
              <marker key={k} id={`map-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className={`map-arrow ${k}`} />
              </marker>
            ))}
          </defs>
          {layout.links.map((l) => {
            const from = geo.boxes.get(l.from);
            const to = geo.boxes.get(l.to);
            if (!from || !to) return null;
            const on = touches(l);
            return (
              <path
                key={`${l.from}>${l.to}`}
                d={edgePath(from, to, l.loop)}
                className={`map-line ${l.source}${l.loop ? " loop" : ""}${on ? " on" : ""}`}
                markerEnd={`url(#map-arrow-${l.loop ? "loop" : on ? "on" : "plain"})`}
              />
            );
          })}
        </svg>
        {[...geo.boxes.values()].map(({ place, x, y }) => {
          const item = place.item;
          return (
            <div
              key={item.id}
              className={`map-block ${item.mine ? "mine" : item.jira ? "jira" : "assumed"} ${item.status}${near && !near.has(item.id) ? " dim" : ""}${hover === item.id ? " hovered" : ""}`}
              style={{ left: x, top: y, width: W, height: H }}
              tabIndex={0}
              aria-label={`${item.title}, ${STATUS_LABEL[item.status]}${item.owner ? `, ${item.owner}` : ""}${item.jira ? `, ${item.jira.key}` : ", no ticket yet"}`}
              onMouseEnter={() => show(item.id)}
              onMouseLeave={leave}
              onFocus={() => show(item.id)}
              onBlur={leave}
            >
              <span className="map-block-title">
                <span className="path-mark" aria-hidden />
                {item.title}
              </span>
              <span className="map-block-owner">{item.owner || "No owner"}</span>
            </div>
          );
        })}
        {hovered && (
          <MapCard
            map={map}
            box={hovered}
            canvas={geo}
            onEnter={() => show(hovered.place.item.id)}
            onLeave={leave}
          />
        )}
      </div>
    </div>
  );
}

/** A link's kind, in words, for the hover card. */
const linkWords = (l: MapLink) => (l.source === "jira" ? "Jira link" : l.reason ? `assumed: ${l.reason}` : "assumed");

/** The hovered block in full: what it is, its ticket or why Demian assumes it, and what it waits on and holds up. */
function MapCard({ map, box, canvas, onEnter, onLeave }: { map: ProjectMap; box: Box; canvas: { width: number; height: number }; onEnter: () => void; onLeave: () => void }) {
  const item = box.place.item;
  const { waitsOn, neededFor } = itemLinks(map, item.id);
  // Beside the block, on whichever side has room; from a block in the lower half it grows upward, so it stays on the canvas.
  const right = box.x + W + 10 + CARD_W <= canvas.width || box.x < CARD_W + 10;
  const up = box.y + H / 2 > canvas.height / 2;
  const meta = [STATUS_LABEL[item.status], item.owner || "No owner", item.date ? `Due ${formatWhen(item.date)}` : null].filter(Boolean);
  return (
    <div
      className="map-card small"
      style={{ left: right ? box.x + W + 10 : box.x - CARD_W - 10, ...(up ? { bottom: canvas.height - box.y - H } : { top: box.y }), width: CARD_W }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <strong className="map-card-title">{item.title}</strong>
      <span className="timestamp">{meta.join(" · ")}</span>
      {item.mine ? (
        <span className="map-card-mine">Your task</span>
      ) : item.jira ? (
        item.jira.link ? (
          <ExternalLink href={item.jira.link} className="map-card-key">
            {item.jira.key}
          </ExternalLink>
        ) : (
          <span className="map-card-key">{item.jira.key}</span>
        )
      ) : (
        <span className="map-card-assumed">{item.reason || "No ticket covers this work yet."}</span>
      )}
      {item.detail && <p className="map-card-detail">{item.detail}</p>}
      {waitsOn.length > 0 && (
        <div className="map-card-links">
          <span className="muted">Waits on</span>
          <ul>
            {waitsOn.map(({ item: other, link }) => (
              <li key={other.id}>
                {other.title} <span className="timestamp">({linkWords(link)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {neededFor.length > 0 && (
        <div className="map-card-links">
          <span className="muted">Holds up</span>
          <ul>
            {neededFor.map(({ item: other, link }) => (
              <li key={other.id}>
                {other.title} <span className="timestamp">({linkWords(link)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
