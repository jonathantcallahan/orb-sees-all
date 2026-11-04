import { useOrbName } from "../orbLook";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { TASK_SORTS, type TaskSort } from "../taskDates";
import type { ProjectPriority, ProjectStatus, Raci } from "../schema";
import { NO_FILTER, NO_PROJECT_FILTER, type AssistanceFilter, type DueFilter, type PriorityFilter, type ProjectFilter, type TaskFilter, type TaskSource, type TaskStatus } from "../tasks";

const SOURCES: [TaskSource, string][] = [
  ["project", "Projects"],
  ["request", "Requests"],
  ["meeting", "Meeting prep"],
  ["own", "Ungrouped"],
];

const STATUSES: [TaskStatus, string][] = [
  ["todo", "To do"],
  ["in_progress", "In progress"],
  ["waiting", "Waiting"],
  ["blocked", "Blocked"],
  ["done", "Done"],
];

const PRIORITIES: [PriorityFilter, string][] = [
  ["blocking", "Blocking"],
  ["critical", "Critical"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
  ["unrated", "Unrated"],
];

/** Labelled as on the task cards, with the current orb's name. */
const assistance = (orb: string): [AssistanceFilter, string][] => [
  ["claude", `${orb} can do it`],
  ["assisted", `${orb} can help`],
  ["human", "You do it"],
  ["unassessed", "Not assessed"],
];

const DUES: [DueFilter, string][] = [
  ["overdue", "Overdue"],
  ["soon", "Due soon"],
  ["later", "Due later"],
  ["none", "No due date"],
];

/** A filter kept in localStorage so it survives restarts. */
function useStoredFilter<F extends object>(key: string, empty: F, isStale?: (stored: Record<string, unknown>) => boolean): [F, (f: F) => void] {
  const [filter, setFilter] = useState<F>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
      return isStale?.(stored) ? empty : { ...empty, ...stored };
    } catch {
      return empty;
    }
  });
  useEffect(() => localStorage.setItem(key, JSON.stringify(filter)), [key, filter]);
  return [filter, setFilter];
}

/** The All tasks filter. Saved filters from before multi-select start fresh. */
export const useTaskFilter = () => useStoredFilter<TaskFilter>("task-filter", NO_FILTER, (s) => !Array.isArray(s.statuses) || !Array.isArray(s.priorities));

export const useProjectFilter = () =>
  useStoredFilter<ProjectFilter>("project-filter", NO_PROJECT_FILTER, (s) => !Array.isArray(s.statuses) || !Array.isArray(s.priorities));

/** Closes a popover on a click outside `ref` or on Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
}

const Chevron = () => (
  <svg className="filter-chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden>
    <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** How All tasks is sorted: a pill showing the current order that opens the choices. */
export function SortSelect({ value, onChange }: { value: TaskSort; onChange: (v: TaskSort) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const label = TASK_SORTS.find(([v]) => v === value)?.[1] ?? "Priority";
  return (
    <div className="multi-filter sort-select" ref={ref}>
      <button className={`filter-select${open ? " open" : ""}`} aria-label={`Sort by ${label}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
        <Chevron />
      </button>
      {open && (
        <div className="multi-filter-menu sort-menu" role="listbox" aria-label="Sort by">
          {TASK_SORTS.map(([v, l]) => (
            <button
              key={v}
              role="option"
              aria-selected={v === value}
              className={`multi-filter-option${v === value ? " on" : ""}`}
              onClick={() => {
                onChange(v);
                setOpen(false);
              }}
            >
              <span className="multi-filter-check round" aria-hidden>
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M2.2 5.2 4.2 7.2 7.8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A row of filters that never wraps: they're listed most important first, and when they don't all fit
 * on one line the ones at the end move into a More filters menu (at least two of them, so the menu
 * never holds just one), which shows how many of those are in use. Every filter stays reachable.
 * It measures the filters in an invisible copy of the row and refits whenever its width changes.
 */
function OverflowBar({ items }: { items: { key: string; active: boolean; node: ReactNode }[] }) {
  const box = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(items.length);
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useDismiss(open, moreRef, () => setOpen(false));
  const refit = () => {
    const el = box.current;
    const m = measure.current;
    if (!el || !m) return;
    const kids = [...m.children] as HTMLElement[];
    const widths = kids.slice(0, items.length).map((k) => k.offsetWidth);
    const more = kids[items.length]?.offsetWidth ?? 0;
    const gap = 6;
    const span = (n: number) => widths.slice(0, n).reduce((a, w) => a + w, 0) + Math.max(n - 1, 0) * gap;
    const room = el.clientWidth;
    let n = items.length;
    if (span(n) > room) {
      n = 0;
      while (n < items.length && span(n + 1) + gap + more <= room) n++;
      // Never a menu of one: if only the last would go, move the one before it too.
      if (items.length - n === 1) n = Math.max(n - 1, 0);
    }
    setFit((cur) => (cur === n ? cur : n));
  };
  useLayoutEffect(refit);
  useEffect(() => {
    const observer = new ResizeObserver(() => refit());
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const shown = items.slice(0, fit);
  const hidden = items.slice(fit);
  const activeHidden = hidden.filter((i) => i.active).length;
  return (
    <div className="task-filters" ref={box}>
      {shown.map((i) => (
        <div key={i.key} className="filter-slot">
          {i.node}
        </div>
      ))}
      {hidden.length > 0 && (
        <div
          className="multi-filter"
          ref={moreRef}
          // Moving the cursor away folds the row back up, after a moment, so crossing the gap
          // between the button and the row (or a filter's own menu) doesn't.
          onMouseLeave={() => {
            clearTimeout(leaveTimer.current);
            leaveTimer.current = setTimeout(() => setOpen(false), 300);
          }}
          onMouseEnter={() => clearTimeout(leaveTimer.current)}
        >
          <button className={`filter-select${activeHidden ? " on" : ""}${open ? " open" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
            More filters{activeHidden > 0 && ` · ${activeHidden}`}
            <Chevron />
          </button>
          {open && (
            <div className="multi-filter-menu more-filters-menu" role="dialog" aria-label="More filters">
              {hidden.map((i) => (
                <div key={i.key} className="filter-slot">
                  {i.node}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* The measuring copy: every filter as it would show inline, plus the More button. */}
      <div className="task-filters-measure" ref={measure} aria-hidden inert>
        {items.map((i) => (
          <div key={i.key} className="filter-slot">
            {i.node}
          </div>
        ))}
        <button className="filter-select">
          More filters · 9
          <Chevron />
        </button>
      </div>
    </div>
  );
}

/** A pill that opens a checklist; any number of options can be picked, none means any. */
function MultiFilter<V extends string>({
  values,
  anyLabel,
  options,
  label,
  onChange,
}: {
  values: V[];
  anyLabel: string;
  options: [V, string][];
  label: string;
  onChange: (v: V[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const names = options.filter(([v]) => values.includes(v)).map(([, l]) => l);
  // One pick shows its name; several show the category and how many ("Priority · 2").
  const text = names.length === 0 ? anyLabel : names.length === 1 ? names[0] : `${anyLabel.replace(/^Any /, "")} · ${names.length}`;
  const toggle = (v: V) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  return (
    <div className="multi-filter" ref={ref}>
      <button
        className={`filter-select${values.length ? " on" : ""}${open ? " open" : ""}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={names.join(", ") || undefined}
        onClick={() => setOpen(!open)}
      >
        {text}
        <svg className="filter-chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden>
          <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="multi-filter-menu" role="listbox" aria-multiselectable aria-label={label}>
          {options.map(([v, l]) => {
            const on = values.includes(v);
            return (
              <button key={v} role="option" aria-selected={on} className={`multi-filter-option${on ? " on" : ""}`} onClick={() => toggle(v)}>
                <span className="multi-filter-check" aria-hidden>
                  <svg width="10" height="10" viewBox="0 0 10 10">
                    <path d="M2.2 5.2 4.2 7.2 7.8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                {l}
              </button>
            );
          })}
          {values.length > 0 && (
            <div className="multi-filter-footer">
              <button className="link-button small more-link" onClick={() => onChange([])}>
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecommendedToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button className={`filter-select recommended${on ? " on" : ""}`} aria-pressed={on} onClick={() => onChange(!on)}>
      <svg className="sparkle" width="8" height="8" viewBox="0 0 8 8" aria-hidden>
        <path d="M4 0Q4.6 3.4 8 4Q4.6 4.6 4 8Q3.4 4.6 0 4Q3.4 3.4 4 0Z" fill="currentColor" />
      </svg>Recommended
    </button>
  );
}

const PROJECT_STATUSES: [ProjectStatus, string][] = [
  ["blocked", "Blocked"],
  ["at_risk", "At risk"],
  ["on_track", "On track"],
  ["idle", "Idle"],
];

const PROJECT_PRIORITIES: [ProjectPriority, string][] = [
  ["P0", "P0"],
  ["P1", "P1"],
  ["P2", "P2"],
  ["P3", "P3"],
  ["P4", "P4"],
];

const PROJECT_ROLES: [Raci, string][] = [
  ["responsible", "Responsible"],
  ["accountable", "Accountable"],
  ["consulted", "Consulted"],
  ["informed", "Informed"],
];

/** Status, priority and RACI role filters for the Projects column. */
export function ProjectFilters({ filter, onChange }: { filter: ProjectFilter; onChange: (f: ProjectFilter) => void }) {
  return (
    <div className="task-filters">
      <MultiFilter label="Filter projects by status" anyLabel="Any status" values={filter.statuses} options={PROJECT_STATUSES} onChange={(statuses) => onChange({ ...filter, statuses })} />
      <MultiFilter label="Filter projects by priority" anyLabel="Any priority" values={filter.priorities} options={PROJECT_PRIORITIES} onChange={(priorities) => onChange({ ...filter, priorities })} />
      <MultiFilter label="Filter projects by your RACI role" anyLabel="Any role" values={filter.roles} options={PROJECT_ROLES} onChange={(roles) => onChange({ ...filter, roles })} />
    </div>
  );
}

/** Source, status, priority, due date, Orb assistance and Recommended filters for All tasks. */
export function TaskFilters({ filter, onChange, showSource = true }: { filter: TaskFilter; onChange: (f: TaskFilter) => void; showSource?: boolean }) {
  const orbName = useOrbName();
  // Most important first: these stay on the row longest when space runs short.
  const items = [
    {
      key: "status",
      active: filter.statuses.length > 0,
      node: <MultiFilter label="Filter by status" anyLabel="Status" values={filter.statuses} options={STATUSES} onChange={(statuses) => onChange({ ...filter, statuses })} />,
    },
    {
      key: "priority",
      active: filter.priorities.length > 0,
      node: <MultiFilter label="Filter by priority" anyLabel="Priority" values={filter.priorities} options={PRIORITIES} onChange={(priorities) => onChange({ ...filter, priorities })} />,
    },
    {
      key: "due",
      active: filter.dues.length > 0,
      node: <MultiFilter label="Filter by due date" anyLabel="Due" values={filter.dues} options={DUES} onChange={(dues) => onChange({ ...filter, dues })} />,
    },
    ...(showSource
      ? [
          {
            key: "source",
            active: filter.sources.length > 0,
            node: <MultiFilter label="Filter by source" anyLabel="Source" values={filter.sources} options={SOURCES} onChange={(sources) => onChange({ ...filter, sources })} />,
          },
        ]
      : []),
    {
      key: "orb",
      active: filter.assistance.length > 0,
      node: <MultiFilter label="Filter by what Orb can do" anyLabel="Orb" values={filter.assistance} options={assistance(orbName)} onChange={(assistance) => onChange({ ...filter, assistance })} />,
    },
    { key: "recommended", active: filter.recommendedOnly, node: <RecommendedToggle on={filter.recommendedOnly} onChange={(recommendedOnly) => onChange({ ...filter, recommendedOnly })} /> },
  ];
  return <OverflowBar items={items} />;
}
