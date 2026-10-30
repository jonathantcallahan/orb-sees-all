import { useState } from "react";
import { createPortal } from "react-dom";
import { setOrbAgitated } from "../orbEvents";
import { type Pressure, type PressureTally } from "../tasks";

/** Width each task adds to its bar, and the most a bar grows before its segments scale down to fit. */
const PX_PER_TASK = 3;
const MAX_WIDTH = 180;
/** Matches the 6px stripe in styles.css. */
const BAR_HEIGHT = 6;

interface Segment {
  key: string;
  label: string;
  count: number;
}

const PRIORITY_SEGMENTS = (t: PressureTally): Segment[] => [
  { key: "blocking", label: "blocking", count: t.blocking },
  { key: "critical", label: "critical", count: t.critical },
  { key: "high", label: "high", count: t.high },
  { key: "medium", label: "medium", count: t.medium },
  { key: "low", label: "low or unrated", count: t.low },
];

/** Overdue and due soon get a bar each. */
const OVERDUE = (t: PressureTally): Segment[] => [{ key: "overdue", label: "overdue", count: t.overdue }];
const DUE_SOON = (t: PressureTally): Segment[] => [{ key: "due-soon", label: "due soon", count: t.dueSoon }];

/** What's being hovered: a segment's (or empty bar's) label, and where to show it. */
type Hover = { text: string; anchor: DOMRect } | null;

/**
 * One rounded bar of colored segments, a task's width each; a small gray dot when it's empty.
 * Each segment names itself on hover, e.g. "High · 19".
 */
function Bar({
  segments,
  empty,
  onHover,
  agitates = false,
}: {
  segments: Segment[];
  empty: string;
  onHover: (h: Hover) => void;
  /** Hovering a segment of this bar agitates the orb (the overdue bar). */
  agitates?: boolean;
}) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  const hover = (text: string, agitate = false) => ({
    onMouseEnter: (e: React.MouseEvent) => {
      onHover({ text, anchor: e.currentTarget.getBoundingClientRect() });
      if (agitate) setOrbAgitated(true);
    },
    onMouseLeave: () => {
      onHover(null);
      if (agitate) setOrbAgitated(false);
    },
  });
  if (!total) return <span className="pressure-bar-empty" aria-label={empty} {...hover(empty)} />;
  // At least as wide as it is tall, so a bar with one task is a circle and longer ones have round ends.
  const width = Math.max(BAR_HEIGHT, Math.min(total * PX_PER_TASK, MAX_WIDTH));
  return (
    <span className="pressure-bar" style={{ width }}>
      {segments
        .filter((s) => s.count)
        .map((s) => {
          const text = `${s.label[0].toUpperCase()}${s.label.slice(1)} · ${s.count}`;
          return <span key={s.key} className={`pressure-seg ${s.key}`} style={{ flexGrow: s.count }} aria-label={text} {...hover(text, agitates)} />;
        })}
    </span>
  );
}

/**
 * What feeds the orb's mood, as small bars side by side under it: open tasks shaded by priority,
 * then overdue tasks, then tasks due soon. Hovering a segment names it and its count.
 */
export function PressureBars({ pressure }: { pressure: Pressure }) {
  const [hovered, setHovered] = useState<Hover>(null);
  const t = pressure.tally;
  if (!t) return null;

  return (
    <>
      <div className="pressure-bars">
        <Bar segments={PRIORITY_SEGMENTS(t)} empty="No open tasks" onHover={setHovered} />
        <Bar segments={OVERDUE(t)} empty="Nothing overdue" onHover={setHovered} agitates />
        <Bar segments={DUE_SOON(t)} empty="Nothing due soon" onHover={setHovered} />
      </div>
      {hovered &&
        createPortal(
          <div
            className="card meeting-card pressure-tip small"
            role="tooltip"
            style={{ left: hovered.anchor.left + hovered.anchor.width / 2, top: hovered.anchor.bottom + 6 }}
          >
            {hovered.text}
          </div>,
          document.body,
        )}
    </>
  );
}
