-- A user is no longer limited to so many questions in a day: the only limit
-- on how many are answered is the AI provider's own. So nothing is counted
-- any more, and the table that kept the count goes.

DROP TABLE ai_questions;
