ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "gocardlessAccessTokenEncrypted"   TEXT,
  ADD COLUMN IF NOT EXISTS "gocardlessWebhookSecretEncrypted" TEXT,
  ADD COLUMN IF NOT EXISTS "gocardlessEnvironment"            TEXT;

ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "gocardlessCustomerId"    TEXT,
  ADD COLUMN IF NOT EXISTS "gocardlessMandateId"     TEXT,
  ADD COLUMN IF NOT EXISTS "gocardlessMandateStatus" TEXT;
