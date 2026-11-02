-- Scheduled round messages: delayed outbox rows. Additive and nullable (null = due now).
ALTER TABLE "IntegrationOutbox" ADD COLUMN IF NOT EXISTS "runAfter" TIMESTAMP(3);
