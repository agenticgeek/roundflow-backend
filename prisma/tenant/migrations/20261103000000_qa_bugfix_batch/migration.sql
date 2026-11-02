-- QA bug batch 2026-11-03. Additive only; every column has a default or is nullable.

-- BUG-01: pre-clean reminders as a list of { type, time }. Existing single
-- reminderMode/reminderTime values are migrated into the list (NONE -> []).
ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "preCleanReminders" JSONB NOT NULL DEFAULT '[{"type":"EVENING_BEFORE","time":"19:00"}]';
UPDATE "BusinessSettings"
  SET "preCleanReminders" = CASE
    WHEN "reminderMode"::text = 'NONE' THEN '[]'::jsonb
    ELSE jsonb_build_array(jsonb_build_object('type', "reminderMode"::text, 'time', "reminderTime"))
  END;

-- BUG-01: per-reminder-type sent marker so each reminder goes out once per visit.
ALTER TABLE "Visit" ADD COLUMN IF NOT EXISTS "reminderSentTypes" TEXT[] NOT NULL DEFAULT '{}';
UPDATE "Visit"
  SET "reminderSentTypes" = ARRAY[COALESCE((SELECT "reminderMode"::text FROM "BusinessSettings" LIMIT 1), 'EVENING_BEFORE')]
  WHERE "reminderSentAt" IS NOT NULL AND "reminderSentTypes" = '{}';

-- BUG-04: postcode sectors covered by a round.
ALTER TABLE "Round" ADD COLUMN IF NOT EXISTS "postcodeSectors" TEXT[] NOT NULL DEFAULT '{}';

-- BUG-05: accepted payment methods (default must be one of them; empty = not configured).
ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "acceptedPaymentMethods" "PaymentMethod"[] NOT NULL DEFAULT ARRAY[]::"PaymentMethod"[];
UPDATE "BusinessSettings"
  SET "acceptedPaymentMethods" = ARRAY["defaultPaymentMethod"]
  WHERE "defaultPaymentMethod" IS NOT NULL AND "acceptedPaymentMethods" = ARRAY[]::"PaymentMethod"[];

-- BUG-08: per-record activity history (e.g. property service changes).
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "entityId" TEXT;
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "details" JSONB;
CREATE INDEX IF NOT EXISTS "ActivityLog_entityId_createdAt_idx" ON "ActivityLog"("entityId", "createdAt");

-- Chat (office <-> technician): sender role, idempotent client message id, read markers.
CREATE TYPE "ChatSenderRole" AS ENUM ('TECHNICIAN', 'OFFICE');
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "senderRole" "ChatSenderRole" NOT NULL DEFAULT 'TECHNICIAN';
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "clientMsgId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_roundId_senderProfileId_clientMsgId_key"
  ON "ChatMessage"("roundId", "senderProfileId", "clientMsgId");

CREATE TABLE IF NOT EXISTS "ChatRead" (
  "profileId"  TEXT NOT NULL,
  "roundId"    TEXT NOT NULL,
  "lastReadAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatRead_pkey" PRIMARY KEY ("profileId", "roundId")
);
CREATE INDEX IF NOT EXISTS "ChatRead_roundId_idx" ON "ChatRead"("roundId");

-- Inbound GHL replies: unread until the office marks them read.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMPTZ;
UPDATE "Message" SET "readAt" = "createdAt" WHERE "direction" = 'INBOUND' AND "readAt" IS NULL AND "createdAt" < now() - interval '30 days';
