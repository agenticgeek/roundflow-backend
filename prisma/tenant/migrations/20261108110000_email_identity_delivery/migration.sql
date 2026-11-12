-- Wave 2B-2 (GHL-03/07/10/11): per-tenant email identity and branding, message delivery tracking, customer email
-- validity. Additive and idempotent where PostgreSQL allows; NOT applied by the agent (startup migrator applies it).
DO $$ BEGIN
  CREATE TYPE "EmailDomainStatus" AS ENUM ('NONE', 'PENDING', 'VERIFIED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "MessageDeliveryStatus" AS ENUM ('SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailSenderName" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailReplyTo" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailSenderDomain" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailSenderLocalPart" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailDomainStatus" "EmailDomainStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailDkimRecords" JSONB;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailDomainVerifiedAt" TIMESTAMPTZ;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailDailyLimit" INTEGER;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailPausedReason" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "emailPausedAt" TIMESTAMPTZ;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "logoPath" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "logoAltText" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "brandColour" TEXT;

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "emailInvalidAt" TIMESTAMPTZ;

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "deliveryStatus" "MessageDeliveryStatus";
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "deliveryUpdatedAt" TIMESTAMPTZ;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "deliveryError" TEXT;
CREATE INDEX IF NOT EXISTS "Message_externalId_idx" ON "Message"("externalId");

-- GHL is an optional add-on: CRM events queued for a tenant that has not connected GHL will never be useful.
-- One-off cleanup: park them as 'dropped' (the worker now drops them at drain time and never queues new ones).
-- message.send / message.visit_completed / invoice.send are NOT touched (email is native).
UPDATE "IntegrationOutbox"
SET "status" = 'dropped', "lastError" = 'GoHighLevel is not connected', "processedAt" = COALESCE("processedAt", now())
WHERE "status" IN ('pending', 'failed', 'dead')
  AND "eventType" IN ('customer.synced', 'visit.completed', 'visit.scheduled', 'payment.collected', 'payment.failed',
                      'debt.overdue', 'complaint.logged', 'complaint.resolved')
  AND NOT EXISTS (SELECT 1 FROM "BusinessSettings" WHERE "ghlConnected" = true);
