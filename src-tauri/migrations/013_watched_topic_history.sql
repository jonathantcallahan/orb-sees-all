-- Every update a watched topic's checks found, newest last: when it was collected, what it said and its sources.
ALTER TABLE watched_topics ADD COLUMN history TEXT NOT NULL DEFAULT '[]';
