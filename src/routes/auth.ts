import { randomBytes } from "crypto";
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { AppError } from "../lib/app-error";
import { h, requireString, optString } from "../lib/http";

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

    const existing = await prisma.profile.findUnique({
      where: { supabaseUserId },
      include: { tenant: true },
    });
    if (existing) {
      return res.json({ profile: existing, tenantId: existing.tenantId });
    }

    const body = req.body as Record<string, unknown>;
    const name = requireString(body.name, "name").trim();
    if (!name) throw new AppError(400, "name must not be blank");

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
          return res.json({ profile, tenantId: profile.tenantId });
        }
      }
      throw err;
    }
  })
);
