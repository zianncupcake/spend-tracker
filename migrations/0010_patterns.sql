-- A user's monthly patterns, which the README describes under "Monthly
-- patterns".
CREATE TABLE patterns (
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The last four digits of the card. A card that is removed takes its
  -- patterns with it.
  card_last4 TEXT NOT NULL,
  -- The letters and digits of the merchant's name alone, in lower case, which
  -- a purchase is matched by. A card has one pattern for them, however the
  -- name is spelt: "7eleven" takes the place of "7 eleven".
  letters TEXT NOT NULL,
  -- The name as its user gave it: trimmed, with single blanks, in lower case.
  -- It is what is shown, and what tells which group the pattern counts
  -- against.
  merchant TEXT NOT NULL,
  -- In hundredths of the unit of the card's own currency.
  amount_minor INTEGER NOT NULL,
  -- The days on which a charge that would have come will not, as a JSON array
  -- of YYYY-MM-DD: each once, in the order of the calendar.
  skips TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (owner_id, card_last4, letters)
) STRICT;
