-- Mirrors BusinessSettings.stripeConnectAccountId (tenant schema) onto the
-- public Tenant row so the platform-level Stripe Connect webhook can resolve
-- event.account -> tenant with one query, without first knowing which
-- tenant schema to look in.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "stripeConnectAccountId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_stripeConnectAccountId_key" ON "Tenant"("stripeConnectAccountId");
