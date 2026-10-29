import { useEffect, useState } from "react";
import { isFiltering, NO_FILTER, type PriorityFilter, type TaskFilter, type TaskStatus } from "../tasks";

const STATUSES: [TaskStatus, string][] = [
  ["todo", "To do"],
  ["in_progress", "In progress"],
  ["waiting", "Waiting"],
  ["done", "Done"],
];

const PRIORITIES: [PriorityFilter, string][] = [
  ["critical", "Critical"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
  ["unrated", "Unrated"],
];

const KEY = "task-filter";

/** The Tasks column filter, remembered across launches. */
export function useTaskFilter(): [TaskFilter, (f: TaskFilter) => void] {
  const [filter, setFilter] = useState<TaskFilter>(() => {
    try {
      return { ...NO_FILTER, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    } catch {
      return NO_FILTER;
    }
  });
  useEffect(() => localStorage.setItem(KEY, JSON.stringify(filter)), [filter]);
  return [filter, setFilter];
}

const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

export function TaskFilters({ filter, onChange }: { filter: TaskFilter; onChange: (f: TaskFilter) => void }) {
  return (
    <div className="task-filters small">
      <div className="filter-row">
        {STATUSES.map(([value, label]) => (
          <button
            key={value}
            className={`filter-chip-toggle${filter.statuses.includes(value) ? " on" : ""}`}
            onClick={() => onChange({ ...filter, statuses: toggle(filter.statuses, value) })}
          >
            {label}
          </button>
        ))}
        <span className="filter-sep" />
        <button
          className={`filter-chip-toggle recommended${filter.recommendedOnly ? " on" : ""}`}
          onClick={() => onChange({ ...filter, recommendedOnly: !filter.recommendedOnly })}
        >
          ✦ Recommended
        </button>
      </div>
      <div className="filter-row">
        {PRIORITIES.map(([value, label]) => (
          <button
            key={value}
            className={`filter-chip-toggle${filter.priorities.includes(value) ? " on" : ""}`}
            onClick={() => onChange({ ...filter, priorities: toggle(filter.priorities, value) })}
          >
            {label}
          </button>
        ))}
        {isFiltering(filter) && (
          <button className="link-button small filter-clear" onClick={() => onChange(NO_FILTER)}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
