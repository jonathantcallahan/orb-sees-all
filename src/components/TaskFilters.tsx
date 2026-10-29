import { useEffect, useState } from "react";
import type { ProjectPriority, ProjectStatus } from "../schema";
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

/** The All tasks filter. Older versions stored lists of values; those start fresh. */
export const useTaskFilter = () => useStoredFilter<TaskFilter>("task-filter", NO_FILTER, (s) => Array.isArray(s.statuses));

export const useProjectFilter = () => useStoredFilter<ProjectFilter>("project-filter", NO_PROJECT_FILTER);

function FilterSelect<V extends string>({
  value,
  anyLabel,
  options,
  label,
  onChange,
}: {
  value: V | null;
  anyLabel: string;
  options: [V, string][];
  label: string;
  onChange: (v: V | null) => void;
}) {
  return (
    <select
      className={`filter-select${value ? " on" : ""}`}
      value={value ?? ""}
      aria-label={label}
      onChange={(e) => onChange((e.target.value || null) as V | null)}
    >
      <option value="">{anyLabel}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function RecommendedToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button className={`filter-select recommended${on ? " on" : ""}`} aria-pressed={on} onClick={() => onChange(!on)}>
      ✦ Recommended
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

/** Status, priority and Recommended filters for the Projects column. */
export function ProjectFilters({ filter, onChange }: { filter: ProjectFilter; onChange: (f: ProjectFilter) => void }) {
  return (
    <div className="task-filters">
      <FilterSelect label="Filter projects by status" anyLabel="Any status" value={filter.status} options={PROJECT_STATUSES} onChange={(status) => onChange({ ...filter, status })} />
      <FilterSelect label="Filter projects by priority" anyLabel="Any priority" value={filter.priority} options={PROJECT_PRIORITIES} onChange={(priority) => onChange({ ...filter, priority })} />
      <RecommendedToggle on={filter.recommendedOnly} onChange={(recommendedOnly) => onChange({ ...filter, recommendedOnly })} />
    </div>
  );
}

/** Status, priority and Recommended filters for All tasks. */
export function TaskFilters({ filter, onChange }: { filter: TaskFilter; onChange: (f: TaskFilter) => void }) {
  return (
    <div className="task-filters">
      <FilterSelect label="Filter by status" anyLabel="Any status" value={filter.status} options={STATUSES} onChange={(status) => onChange({ ...filter, status })} />
      <FilterSelect label="Filter by priority" anyLabel="Any priority" value={filter.priority} options={PRIORITIES} onChange={(priority) => onChange({ ...filter, priority })} />
      <RecommendedToggle on={filter.recommendedOnly} onChange={(recommendedOnly) => onChange({ ...filter, recommendedOnly })} />
    </div>
  );
}
