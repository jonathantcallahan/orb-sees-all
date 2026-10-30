-- A project is its own entity, no longer one #tmp- channel. It keeps its row in projects (keyed by
-- the channel it was first found in, so existing task links stay valid) and gains:
--   * any number of Slack channels, found by discovery or linked by the user;
--   * a profile: what's known about the project (goal, people, resources, milestones, decisions),
--     refined by every refresh, apart from the snapshot of its current status;
--   * a state: tracked on the board, suggested by discovery, ignored, or merged into another project.
ALTER TABLE projects ADD COLUMN profile TEXT;
ALTER TABLE projects ADD COLUMN state TEXT NOT NULL DEFAULT 'tracked';
ALTER TABLE projects ADD COLUMN merged_into TEXT;
ALTER TABLE projects ADD COLUMN found_reason TEXT;

CREATE TABLE project_channels (
  channel_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- 'primary' (the project's main channel), 'related' (another channel about it), 'excluded'
  -- (the user unlinked it, so discovery leaves it alone)
  role TEXT NOT NULL,
  -- 'discovered' or 'user'; links the user made are never changed by discovery
  origin TEXT NOT NULL,
  reason TEXT,
  added_at TEXT NOT NULL
);
CREATE INDEX project_channels_project ON project_channels(project_id);

INSERT OR IGNORE INTO project_channels (channel_id, project_id, name, role, origin, reason, added_at)
SELECT channel_id, channel_id, name, 'primary', 'discovered', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM projects;

-- Projects the user hid before are ignored ones now.
UPDATE projects SET state = 'ignored' WHERE hidden = 1;
