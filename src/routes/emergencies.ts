import { Router } from "express";
import { UserRole } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireRole } from "../middleware/requireRole";
import { h } from "../lib/http";
import { createEmergencyService } from "../services/emergency.service";
import { AppError } from "../lib/app-error";

export const emergenciesRouter = Router();
emergenciesRouter.use(requireAuth);
emergenciesRouter.use(requireTenantAccess);

const svc = (req: any) => createEmergencyService(req.tenantPrisma!);

// GET /emergencies?status=ACTIVE|RESOLVED — ADMIN/MANAGER only
emergenciesRouter.get("/", requireRole(UserRole.ADMIN, UserRole.MANAGER), h(async (req, res) => {
  const { status } = req.query;
  const parsed =
    status === "ACTIVE" ? "ACTIVE" :
    status === "RESOLVED" ? "RESOLVED" :
    undefined;
  res.json(await svc(req).listEmergencies(parsed));
}));

// POST /emergencies/:id/reassign — confirm reassignment, ADMIN/MANAGER only
emergenciesRouter.post("/:id/reassign", requireRole(UserRole.ADMIN, UserRole.MANAGER), h(async (req, res) => {
  const { newTechnicianId } = req.body;
  if (!newTechnicianId) throw new AppError(400, "newTechnicianId is required");
  res.json(await svc(req).reassign(req.params.id, newTechnicianId));
}));

// GET /emergencies/:id/available-technicians — ADMIN/MANAGER only
emergenciesRouter.get("/:id/available-technicians", requireRole(UserRole.ADMIN, UserRole.MANAGER), h(async (req, res) => {
  res.json(await svc(req).getAvailableTechnicians(req.params.id));
}));

// GET /emergencies/:id — single emergency detail, ADMIN/MANAGER only
emergenciesRouter.get("/:id", requireRole(UserRole.ADMIN, UserRole.MANAGER), h(async (req, res) => {
  res.json(await svc(req).getEmergency(req.params.id));
}));

// POST /emergencies — technician self-reports an emergency
emergenciesRouter.post("/", h(async (req, res) => {
  const { technicianId, roundId, remainingStops, lastLocation, scheduledWindowEnd, notes } = req.body;
  if (!technicianId || !roundId || remainingStops == null) {
    throw new AppError(400, "technicianId, roundId, and remainingStops are required");
  }
  const emergency = await svc(req).reportEmergency({
    technicianId,
    roundId,
    remainingStops: Number(remainingStops),
    lastLocation,
    scheduledWindowEnd: scheduledWindowEnd ? new Date(scheduledWindowEnd) : undefined,
    notes,
  });
  res.status(201).json(emergency);
}));
