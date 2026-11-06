import { NextFunction, Request, RequestHandler, Response } from "express";
import { assertAdmin, isAdminOnlyRoute } from "../lib/permissions";

// BE-01. Kept out of requireRole.ts on purpose: many route tests replace that module wholesale.

/** Route-level guard: ADMIN only, else 403 ADMIN_ONLY. Run after requireTenantAccess. */
export function requireAdmin(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      assertAdmin(req.profile);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Router-level guard: ADMIN only for the routes listed in ADMIN_ONLY_ROUTES (src/lib/permissions.ts). */
export function enforceAdminOnlyRoutes(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.originalUrl.split("?")[0];
    if (isAdminOnlyRoute(req.method, path)) return requireAdmin()(req, res, next);
    next();
  };
}
