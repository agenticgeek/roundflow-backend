-- Technician end-of-day sign-off (POST /mobile/day/close). Additive; hand-written.
CREATE TABLE IF NOT EXISTS "TechnicianDayClose" (
    "id" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "closedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL,

    CONSTRAINT "TechnicianDayClose_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TechnicianDayClose_technicianId_date_key" ON "TechnicianDayClose"("technicianId", "date");
CREATE INDEX IF NOT EXISTS "TechnicianDayClose_date_idx" ON "TechnicianDayClose"("date");

ALTER TABLE "TechnicianDayClose" ADD CONSTRAINT "TechnicianDayClose_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
