import { NextFunction, Request, Response } from "express";
import { UserRole } from "@prisma/client";

// Role guard — must run AFTER requireTenantAccess, which loads req.profile.
// Returns 403 if the caller's role is not in the allowed list.
export function requireRole(...roles: UserRole[]) {
  return function (req: Request, res: Response, next: NextFunction) {
    if (!req.profile) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    if (!roles.includes(req.profile.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    return next();
  };
}

// Used by admin routers. All methods require ADMIN or MANAGER — technicians
// use /mobile/* exclusively and must not access admin endpoints.
export function requireBusinessAccess() {
  return requireRole(UserRole.ADMIN, UserRole.MANAGER);
}
