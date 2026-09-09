-- Replace CleaningFrequency enum: drop FORTNIGHTLY and MONTHLY, add TWELVE_WEEKLY.
-- Any existing rows using FORTNIGHTLY or MONTHLY must be migrated before the old
-- values are removed. Since dev/qa have no live data using these values, we cast
-- them to FOUR_WEEKLY as a safe default before altering the type.

-- Step 1: Add TWELVE_WEEKLY to the existing enum
ALTER TYPE "CleaningFrequency" ADD VALUE IF NOT EXISTS 'TWELVE_WEEKLY';

-- Step 2: Migrate any rows using the removed values to FOUR_WEEKLY
UPDATE "ServicePlan" SET "cleaningFrequency" = 'FOUR_WEEKLY' WHERE "cleaningFrequency" IN ('FORTNIGHTLY', 'MONTHLY');
UPDATE "Round"       SET "frequency"         = 'FOUR_WEEKLY' WHERE "frequency"         IN ('FORTNIGHTLY', 'MONTHLY');

-- Step 3: Recreate the enum without FORTNIGHTLY and MONTHLY
--
-- PostgreSQL does not support DROP VALUE on an enum. The standard workaround is to:
--   1. Rename the old type
--   2. Create the new type with the correct values
--   3. Alter each column to use the new type (with an explicit USING cast)
--   4. Drop the old type

ALTER TYPE "CleaningFrequency" RENAME TO "CleaningFrequency_old";

CREATE TYPE "CleaningFrequency" AS ENUM ('FOUR_WEEKLY', 'SIX_WEEKLY', 'EIGHT_WEEKLY', 'TWELVE_WEEKLY');

ALTER TABLE "ServicePlan"
  ALTER COLUMN "cleaningFrequency" TYPE "CleaningFrequency"
  USING "cleaningFrequency"::text::"CleaningFrequency";

ALTER TABLE "Round"
  ALTER COLUMN "frequency" TYPE "CleaningFrequency"
  USING "frequency"::text::"CleaningFrequency";

DROP TYPE "CleaningFrequency_old";
