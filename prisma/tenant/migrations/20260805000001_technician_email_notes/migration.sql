-- Add email (unique — one invite per address per tenant) and notes fields to Technician.
ALTER TABLE "Technician" ADD COLUMN "email" TEXT;
ALTER TABLE "Technician" ADD COLUMN "notes" TEXT;
CREATE UNIQUE INDEX "Technician_email_key" ON "Technician"("email");
