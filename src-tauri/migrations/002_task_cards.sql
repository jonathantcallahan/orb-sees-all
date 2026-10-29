ALTER TABLE manual_tasks ADD COLUMN description TEXT;

-- Latest Claude-proposed plan for any task, keyed like task_state.
CREATE TABLE task_plans (
  task_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cost_usd REAL
);
