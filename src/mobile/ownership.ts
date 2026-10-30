import { NextFunction, Request, Response } from "express";
import { UserRole } from "@prisma/client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Set by requireTechnician: the tenant Technician row linked to req.profile.
      technician?: { id: string };
    }
  }
}

// Router guard for /mobile/* (D-3). Must run after requireTenantAccess.
// Only TECHNICIAN profiles that have a linked tenant Technician row get through;
// admins and managers use the web API, never the technician app endpoints.
export async function requireTechnician(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.profile?.role !== UserRole.TECHNICIAN) {
      res.status(403).json({ error: "The technician app is only available to technicians", code: "TECHNICIAN_ONLY" });
      return;
    }
    const tech = await req.tenantPrisma!.technician.findUnique({
      where: { profileId: req.profile.id },
      select: { id: true },
    });
    if (!tech) {
      res.status(403).json({ error: "No technician record is linked to this account", code: "NO_TECHNICIAN" });
      return;
    }
    req.technician = { id: tech.id };
    next();
  } catch (err) {
    next(err);
  }
}

// 404 when the visit doesn't exist, 403 NOT_YOUR_VISIT when it is assigned to
// someone else (or to nobody). A8 ownership rule.
export async function assertVisitOwner(tp: TenantPrismaClient, visitId: string, technicianId: string): Promise<void> {
  const visit = await tp.visit.findUnique({ where: { id: visitId }, select: { technicianId: true } });
  if (!visit) throw new AppError(404, "Visit not found");
  if (visit.technicianId !== technicianId) {
    throw new AppError(403, "This job is not assigned to you", "NOT_YOUR_VISIT");
  }
}

// Route middleware form of assertVisitOwner for /mobile/visits/:id[/...].
export function requireVisitOwner(req: Request, _res: Response, next: NextFunction): void {
  assertVisitOwner(req.tenantPrisma!, req.params.id, req.technician!.id).then(() => next(), next);
}

// Chat is scoped to rounds the technician is on: assigned to the round, or
// holding at least one visit on it (e.g. a one-day reassignment).
export async function assertRoundMember(tp: TenantPrismaClient, roundId: string, technicianId: string): Promise<void> {
  const member = await tp.roundTechnician.findFirst({ where: { roundId, technicianId }, select: { roundId: true } });
  if (member) return;
  const visit = await tp.visit.findFirst({ where: { roundId, technicianId }, select: { id: true } });
  if (visit) return;
  throw new AppError(403, "You are not on this round", "NOT_YOUR_ROUND");
}
