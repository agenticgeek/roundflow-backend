-- Phase 1 audit remediation foundation (docs/handoff/backend/2026-10-30-phase1-audit-remediation-plan.md).
--
-- Enum additions: ALTER TYPE ... ADD VALUE is allowed inside the migration
-- transaction (PG 12+) as long as the new value is not used in the same
-- transaction — nothing below references CANCELLED / COLLECT_DAILY_BATCH,
-- so this is safe. Forward-only (no DROP VALUE).
ALTER TYPE "VisitStatus"   ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "PaymentTiming" ADD VALUE IF NOT EXISTS 'COLLECT_DAILY_BATCH';

CREATE TYPE "ReminderMode"        AS ENUM ('EVENING_BEFORE', 'MORNING_OF', 'NONE');
CREATE TYPE "CleanMethod"         AS ENUM ('TRADITIONAL', 'WATER_FED_POLE', 'BOTH');
CREATE TYPE "NoDirectDebitAction" AS ENUM ('SEND_INVOICE', 'SEND_PAYMENT_LINK');
CREATE TYPE "IncidentType"        AS ENUM ('STRIKE', 'DAMAGE', 'UPSELL');
CREATE TYPE "KpiOperator"         AS ENUM ('GT', 'LT');

-- A1: per-property technician allocation within a round.
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "assignedTechnicianId" TEXT;
CREATE INDEX IF NOT EXISTS "Property_assignedTechnicianId_idx" ON "Property"("assignedTechnicianId");
ALTER TABLE "Property"
  ADD CONSTRAINT "Property_assignedTechnicianId_fkey"
  FOREIGN KEY ("assignedTechnicianId") REFERENCES "Technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A1/A4/B2/GAP-029: visit override flag, cancel reason, reminder idempotency, revisit link.
ALTER TABLE "Visit"
  ADD COLUMN IF NOT EXISTS "technicianOverride" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "cancelReason" TEXT,
  ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "complaintId" TEXT;
CREATE INDEX IF NOT EXISTS "Visit_complaintId_idx" ON "Visit"("complaintId");
ALTER TABLE "Visit"
  ADD CONSTRAINT "Visit_complaintId_fkey"
  FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- B1/B2/GAP-008/GAP-002: business profile, reminders, payment defaults, wizard progress.
ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "addressLine1" TEXT,
  ADD COLUMN IF NOT EXISTS "addressLine2" TEXT,
  ADD COLUMN IF NOT EXISTS "town" TEXT,
  ADD COLUMN IF NOT EXISTS "postcode" TEXT,
  ADD COLUMN IF NOT EXISTS "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS "reminderMode" "ReminderMode" NOT NULL DEFAULT 'EVENING_BEFORE',
  ADD COLUMN IF NOT EXISTS "reminderTime" TEXT NOT NULL DEFAULT '19:00',
  ADD COLUMN IF NOT EXISTS "defaultCleanMethod" "CleanMethod",
  ADD COLUMN IF NOT EXISTS "autoCreateNextVisit" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "defaultPaymentMethod" "PaymentMethod",
  ADD COLUMN IF NOT EXISTS "invoiceDueDays" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS "noDirectDebitAction" "NoDirectDebitAction" NOT NULL DEFAULT 'SEND_INVOICE',
  ADD COLUMN IF NOT EXISTS "completedSteps" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

-- B6: upheld complaints count as technician strikes.
ALTER TABLE "Complaint" ADD COLUMN IF NOT EXISTS "upheld" BOOLEAN;

-- A7: manual mark-paid records when the invoice was paid.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);

-- B4: Photo.propertyId already exists (init migration) but uploads never set
-- it. Backfill from the photo's visit so admin galleries see historic photos.
UPDATE "Photo" p
SET "propertyId" = v."propertyId"
FROM "Visit" v
WHERE p."visitId" = v."id" AND p."propertyId" IS NULL;

-- B6: technician incidents (strikes, damage, upsells).
CREATE TABLE IF NOT EXISTS "TechnicianIncident" (
  "id"           TEXT NOT NULL,
  "technicianId" TEXT NOT NULL,
  "visitId"      TEXT,
  "type"         "IncidentType" NOT NULL,
  "amount"       DECIMAL(10,2),
  "note"         TEXT,
  "createdById"  TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "TechnicianIncident_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TechnicianIncident_technicianId_type_createdAt_idx"
  ON "TechnicianIncident"("technicianId", "type", "createdAt");
CREATE INDEX IF NOT EXISTS "TechnicianIncident_visitId_idx" ON "TechnicianIncident"("visitId");
ALTER TABLE "TechnicianIncident"
  ADD CONSTRAINT "TechnicianIncident_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TechnicianIncident"
  ADD CONSTRAINT "TechnicianIncident_visitId_fkey"
  FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- B6: KPI thresholds (one per metric + operator).
CREATE TABLE IF NOT EXISTS "KpiThreshold" (
  "id"        TEXT NOT NULL,
  "metric"    TEXT NOT NULL,
  "operator"  "KpiOperator" NOT NULL,
  "value"     DECIMAL(10,2) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "KpiThreshold_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "KpiThreshold_metric_operator_key" ON "KpiThreshold"("metric", "operator");

-- B6: crossed thresholds, de-duplicated per technician/metric/period.
CREATE TABLE IF NOT EXISTS "KpiAlert" (
  "id"           TEXT NOT NULL,
  "technicianId" TEXT NOT NULL,
  "metric"       TEXT NOT NULL,
  "value"        DECIMAL(10,2) NOT NULL,
  "threshold"    DECIMAL(10,2) NOT NULL,
  "operator"     "KpiOperator" NOT NULL,
  "periodKey"    TEXT NOT NULL,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "KpiAlert_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "KpiAlert_technicianId_metric_periodKey_key"
  ON "KpiAlert"("technicianId", "metric", "periodKey");
CREATE INDEX IF NOT EXISTS "KpiAlert_createdAt_idx" ON "KpiAlert"("createdAt");
ALTER TABLE "KpiAlert"
  ADD CONSTRAINT "KpiAlert_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- GAP-030: technician unavailability windows.
CREATE TABLE IF NOT EXISTS "TechnicianAvailability" (
  "id"           TEXT NOT NULL,
  "technicianId" TEXT NOT NULL,
  "from"         TIMESTAMP(3) NOT NULL,
  "to"           TIMESTAMP(3) NOT NULL,
  "reason"       TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "TechnicianAvailability_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TechnicianAvailability_technicianId_from_to_idx"
  ON "TechnicianAvailability"("technicianId", "from", "to");
ALTER TABLE "TechnicianAvailability"
  ADD CONSTRAINT "TechnicianAvailability_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A8: stored responses for X-Idempotency-Key replays on mobile writes.
CREATE TABLE IF NOT EXISTS "IdempotencyRecord" (
  "key"            TEXT NOT NULL,
  "technicianId"   TEXT NOT NULL,
  "route"          TEXT NOT NULL,
  "responseStatus" INTEGER NOT NULL,
  "responseBody"   JSONB NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);
CREATE INDEX IF NOT EXISTS "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");
