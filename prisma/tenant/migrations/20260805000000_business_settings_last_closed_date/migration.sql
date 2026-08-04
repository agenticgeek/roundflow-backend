-- Track whether the operational day has been closed via POST /today/close.
-- Stored as YYYY-MM-DD text so comparison is timezone-safe (no UTC offset math).
-- Null = day not yet closed; matching today's date = already closed (reject re-close).
ALTER TABLE "BusinessSettings" ADD COLUMN "lastClosedDate" TEXT;
