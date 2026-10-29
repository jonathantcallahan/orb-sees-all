-- Claude's read on a task the user wrote themselves: a drafted description when
-- they left none, who can do it, a first suggestion, and whether it's too vague.
CREATE TABLE task_assessments (
  task_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
