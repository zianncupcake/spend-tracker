-- The reminder that a card's bill is due: a message to the card's user at
-- 09:00 by their own clock, on one day of every month.

-- The day of the month. A month that has no such day has the reminder on its
-- last day. Null for a card with no reminder.
ALTER TABLE cards ADD COLUMN remind_day INTEGER CHECK (remind_day BETWEEN 1 AND 31);

-- When the next reminder is due, in unix seconds: it is worked out from the
-- day and the user's time zone, and again when either changes or a reminder
-- is sent. Null for a card with no reminder. By the service's clock and not
-- the database's, as the scheduled run compares it with the times of its runs.
ALTER TABLE cards ADD COLUMN remind_at INTEGER
  CHECK ((remind_at IS NULL) = (remind_day IS NULL));

-- For the run that sends the reminder that has been due longest: it looks
-- across all users, every minute, and is not to read through all the cards.
CREATE INDEX cards_remind_at ON cards (remind_at);
