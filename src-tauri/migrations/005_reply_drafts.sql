-- Claude's drafted replies for Inbox messages, keyed by the message id.
CREATE TABLE reply_drafts (
  reply_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cost_usd REAL
);
