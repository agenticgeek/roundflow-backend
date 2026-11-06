import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { h } from "../lib/http";
import { createEmergencyService } from "../services/emergency.service";
import { AppError } from "../lib/app-error";
import { parseIsoDate } from "../lib/validation";

export const emergenciesRouter = Router();
emergenciesRouter.use(requireAuth);
emergenciesRouter.use(requireTenantAccess);

const svc = (req: Request) => createEmergencyService(req.tenantPrisma!);

// GET /emergencies?status=ACTIVE|RESOLVED — ADMIN/MANAGER only
emergenciesRouter.get("/", requireBusinessAccess(), h(async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && status !== "ACTIVE" && status !== "RESOLVED") {
    throw new AppError(400, "status must be ACTIVE or RESOLVED", "VALIDATION_FAILED");
  }
  const parsed = status as "ACTIVE" | "RESOLVED" | undefined;
  res.json(await svc(req).listEmergencies(parsed));
}));

// POST /emergencies/:id/reassign — confirm reassignment, ADMIN/MANAGER only
emergenciesRouter.post("/:id/reassign", requireBusinessAccess(), h(async (req, res) => {
  const { newTechnicianId } = req.body;
  if (!newTechnicianId) throw new AppError(400, "newTechnicianId is required");
  res.json(await svc(req).reassign(req.params.id, newTechnicianId));
}));

// GET /emergencies/:id/available-technicians — ADMIN/MANAGER only
emergenciesRouter.get("/:id/available-technicians", requireBusinessAccess(), h(async (req, res) => {
  res.json(await svc(req).getAvailableTechnicians(req.params.id));
}));

// GET /emergencies/:id — single emergency detail, ADMIN/MANAGER only
emergenciesRouter.get("/:id", requireBusinessAccess(), h(async (req, res) => {
  res.json(await svc(req).getEmergency(req.params.id));
}));

// POST /emergencies — technician self-reports an emergency
emergenciesRouter.post("/", h(async (req, res) => {
  const { technicianId, roundId, remainingStops, lastLocation, scheduledWindowEnd, notes } = req.body;
  if (!technicianId || !roundId || remainingStops == null) {
    throw new AppError(400, "technicianId, roundId, and remainingStops are required");
  }
  // BUG-006/008: values used to reach Prisma unchecked ("Argument technician is missing", NaN stops, invalid dates).
  const stops = typeof remainingStops === "string" && remainingStops.trim() !== "" ? Number(remainingStops) : remainingStops;
  if (typeof technicianId !== "string" || typeof roundId !== "string") {
    throw new AppError(400, "technicianId and roundId must be strings", "VALIDATION_FAILED");
  }
  if (typeof stops !== "number" || !Number.isInteger(stops) || stops < 0) {
    throw new AppError(400, "remainingStops must be a whole number of 0 or more", "VALIDATION_FAILED");
  }
  if ((lastLocation != null && typeof lastLocation !== "string") || (notes != null && typeof notes !== "string")) {
    throw new AppError(400, "lastLocation and notes must be text", "VALIDATION_FAILED");
  }
  const emergency = await svc(req).reportEmergency({
    technicianId,
    roundId,
    remainingStops: stops,
    lastLocation,
    scheduledWindowEnd: scheduledWindowEnd ? parseIsoDate(scheduledWindowEnd, "scheduledWindowEnd") : undefined,
    notes,
  });
  res.status(201).json(emergency);
}));
