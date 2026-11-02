-- Every correction the user makes (an edited description, a changed priority, a dismissal, a plan
-- reworked, a message edited before sending, a project renamed or split), with why when known, so
-- later refreshes and plans learn from it.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- 'task', 'project', 'plan', 'message' or 'briefing'
  subject TEXT NOT NULL,
  subject_id TEXT,
  project_id TEXT,
  -- JSON: what it was and what the user made it
  before TEXT,
  after TEXT,
  reason TEXT,
  -- 'user' (typed it), 'chat' (said it in a chat) or 'inferred' (worked out later)
  reason_source TEXT,
  -- 'ui' or 'chat'
  source TEXT NOT NULL DEFAULT 'ui',
  -- Folded into the lessons yet
  distilled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX feedback_project ON feedback(project_id);
CREATE INDEX feedback_subject ON feedback(subject, subject_id);

-- Standing guidance distilled from the feedback, each scoped to where it applies:
-- 'global', 'projects', 'tasks', 'priority', 'plans', 'writing' or 'project:<id>'.
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  text TEXT NOT NULL,
  -- JSON array of feedback ids it came from
  evidence TEXT NOT NULL DEFAULT '[]',
  -- 'learned' or 'user' (written or edited by the user, never rewritten by distilling)
  origin TEXT NOT NULL DEFAULT 'learned',
  updated_at TEXT NOT NULL
);
