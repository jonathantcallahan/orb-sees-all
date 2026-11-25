import { useRef } from "react";
import { TALLY_HEIGHT, tallyStrokes, tallyWidth } from "../tally";

/** How long apart the marks are drawn when several come at once. */
const STAGGER_MS = 140;

/**
 * The tally after the Tasks column's title: a hand-drawn mark for each task finished today, in fives
 * (see tallyStrokes). A new mark is drawn in as the task is finished, stroke by stroke; those already
 * there when the column opens are simply there. Nothing on a day with none done yet.
 */
export function TallyMarks({ count }: { count: number }) {
  // Marks from `from` on are new since the count last grew: those are drawn in.
  const last = useRef(count);
  const from = useRef(count);
  if (count !== last.current) {
    from.current = count > last.current ? last.current : count;
    last.current = count;
  }
  if (count <= 0) return null;
  const width = tallyWidth(count);
  const label = `${count} ${count === 1 ? "task" : "tasks"} done today`;
  return (
    <svg className="tally" width={width} height={TALLY_HEIGHT} viewBox={`0 0 ${width} ${TALLY_HEIGHT}`} role="img" aria-label={label}>
      <title>{label}</title>
      {tallyStrokes(count).map((d, i) => (
        <path
          key={i}
          d={d}
          pathLength={1}
          className={i >= from.current ? "tally-new" : undefined}
          style={i >= from.current ? { animationDelay: `${(i - from.current) * STAGGER_MS}ms` } : undefined}
        />
      ))}
    </svg>
  );
}
