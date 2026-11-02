-- Human-readable job reference on visits (shown as JOB-000123). Additive.
-- A per-tenant-schema sequence feeds the column default, so every visit
-- creation path gets a number without code changes. Existing visits are
-- numbered deterministically, oldest first (createdAt, then id).

CREATE SEQUENCE "Visit_jobNumber_seq";

ALTER TABLE "Visit" ADD COLUMN "jobNumber" INTEGER;

UPDATE "Visit" v
SET "jobNumber" = n.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn FROM "Visit"
) n
WHERE v."id" = n."id";

SELECT setval('"Visit_jobNumber_seq"', COALESCE((SELECT MAX("jobNumber") FROM "Visit"), 0) + 1, false);

ALTER TABLE "Visit" ALTER COLUMN "jobNumber" SET DEFAULT nextval('"Visit_jobNumber_seq"');
ALTER TABLE "Visit" ALTER COLUMN "jobNumber" SET NOT NULL;
ALTER SEQUENCE "Visit_jobNumber_seq" OWNED BY "Visit"."jobNumber";

CREATE UNIQUE INDEX "Visit_jobNumber_key" ON "Visit"("jobNumber");
