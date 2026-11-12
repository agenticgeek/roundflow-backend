-- Wave 2B-2: record the payment method the technician chose when completing a visit. Additive, nullable, idempotent.
ALTER TABLE "Visit" ADD COLUMN IF NOT EXISTS "collectedVia" "PaymentMethod";
