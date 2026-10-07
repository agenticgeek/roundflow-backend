ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "ghlWebhookSecretEncrypted" TEXT;
