CREATE TYPE "EmergencyStatus" AS ENUM ('ACTIVE', 'RESOLVED');

CREATE TABLE "TechnicianEmergency" (
  "id"                   TEXT NOT NULL,
  "technicianId"         TEXT NOT NULL,
  "roundId"              TEXT NOT NULL,
  "remainingStops"       INTEGER NOT NULL,
  "lastLocation"         TEXT,
  "scheduledWindowEnd"   TIMESTAMP(3),
  "notes"                TEXT,
  "status"               "EmergencyStatus" NOT NULL DEFAULT 'ACTIVE',
  "assignedTechnicianId" TEXT,
  "resolvedAt"           TIMESTAMP(3),
  "reportedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TechnicianEmergency_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TechnicianEmergency_technicianId_idx" ON "TechnicianEmergency"("technicianId");
CREATE INDEX "TechnicianEmergency_roundId_idx"       ON "TechnicianEmergency"("roundId");
CREATE INDEX "TechnicianEmergency_status_idx"        ON "TechnicianEmergency"("status");

ALTER TABLE "TechnicianEmergency"
  ADD CONSTRAINT "TechnicianEmergency_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TechnicianEmergency"
  ADD CONSTRAINT "TechnicianEmergency_roundId_fkey"
  FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TechnicianEmergency"
  ADD CONSTRAINT "TechnicianEmergency_assignedTechnicianId_fkey"
  FOREIGN KEY ("assignedTechnicianId") REFERENCES "Technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;
