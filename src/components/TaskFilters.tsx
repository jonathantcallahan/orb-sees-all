import { useEffect, useRef, useState } from "react";
import type { ProjectPriority, ProjectStatus, Raci } from "../schema";
import { NO_FILTER, NO_PROJECT_FILTER, type AssistanceFilter, type DueFilter, type PriorityFilter, type ProjectFilter, type TaskFilter, type TaskSource, type TaskStatus } from "../tasks";

const SOURCES: [TaskSource, string][] = [
  ["project", "Projects"],
  ["request", "Requests"],
  ["own", "Ungrouped"],
];

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

/** Labelled as on the task cards. */
const ASSISTANCE: [AssistanceFilter, string][] = [
  ["claude", "Orb can do it"],
  ["assisted", "Orb can help"],
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
  return (
    <div className="task-filters">
      {showSource && (
        <MultiFilter label="Filter by source" anyLabel="Source" values={filter.sources} options={SOURCES} onChange={(sources) => onChange({ ...filter, sources })} />
      )}
      <MultiFilter label="Filter by status" anyLabel="Status" values={filter.statuses} options={STATUSES} onChange={(statuses) => onChange({ ...filter, statuses })} />
      <MultiFilter label="Filter by priority" anyLabel="Priority" values={filter.priorities} options={PRIORITIES} onChange={(priorities) => onChange({ ...filter, priorities })} />
      <MultiFilter label="Filter by due date" anyLabel="Due" values={filter.dues} options={DUES} onChange={(dues) => onChange({ ...filter, dues })} />
      <MultiFilter label="Filter by what Orb can do" anyLabel="Orb" values={filter.assistance} options={ASSISTANCE} onChange={(assistance) => onChange({ ...filter, assistance })} />
      <RecommendedToggle on={filter.recommendedOnly} onChange={(recommendedOnly) => onChange({ ...filter, recommendedOnly })} />
    </div>
  );
}
