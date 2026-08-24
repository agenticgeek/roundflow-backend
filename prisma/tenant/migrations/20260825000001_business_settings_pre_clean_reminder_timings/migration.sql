-- Add preCleanReminderTimings as a text array on BusinessSettings.
-- Defaults to empty array (no reminders set). Multi-select: up to two
-- reminder timings can be stored (e.g. EVENING_BEFORE + TWO_HOURS_BEFORE).

ALTER TABLE "BusinessSettings"
  ADD COLUMN "preCleanReminderTimings" TEXT[] NOT NULL DEFAULT '{}';
