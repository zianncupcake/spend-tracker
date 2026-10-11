-- The bot reads purchases out of a photo that a user sends it, and adds them.
-- A photo itself is never stored.

-- Purchases that were read from a message, and that the bot asks their user
-- about before it stores them: it could not tell which card they were made
-- with, or the model was not sure of an amount or a date. Those of one message
-- wait here as one batch, until their user answers with a button under the
-- bot's message, or for 24 hours.
CREATE TABLE held_batches (
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Telegram's id of the message that the purchases were read from. The
  -- buttons hold it, and a purchase is stored under it and its place in the
  -- reading, so that none is stored twice. A message that is delivered again
  -- replaces its batch.
  message_id INTEGER NOT NULL,
  -- The last four digits of the card that the purchases are added to. Null
  -- when the bot could not tell which card: the button that is pressed says.
  card_last4 TEXT,
  -- The key of the category that the message named for them. Null when it
  -- named none: a purchase then starts where its card's product puts it.
  category TEXT,
  -- The purchases, as a JSON array. Of each: its place in the reading, its
  -- day, its amount, its currency, its merchant, and whether the model was
  -- unsure of it.
  purchases TEXT NOT NULL,
  -- By the service's clock and not the database's, as the mail checker
  -- compares it with the times of its runs. A batch is not acted on from then
  -- on, and the next run deletes it.
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, message_id)
) STRICT;

-- For the run that deletes the batches whose time is up: it looks across all
-- users, every minute, and is not to read through all that are still held.
CREATE INDEX held_batches_expires_at ON held_batches (expires_at);
