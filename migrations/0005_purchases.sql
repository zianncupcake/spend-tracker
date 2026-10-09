-- What a user does with purchases: sorts them into the reward categories of a
-- card product, adds them by hand, and takes them out.

-- The key of the product in the built-in catalogue (src/catalogue) that the
-- card is linked to. Null for a card that is linked to none.
ALTER TABLE cards ADD COLUMN product TEXT;

-- The key of the category of its card's product that a purchase is sorted
-- into. Null while it is not sorted.
ALTER TABLE transactions ADD COLUMN category TEXT;

-- When its user took the purchase out. The row is kept, so that the alert it
-- was read from still counts as known and is never stored again. Whatever
-- totals, lists or counts purchases leaves these rows out.
ALTER TABLE transactions ADD COLUMN removed_at INTEGER;

-- The category that a user last chose for a purchase at a merchant, which is
-- where their later purchases there start. A merchant is known by its text, as
-- a purchase has it, in any case.
CREATE TABLE merchant_categories (
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  merchant TEXT NOT NULL COLLATE NOCASE,
  category TEXT NOT NULL,
  PRIMARY KEY (owner_id, product, merchant)
) STRICT;
