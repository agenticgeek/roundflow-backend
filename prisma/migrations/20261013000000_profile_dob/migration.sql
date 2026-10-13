-- Mobile Edit Profile: technician date of birth (YYYY-MM-DD string).
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "dateOfBirth" TEXT;
