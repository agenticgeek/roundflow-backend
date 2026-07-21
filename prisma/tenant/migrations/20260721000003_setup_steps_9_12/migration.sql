-- CreateEnum: PropertyType
CREATE TYPE "PropertyType" AS ENUM ('HOUSE', 'FLAT_APARTMENT', 'COMMERCIAL', 'OFFICE', 'CONSERVATORY');

-- AlterTable: Property.propertyType String? → PropertyType?
-- Any existing values that do not match a valid enum label are set to NULL.
ALTER TABLE "Property"
  ALTER COLUMN "propertyType" TYPE "PropertyType"
  USING CASE "propertyType"
    WHEN 'HOUSE'          THEN 'HOUSE'::"PropertyType"
    WHEN 'FLAT_APARTMENT' THEN 'FLAT_APARTMENT'::"PropertyType"
    WHEN 'COMMERCIAL'     THEN 'COMMERCIAL'::"PropertyType"
    WHEN 'OFFICE'         THEN 'OFFICE'::"PropertyType"
    WHEN 'CONSERVATORY'   THEN 'CONSERVATORY'::"PropertyType"
    ELSE NULL
  END;

-- AlterTable: ServicePlan — add cleaningFrequency column
ALTER TABLE "ServicePlan" ADD COLUMN "cleaningFrequency" "CleaningFrequency";

-- CreateTable: RoundTechnician (many-to-many Round ↔ Technician)
-- M-5: FK constraints are explicit so orphan rows are rejected at the DB level
-- if a Round or Technician is deleted (ON DELETE CASCADE keeps the join table
-- consistent without requiring extra application-side cleanup).
CREATE TABLE "RoundTechnician" (
    "roundId"      TEXT         NOT NULL,
    "technicianId" TEXT         NOT NULL,
    "assignedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoundTechnician_pkey"            PRIMARY KEY ("roundId", "technicianId"),
    CONSTRAINT "RoundTechnician_roundId_fkey"    FOREIGN KEY ("roundId")      REFERENCES "Round"("id")      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoundTechnician_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RoundTechnician_technicianId_idx" ON "RoundTechnician"("technicianId");
