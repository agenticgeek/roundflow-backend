-- Enforce single-default invariant at the DB level.
-- Only one ServiceArea row may have isDefault = true at any time.
-- Prisma's array-form transactions use READ COMMITTED isolation, so a
-- concurrent updateMany + create can produce two defaults without this index.
CREATE UNIQUE INDEX "ServiceArea_single_default"
  ON "ServiceArea" (("isDefault"))
  WHERE "isDefault" = true;
