-- Whether a purchase added by hand is a payment still to come when it was added:
-- 1 for one, which stays so whatever becomes of its date, and 0 for any other. Its
-- parser stays the manual one, so that it counts as a purchase added by hand.
ALTER TABLE transactions ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0;
