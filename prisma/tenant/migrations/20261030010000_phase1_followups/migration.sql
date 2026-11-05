-- Phase 1 audit remediation follow-ups (docs/handoff/backend/2026-10-30-phase1-audit-remediation-plan.md).
-- Additive only; every column is nullable or has a default, so existing rows
-- and older app builds are unaffected.

-- A7 / mobile cheque: manual-payment reference (cheque number, bank ref).
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "reference" TEXT;

-- A5 / B2: customer-level opt-out from automated messages (reminders, visit-completed).
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "messagesOptOut" BOOLEAN NOT NULL DEFAULT false;

-- A5: provider (GHL) message id for outbound messages.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "externalId" TEXT;

-- A6: round default service — invoice line-text fallback tier.
ALTER TABLE "Round" ADD COLUMN IF NOT EXISTS "defaultServiceId" TEXT;
CREATE INDEX IF NOT EXISTS "Round_defaultServiceId_idx" ON "Round"("defaultServiceId");
ALTER TABLE "Round"
  ADD CONSTRAINT "Round_defaultServiceId_fkey"
  FOREIGN KEY ("defaultServiceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
