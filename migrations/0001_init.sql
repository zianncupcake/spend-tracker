-- Only the fields extracted from a bank alert are stored, never the email text itself.
-- STRICT makes SQLite enforce the declared column types.

CREATE TABLE users (
  -- AUTOINCREMENT: the id of a deleted user is never handed to a later one.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'Asia/Singapore',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  last4 TEXT NOT NULL,
  window_type TEXT NOT NULL CHECK (window_type IN ('statement', 'calendar')),
  statement_day INTEGER CHECK (statement_day BETWEEN 1 AND 31),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (owner_id, last4),
  UNIQUE (owner_id, nickname),
  CHECK (window_type <> 'statement' OR statement_day IS NOT NULL)
) STRICT;

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  card_last4 TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  merchant TEXT,
  occurred_at INTEGER NOT NULL,
  parser TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (owner_id, source_id)
) STRICT;

CREATE INDEX transactions_owner_card_time ON transactions (owner_id, card_last4, occurred_at);
