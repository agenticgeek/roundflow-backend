import { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, TenantPrismaClient } from "../lib/tenant-prisma-manager";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantPrisma?: TenantPrismaClient;
    }
  }
}

// Loads the caller's Profile (with its Tenant) and wires up req.tenantPrisma
// to the correct per-schema PrismaClient. Must run after requireAuth.
//
// Sets:
//   req.profile      — the caller's public-schema Profile
//   req.tenantPrisma — PrismaClient scoped to this tenant's Postgres schema
//
// Returns 401 if req.user is absent (requireAuth didn't run), 403 if the
// caller has no Profile yet (invite-accept and signup paths skip this).
export async function requireTenantAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const profile = await prisma.profile.findUnique({
      where: { supabaseUserId: req.user.supabaseUserId },
      include: { tenant: true },
    });
    if (!profile) {
      res.status(403).json({ error: "No profile found for this user" });
      return;
    }
    req.profile = profile;
    req.tenantPrisma = getTenantPrismaForSchema(profile.tenant.schemaName);
    next();
  } catch (err) {
    next(err);
  }
}
