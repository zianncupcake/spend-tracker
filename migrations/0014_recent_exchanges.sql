-- A user's last few questions to the assistant, each with the text of the
-- bot's reply, so that the assistant can follow a conversation: it is sent
-- them before a new question. A row lives 30 minutes, and the scheduled run
-- then deletes it.
CREATE TABLE recent_exchanges (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- When the reply was sent, in unix seconds, by the service's clock.
  at INTEGER NOT NULL,
  question TEXT NOT NULL,
  reply TEXT NOT NULL,
  -- Whether the reply can hold a merchant's name, which is text that somebody
  -- else wrote: it showed what a tool or a command read, or the model wrote it
  -- after reading purchases.
  read INTEGER NOT NULL CHECK (read IN (0, 1))
) STRICT;

CREATE INDEX recent_exchanges_owner_at ON recent_exchanges (owner_id, at);
