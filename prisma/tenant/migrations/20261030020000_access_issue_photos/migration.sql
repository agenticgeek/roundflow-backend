-- Mobile contract follow-ups: photos attached to an access-issue report
-- (POST /mobile/visits/:id/access-issues `photoPaths`). Additive only — a new
-- enum value and a nullable FK column; existing rows and older app builds are
-- unaffected.

-- New PhotoType for access-issue photos (kept apart from BEFORE/AFTER work photos).
ALTER TYPE "PhotoType" ADD VALUE IF NOT EXISTS 'ACCESS_ISSUE';

-- Photo → Issue link (null for every pre-existing photo).
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "issueId" TEXT;
CREATE INDEX IF NOT EXISTS "Photo_issueId_idx" ON "Photo"("issueId");
ALTER TABLE "Photo"
  ADD CONSTRAINT "Photo_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
