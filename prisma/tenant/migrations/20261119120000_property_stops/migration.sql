-- One stop per property (2026-11-19, docs/PROPERTY_STOPS_PLAN_2026-11-19.md): every service done at a property in one
-- go is billed together. Visit.billedWithVisitId points a service at the visit that carries the shared payment and
-- invoice; InvoiceLine stores one line per service. Invoices made before this have no lines and render as before.
-- Additive and idempotent (new table + nullable column only); NOT applied by the agent (the startup migrator applies it).
ALTER TABLE "Visit" ADD COLUMN IF NOT EXISTS "billedWithVisitId" TEXT;
CREATE INDEX IF NOT EXISTS "Visit_billedWithVisitId_idx" ON "Visit"("billedWithVisitId");
DO $$ BEGIN
  ALTER TABLE "Visit" ADD CONSTRAINT "Visit_billedWithVisitId_fkey"
    FOREIGN KEY ("billedWithVisitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "InvoiceLine" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "visitId" TEXT,
  "description" TEXT NOT NULL,
  "netAmount" DECIMAL(10,2) NOT NULL,
  "vatAmount" DECIMAL(10,2) NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceLine_visitId_key" ON "InvoiceLine"("visitId");
CREATE INDEX IF NOT EXISTS "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");
DO $$ BEGIN
  ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_visitId_fkey"
    FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
