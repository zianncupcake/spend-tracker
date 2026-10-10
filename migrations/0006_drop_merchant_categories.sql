-- A purchase is in a category that is chosen by hand only when its own button
-- was pressed. What a user chose for one purchase at a merchant is no longer
-- kept for their later purchases there, so the table that kept it goes.

DROP TABLE merchant_categories;
