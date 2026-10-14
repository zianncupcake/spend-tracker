-- What a user last marked a purchase at a merchant as, by the merchant's name,
-- on a product that goes by the codes of merchants: it places their later
-- purchases there that no rule places, before any code is looked up. See the
-- README under "Card products". Unlike the table that 0006 dropped, it never
-- overrides a rule of the product, as the rules come first.
CREATE TABLE merchant_marks (
  owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The key of the card product.
  product TEXT NOT NULL,
  -- The letters and digits of the name alone, in lower case, which a purchase
  -- is matched by, as a pattern is.
  letters TEXT NOT NULL,
  -- The name, as `nameOf` makes it from the text of the purchase.
  merchant TEXT NOT NULL,
  -- The key of a category of the product.
  category TEXT NOT NULL,
  PRIMARY KEY (owner_id, product, letters)
) STRICT;
