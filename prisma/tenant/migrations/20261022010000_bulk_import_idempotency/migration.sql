-- Idempotency tracking for POST /setup/step/9/bulk: a client-supplied key
-- lets a retried request (e.g. after a timeout) detect that the import
-- already ran instead of re-creating the same rows.
CREATE TABLE IF NOT EXISTS "BulkImportAttempt" (
  "id"             TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdCount"   INTEGER NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "BulkImportAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BulkImportAttempt_idempotencyKey_key" ON "BulkImportAttempt" ("idempotencyKey");
