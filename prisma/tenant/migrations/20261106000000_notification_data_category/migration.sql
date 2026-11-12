-- Wave 1 (NOTIF-01/02/03): notifications carry a deep-link payload and a
-- preference category. Additive and nullable: existing rows stay valid.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "data" JSONB;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "category" TEXT;
