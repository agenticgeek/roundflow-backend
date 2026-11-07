-- Wave 2B-1 (BE-03): webhook events keep their processing state and payload so a failed event can be retried.
-- Existing rows count as DONE (they were recorded before this change). Additive and idempotent.
ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'DONE';
ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "payload" JSONB;
ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS "WebhookEvent_status_updatedAt_idx" ON "WebhookEvent"("status", "updatedAt");
