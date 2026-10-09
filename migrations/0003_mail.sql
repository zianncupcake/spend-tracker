-- The mail checker: whose mailbox it reads next, and which alerts it has
-- already been through.

-- When the checker last ran for the connection, so that users are taken in
-- turn. This is not last_checked_at, which is the last time a run found
-- nothing left to read.
ALTER TABLE google_connections ADD COLUMN last_run_at INTEGER;

-- Alerts that were fetched and not stored, because no parser could read them
-- or they were not shown to be from the bank. Only the id is kept, so that an
-- alert is not fetched again on every run.
CREATE TABLE seen_alerts (
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unparsed', 'rejected')),
  seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (owner_id, source_id)
) STRICT;
