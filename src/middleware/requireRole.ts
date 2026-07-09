import { NextFunction, Request, Response } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";

// Authorization guard. MUST run AFTER `requireAuth`, which verifies the JWT and
// attaches `req.user`. This layer answers the question `requireAuth` does not:
// *is this user allowed to do this?* It loads the caller's Profile by
// supabaseUserId and checks the **app role** (`Profile.role`) — NOT the raw JWT
// `role` claim, which for Supabase is always the string "authenticated" — against
// the allowed list. On success it attaches `req.profile` for downstream handlers.
//
//   401 — req.user is not set (requireAuth did not run first).
//   403 — no Profile exists, or its role is not in the allowed list.
export function requireRole(...roles: UserRole[]) {
  return async function (req: Request, res: Response, next: NextFunction) {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const profile = await prisma.profile.findUnique({
        where: { supabaseUserId: req.user.supabaseUserId },
      });
      if (!profile || !roles.includes(profile.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      req.profile = profile;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// Convenience guard for the business-config surface (/setup, /settings). Reads
// are open to any known role; mutations (POST/PATCH/DELETE) require ADMIN or
// MANAGER. Applied once per router so the two routers cannot drift apart.
export function requireBusinessAccess() {
  return function (req: Request, res: Response, next: NextFunction) {
    const roles =
      req.method === "GET"
        ? [UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN]
        : [UserRole.ADMIN, UserRole.MANAGER];
    return requireRole(...roles)(req, res, next);
  };
}
