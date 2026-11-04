-- A watched topic can belong to a project, like a task.
ALTER TABLE watched_topics ADD COLUMN project_id TEXT;
