CREATE TABLE projects (
  channel_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  local_repos TEXT NOT NULL DEFAULT '[]',
  gh_repos TEXT NOT NULL DEFAULT '[]',
  last_refreshed_at TEXT,
  snapshot TEXT,
  repo_state TEXT,
  last_error TEXT
);

CREATE TABLE manual_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE calendar_days (
  date TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);

-- User state for any task (extracted or manual), kept apart so refreshes never overwrite it.
CREATE TABLE task_state (
  task_id TEXT PRIMARY KEY,
  done INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  scope TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  error TEXT,
  cost_usd REAL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
