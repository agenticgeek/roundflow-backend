-- ACT-01: per-item idempotency key + bulk-send batch id on the outbox. Additive, idempotent.
ALTER TABLE "IntegrationOutbox" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
ALTER TABLE "IntegrationOutbox" ADD COLUMN IF NOT EXISTS "batchId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationOutbox_dedupeKey_key" ON "IntegrationOutbox"("dedupeKey");
CREATE INDEX IF NOT EXISTS "IntegrationOutbox_batchId_idx" ON "IntegrationOutbox"("batchId");
