-- Auditable resolution detail for complaints: when, by whom, and any notes
-- (previously only the status flipped to RESOLVED, with no record of either).
ALTER TABLE "Complaint" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);
ALTER TABLE "Complaint" ADD COLUMN IF NOT EXISTS "resolvedBy" TEXT;
ALTER TABLE "Complaint" ADD COLUMN IF NOT EXISTS "notes" TEXT;
