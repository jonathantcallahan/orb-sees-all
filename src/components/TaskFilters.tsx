import { useEffect, useRef, useState } from "react";
import type { ProjectPriority, ProjectStatus, Raci } from "../schema";
import { NO_FILTER, NO_PROJECT_FILTER, type PriorityFilter, type ProjectFilter, type TaskFilter, type TaskStatus } from "../tasks";

const STATUSES: [TaskStatus, string][] = [
  ["todo", "To do"],
  ["in_progress", "In progress"],
  ["waiting", "Waiting"],
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
  const text = names.length === 0 ? anyLabel : names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
  const toggle = (v: V) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  return (
    <div className="multi-filter" ref={ref}>
      <button
        className={`filter-select${values.length ? " on" : ""}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={names.join(", ") || undefined}
        onClick={() => setOpen(!open)}
      >
        {text}
      </button>
      {open && (
        <div className="multi-filter-menu" role="listbox" aria-multiselectable aria-label={label}>
          {options.map(([v, l]) => (
            <label key={v} className="multi-filter-option">
              <input type="checkbox" checked={values.includes(v)} onChange={() => toggle(v)} />
              {l}
            </label>
          ))}
          {values.length > 0 && (
            <button className="link-button small more-link multi-filter-clear" onClick={() => onChange([])}>
              Clear
            </button>
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

/** Status, priority and Recommended filters for All tasks. */
export function TaskFilters({ filter, onChange }: { filter: TaskFilter; onChange: (f: TaskFilter) => void }) {
  return (
    <div className="task-filters">
      <MultiFilter label="Filter by status" anyLabel="Any status" values={filter.statuses} options={STATUSES} onChange={(statuses) => onChange({ ...filter, statuses })} />
      <MultiFilter label="Filter by priority" anyLabel="Any priority" values={filter.priorities} options={PRIORITIES} onChange={(priorities) => onChange({ ...filter, priorities })} />
      <RecommendedToggle on={filter.recommendedOnly} onChange={(recommendedOnly) => onChange({ ...filter, recommendedOnly })} />
    </div>
  );
}
