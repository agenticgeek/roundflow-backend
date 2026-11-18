-- Direct Debit setup links (2026-11-19): the GoCardless billing request a customer's new mandate comes from, plus the
-- last setup link made for them (copyable until it expires). Additive and idempotent; NOT applied by the agent (the
-- startup migrator applies it). New nullable columns only, so no rollback is needed.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "gocardlessBillingRequestId" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "ddSetupLinkUrl" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "ddSetupLinkSentAt" TIMESTAMPTZ;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "ddSetupLinkExpiresAt" TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_gocardlessBillingRequestId_key" ON "Customer"("gocardlessBillingRequestId");
