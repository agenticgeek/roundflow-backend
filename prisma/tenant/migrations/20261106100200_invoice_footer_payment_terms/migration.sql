-- GHL-10: optional invoice footer + payment terms text on BusinessSettings. Additive, idempotent.
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "invoiceFooter" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "paymentTerms" TEXT;
