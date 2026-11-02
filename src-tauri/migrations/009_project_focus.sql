-- What a project is, as the user means it. Refreshes read these and never overwrite them: the
-- user's name for it, what it's about and isn't, and the other names it goes by.
CREATE TABLE project_focus (
  project_id TEXT PRIMARY KEY,
  pinned_name TEXT,
  focus TEXT,
  in_scope TEXT,
  out_of_scope TEXT,
  -- JSON array
  aliases TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

-- Past profiles, newest kept, so a refresh that drifts can be compared with what came before.
CREATE TABLE project_profile_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX project_profile_history_project ON project_profile_history(project_id, at);
