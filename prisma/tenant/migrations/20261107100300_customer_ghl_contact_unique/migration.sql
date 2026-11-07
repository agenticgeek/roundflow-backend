-- Wave 2B-1 (BE-27): one customer per GHL contact. Guarded: skipped (NOTICE) when duplicates already exist, so the
-- migration never fails and never deletes data. Resolve duplicates, then re-run this statement by hand.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Customer" WHERE "ghlContactId" IS NOT NULL GROUP BY "ghlContactId" HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'Customer.ghlContactId has duplicates: unique index skipped, clean up and re-run';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "Customer_ghlContactId_key" ON "Customer"("ghlContactId");
  END IF;
END $$;
