ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "debtHoldMaxInvoices" INTEGER,
  ADD COLUMN IF NOT EXISTS "debtHoldMaxAmount"   DECIMAL(10,2);
