-- Task identity across sources. A task keeps the id it was first seen with (its canonical id);
-- every other message, thread or ticket about the same work maps onto it here, including tasks
-- merged into it. Lookups resolve any ref to its canonical id.
CREATE TABLE task_sources (
  ref TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  -- 'refined' (a refresh said it refines the task), 'merged' (the user merged it in)
  how TEXT NOT NULL
);
CREATE INDEX task_sources_task ON task_sources(task_id);

-- Per-task and per-blocker data that used to live in one JSON blob per kind in settings. One row
-- per item, so concurrent jobs can't overwrite each other's saves.
CREATE TABLE task_data (
  store TEXT NOT NULL,
  task_id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store, task_id)
);

INSERT OR REPLACE INTO task_data (store, task_id, value, updated_at)
SELECT s.key, j.key,
       CASE j.type WHEN 'text' THEN json_quote(j.value) ELSE j.value END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM settings s, json_each(s.value) j
WHERE s.key IN ('description_overrides', 'priority_overrides', 'session_links', 'task_checks', 'blocker_checks', 'reminders')
  AND json_valid(s.value);

DELETE FROM settings
WHERE key IN ('description_overrides', 'priority_overrides', 'session_links', 'task_checks', 'blocker_checks', 'reminders');
