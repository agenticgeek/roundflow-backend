-- Partial-service price: keep the original price + the adjustment reason.
ALTER TABLE "Visit"
  ADD COLUMN IF NOT EXISTS "originalPrice" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "priceAdjustmentReason" TEXT;

-- Mobile Help & Support links.
ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "termsUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "privacyUrl" TEXT;

-- Mobile "Report a problem" submissions.
CREATE TABLE IF NOT EXISTS "SupportReport" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "appVersion" TEXT,
  "device" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "SupportReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SupportReport_createdAt_idx" ON "SupportReport" ("createdAt");
