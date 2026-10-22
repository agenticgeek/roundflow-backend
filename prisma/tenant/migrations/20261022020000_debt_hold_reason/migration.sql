-- Auditable detail for PATCH /debt/:id/hold: why a customer was put on hold
-- and when, alongside the existing boolean flag.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "holdReason" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "holdSince" TIMESTAMP(3);
