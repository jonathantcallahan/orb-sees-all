import { useEffect, useState } from "react";
import { NO_FILTER, type PriorityFilter, type TaskFilter, type TaskStatus } from "../tasks";

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

/** The All tasks filter, remembered across launches. */
export function useTaskFilter(): [TaskFilter, (f: TaskFilter) => void] {
  const [filter, setFilter] = useState<TaskFilter>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      // Older versions stored lists of values; start fresh from those.
      return Array.isArray(stored.statuses) ? NO_FILTER : { ...NO_FILTER, ...stored };
    } catch {
      return NO_FILTER;
    }
  });
  useEffect(() => localStorage.setItem(KEY, JSON.stringify(filter)), [filter]);
  return [filter, setFilter];
}

/** One control per category: status, priority, and a Recommended toggle. */
export function TaskFilters({ filter, onChange }: { filter: TaskFilter; onChange: (f: TaskFilter) => void }) {
  return (
    <div className="task-filters">
      <select
        className={`filter-select${filter.status ? " on" : ""}`}
        value={filter.status ?? ""}
        aria-label="Filter by status"
        onChange={(e) => onChange({ ...filter, status: (e.target.value || null) as TaskStatus | null })}
      >
        <option value="">Any status</option>
        {STATUSES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <select
        className={`filter-select${filter.priority ? " on" : ""}`}
        value={filter.priority ?? ""}
        aria-label="Filter by priority"
        onChange={(e) => onChange({ ...filter, priority: (e.target.value || null) as PriorityFilter | null })}
      >
        <option value="">Any priority</option>
        {PRIORITIES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button
        className={`filter-select recommended${filter.recommendedOnly ? " on" : ""}`}
        aria-pressed={filter.recommendedOnly}
        onClick={() => onChange({ ...filter, recommendedOnly: !filter.recommendedOnly })}
      >
        ✦ Recommended
      </button>
    </div>
  );
}
