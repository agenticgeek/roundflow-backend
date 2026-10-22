import { randomBytes } from "crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { provisionTenantSchema } from "../lib/tenant-provisioning";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { seedTenantDefaults } from "../lib/tenant-defaults";
import { AppError } from "../lib/app-error";
import { h, requireString, optString, asObject } from "../lib/http";
import { mergePreferences } from "../lib/preferences";

// Best-effort: a brand-new tenant should get default Services/MessageTemplates
// rows, but a seeding hiccup must never block signup itself — the tenant can
// still add these manually, and seedTenantDefaults is safe to retry (it only
// writes when the relevant table is empty).
async function seedDefaultsBestEffort(schemaName: string): Promise<void> {
  await seedTenantDefaults(getTenantPrismaForSchema(schemaName)).catch((err) => {
    console.error(`[signup] seedTenantDefaults failed for ${schemaName}:`, err);
  });
}

export const authRouter = Router();

// GET /auth/me
// Returns the Profile for the authenticated user, or 404 if no Profile exists
// yet (new user who hasn't called POST /auth/signup).
// The frontend uses the 404 to detect new users and trigger signup.
authRouter.get(
  "/me",
  requireAuth,
  h(async (req, res) => {
    const profile = await prisma.profile.findUnique({
      where: { supabaseUserId: req.user!.supabaseUserId },
    });
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }
    return res.json(profile);
  })
);

// Per-user UI preferences — a free-form JSON blob the frontend owns, so toggles,
// filter choices, "remember me", etc. persist per user across sessions. Shallow-
// merged on PATCH (see lib/preferences) so the frontend can set one key at a time.

// GET /auth/me/preferences
authRouter.get(
  "/me/preferences",
  requireAuth,
  h(async (req, res) => {
    const profile = await prisma.profile.findUnique({
      where: { supabaseUserId: req.user!.supabaseUserId },
      select: { preferences: true },
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    return res.json({ preferences: profile.preferences ?? {} });
  })
);

// PATCH /auth/me/preferences — shallow-merge the given keys into stored prefs
authRouter.patch(
  "/me/preferences",
  requireAuth,
  h(async (req, res) => {
    const incoming = asObject(req.body);
    const profile = await prisma.profile.findUnique({
      where: { supabaseUserId: req.user!.supabaseUserId },
      select: { preferences: true },
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const updated = await prisma.profile.update({
      where: { supabaseUserId: req.user!.supabaseUserId },
      data: { preferences: mergePreferences(profile.preferences, incoming) as Prisma.InputJsonValue },
      select: { preferences: true },
    });
    return res.json({ preferences: updated.preferences });
  })
);

// POST /auth/signup
// Called by the frontend after Supabase confirms a new session and
// GET /auth/me returns 404 (no Profile yet for this supabaseUserId).
//
// Replaces the handle_new_user Postgres trigger — see
// docs/sql/drop_handle_new_user.sql for the SQL to run in Supabase.
//
// Idempotent: if a Profile already exists for this supabaseUserId,
// returns it without creating a duplicate Tenant.
//
// companyName is accepted but not persisted here — it will seed
// BusinessSettings.businessName when tenant schema provisioning runs.
// Until then, Setup Wizard step 1 collects it directly.
authRouter.post(
  "/signup",
  requireAuth,
  h(async (req, res) => {
    const supabaseUserId = req.user!.supabaseUserId;

    const body = req.body as Record<string, unknown>;
    const name = requireString(body.name, "name").trim();
    if (!name) throw new AppError(400, "name must not be blank");

    const existing = await prisma.profile.findUnique({
      where: { supabaseUserId },
      include: { tenant: true },
    });
    if (existing) {
      // Re-attempt provisioning in case a prior signup call committed the
      // Profile+Tenant row but crashed before provisionTenantSchema completed.
      // provisionTenantSchema is idempotent: no-op if already fully provisioned.
      await provisionTenantSchema(existing.tenant.schemaName);
      await seedDefaultsBestEffort(existing.tenant.schemaName);
      return res.json({ profile: existing, tenantId: existing.tenantId });
    }

    // optString so Google OAuth callers can omit companyName.
    // Unused until tenant schema provisioning is implemented.
    optString(body.companyName, "companyName");

    try {
      const result = await prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            // "t_" + 20 random hex chars: valid Postgres identifier,
            // globally unique, not guessable.
            schemaName: `t_${randomBytes(10).toString("hex")}`,
          },
        });

        const profile = await tx.profile.create({
          data: {
            supabaseUserId,
            tenantId: tenant.id,
            role: "ADMIN",
            name,
          },
          include: { tenant: true },
        });

        return { profile, tenantId: tenant.id };
      });

      await provisionTenantSchema(result.profile.tenant.schemaName);
      await seedDefaultsBestEffort(result.profile.tenant.schemaName);
      return res.status(201).json(result);
    } catch (err: unknown) {
      // Concurrent signup calls can both pass the findUnique check before
      // either commits. Catch the unique violation and return the now-existing
      // profile instead of propagating a 500.
      if (
        err instanceof Error &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        const profile = await prisma.profile.findUnique({
          where: { supabaseUserId },
          include: { tenant: true },
        });
        if (profile) {
          await provisionTenantSchema(profile.tenant.schemaName);
          await seedDefaultsBestEffort(profile.tenant.schemaName);
          return res.json({ profile, tenantId: profile.tenantId });
        }
      }
      throw err;
    }
  })
);
