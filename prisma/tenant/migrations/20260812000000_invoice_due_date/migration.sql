-- Add dueDate to Invoice — required for debt board aging buckets (7 days over / 14 days over).
ALTER TABLE "Invoice" ADD COLUMN "dueDate" TIMESTAMP(3);
