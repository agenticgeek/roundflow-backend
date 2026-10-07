CREATE TABLE IF NOT EXISTS "IntegrationOutbox" (
  "id"          TEXT         NOT NULL PRIMARY KEY,
  "eventType"   TEXT         NOT NULL,
  "payload"     JSONB        NOT NULL,
  "status"      TEXT         NOT NULL DEFAULT 'pending',
  "attempts"    INTEGER      NOT NULL DEFAULT 0,
  "lastError"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "IntegrationOutbox_status_createdAt_idx"
  ON "IntegrationOutbox" ("status", "createdAt");
