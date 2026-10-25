-- The bills of cards that a user paid, as their bank's emails tell of them:
-- only what is read from an email, as for a purchase. A payment is kept by the
-- last four digits of the card that was paid, whether or not the user has
-- added that card, and it stays when the card is removed, as purchases do.
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The id of the email, which makes one that is read again a duplicate.
  source_id TEXT NOT NULL,
  card_last4 TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  -- When the email came, in unix seconds.
  paid_at INTEGER NOT NULL,
  UNIQUE (owner_id, source_id)
) STRICT;
