-- The bot's assistant answers a question that a user asks in their own words.
-- Each answer is asked of an AI provider, which takes only so many requests in
-- a day from all of the service's users together. So a user is answered only
-- so many questions in a day.

-- How many questions a user has had answered on a day, so that the count and
-- the limit on it are one statement. The day is a day of the user's own
-- calendar, written YYYY-MM-DD: it begins and ends by their time zone. Neither
-- a question nor its answer is stored.
CREATE TABLE ai_questions (
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (owner_id, day)
) STRICT;
