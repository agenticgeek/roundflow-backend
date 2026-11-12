-- Wave 2B-1 (BE-07/BE-08): new payment states + unique provider ids. Additive and idempotent.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';

-- Unique provider ids. Guarded: when a tenant already holds duplicates the index is skipped (NOTICE) so the
-- migration never fails and never deletes data; the code tolerates both (it catches P2002 where the index exists).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Payment" WHERE "stripeId" IS NOT NULL GROUP BY "stripeId" HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'Payment.stripeId has duplicates: unique index skipped, clean up and re-run';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "Payment_stripeId_key" ON "Payment"("stripeId");
  END IF;
  IF EXISTS (SELECT 1 FROM "Payment" WHERE "gocardlessId" IS NOT NULL GROUP BY "gocardlessId" HAVING COUNT(*) > 1) THEN
    RAISE NOTICE 'Payment.gocardlessId has duplicates: unique index skipped, clean up and re-run';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "Payment_gocardlessId_key" ON "Payment"("gocardlessId");
  END IF;
END $$;
