-- Whether a payment's alert told that it went through: 1 for one that did, and
-- 0 for one that told it was made or scheduled.
ALTER TABLE payments ADD COLUMN made INTEGER NOT NULL DEFAULT 0 CHECK (made IN (0, 1));
