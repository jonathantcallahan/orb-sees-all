-- Topics the user asked Demian to keep an eye on, each with outcomes to act on: "if this happens"
-- or "if this hasn't happened by a date", then a task to create. Outcomes and the latest check are JSON.
CREATE TABLE watched_topics (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  details TEXT,
  outcomes TEXT NOT NULL DEFAULT '[]',
  status TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL
);
