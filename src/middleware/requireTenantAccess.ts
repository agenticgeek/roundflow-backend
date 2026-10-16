import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { LRUCache } from "lru-cache";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantPrisma?: TenantPrismaClient;
    }
  }
}

type ProfileWithTenant = Prisma.ProfileGetPayload<{ include: { tenant: true } }>;

// Short-TTL cache of Profile lookups, keyed by supabaseUserId. Every request
// through this middleware used to hit the public schema; the profile rarely
// changes between requests, so a few seconds of staleness is an acceptable
// trade for cutting one DB round-trip per request.
//
// Positive-only by construction: only a *found* profile is ever set (see
// below), so a user who just signed up on a different ECS task is never
// stuck behind another task's stale "no profile" 403 for this TTL.
//
// TTL bounds how long a role change (e.g. demoting an ADMIN) stays stale on
// a given task — acceptable for this app's access patterns, revisit if that
// changes.
const PROFILE_CACHE_TTL_MS = 30_000;
const profileCache = new LRUCache<string, ProfileWithTenant>({
  max: 1000,
  ttl: PROFILE_CACHE_TTL_MS,
});

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
    const supabaseUserId = req.user.supabaseUserId;
    let profile = profileCache.get(supabaseUserId);
    if (!profile) {
      const found = await prisma.profile.findUnique({
        where: { supabaseUserId },
        include: { tenant: true },
      });
      if (!found) {
        res.status(403).json({ error: "No profile found for this user" });
        return;
      }
      profile = found;
      profileCache.set(supabaseUserId, profile);
    }
    req.profile = profile;
    req.tenantPrisma = getTenantPrismaForSchema(profile.tenant.schemaName);
    next();
  } catch (err) {
    next(err);
  }
}
