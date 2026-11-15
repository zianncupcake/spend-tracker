-- A payment can be one that its user tells the bot of, which has no amount, so
-- amount_minor and currency may be null. SQLite cannot drop a NOT NULL from a
-- column, so the table is made again with the same rows. No table refers to it.
CREATE TABLE payments_new (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  card_last4 TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT,
  paid_at INTEGER NOT NULL,
  made INTEGER NOT NULL DEFAULT 0 CHECK (made IN (0, 1)),
  UNIQUE (owner_id, source_id)
) STRICT;

INSERT INTO payments_new (id, owner_id, source_id, card_last4, amount_minor, currency, paid_at, made)
SELECT id, owner_id, source_id, card_last4, amount_minor, currency, paid_at, made FROM payments;

DROP TABLE payments;

ALTER TABLE payments_new RENAME TO payments;
