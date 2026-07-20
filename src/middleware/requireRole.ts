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

// Used by /setup and /settings routers. GETs are open to any authenticated
// role; mutations require ADMIN or MANAGER.
export function requireBusinessAccess() {
  return function (req: Request, res: Response, next: NextFunction) {
    const roles =
      req.method === "GET"
        ? [UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN]
        : [UserRole.ADMIN, UserRole.MANAGER];
    return requireRole(...roles)(req, res, next);
  };
}
