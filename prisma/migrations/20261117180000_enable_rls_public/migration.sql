-- Supabase exposes the public schema through its REST API (PostgREST) to the
-- anon and authenticated roles, and the anon key ships in the frontend bundle.
-- Without RLS those roles can read and write these tables directly. Enabling
-- RLS with no policies denies them everything. The backend connects as the
-- table owner, which bypasses RLS, so it is unaffected.
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantInvite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
