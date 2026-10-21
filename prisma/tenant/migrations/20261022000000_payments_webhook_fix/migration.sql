-- Stripe: signing is now verified with one platform-wide Connect webhook
-- secret (STRIPE_CONNECT_WEBHOOK_SECRET env var), not a per-tenant one — the
-- per-tenant value here was never actually usable (RoundFlow invented it;
-- Stripe signs with its own, so verification always failed).
ALTER TABLE "BusinessSettings" DROP COLUMN IF EXISTS "stripeWebhookSecretEncrypted";

-- GoCardless: the real signing secret GoCardless generates for the
-- manually-created webhook endpoint, pasted in via
-- PATCH /settings/payment/gocardless/webhook-secret. Distinct from
-- gocardlessWebhookSecretEncrypted, which remains the ?secret= route-auth
-- token only.
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "gocardlessWebhookSigningSecretEncrypted" TEXT;
