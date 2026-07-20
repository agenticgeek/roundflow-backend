-- Run this once in the Supabase SQL Editor before deploying the new auth flow.
--
-- The handle_new_user trigger created Profile rows and seeded BusinessSettings
-- directly from Supabase Auth events. With multi-tenancy, signup now requires
-- creating a Tenant and (eventually) a per-tenant Postgres schema — neither of
-- which a trigger can do. The backend POST /auth/signup endpoint handles this
-- instead.
--
-- Safe to run multiple times (IF EXISTS guards).

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();
