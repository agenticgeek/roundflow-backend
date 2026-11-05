-- Technician Photo Archive: admin review state on photos. Additive only.
-- Photos that exist when this runs are backfilled APPROVED (nothing floods the
-- review queue); the column default is then switched to PENDING so every new
-- upload starts in the queue.

CREATE TYPE "PhotoReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "Photo" ADD COLUMN "reviewStatus" "PhotoReviewStatus" NOT NULL DEFAULT 'APPROVED';
ALTER TABLE "Photo" ALTER COLUMN "reviewStatus" SET DEFAULT 'PENDING';
ALTER TABLE "Photo" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "Photo" ADD COLUMN "reviewedById" TEXT;

CREATE INDEX "Photo_reviewStatus_idx" ON "Photo"("reviewStatus");
