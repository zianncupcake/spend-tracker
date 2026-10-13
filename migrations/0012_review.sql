-- The monthly review, which the README describes under "Monthly patterns":
-- once a month the bot offers a user the spending that looks monthly as
-- patterns to add.

-- When the user's next review is due, in unix seconds: 09:00 on the 1st of a
-- month by their own clock, or 0 while none is set. By the service's clock
-- and not the database's, as the scheduled run compares it with the times of
-- its runs.
ALTER TABLE users ADD COLUMN review_at INTEGER NOT NULL DEFAULT 0;

-- For the run that reviews the user who has been due longest: it looks across
-- all users, every minute, and is not to read through all of them.
CREATE INDEX users_review_at ON users (review_at);

-- What a review has offered, so that it is not offered again. It is keyed as
-- a pattern is: `letters` are those of the merchant's name. A card that is
-- removed takes its rows with it, and so does a user who is deleted, whose
-- cards go.
CREATE TABLE pattern_offers (
  owner_id INTEGER NOT NULL,
  card_last4 TEXT NOT NULL,
  letters TEXT NOT NULL,
  PRIMARY KEY (owner_id, card_last4, letters),
  FOREIGN KEY (owner_id, card_last4) REFERENCES cards (owner_id, last4) ON DELETE CASCADE
) STRICT;
