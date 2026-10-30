import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { h } from "../lib/http";
import { createTechnicianIncidentService } from "../services/technician-incident.service";

// Mounted at /technician-incidents (B6 · GAP-025). Create and list live on
// /technicians/:id/incidents; delete is by incident id. ADMIN/MANAGER only.
export const technicianIncidentsRouter = Router();
technicianIncidentsRouter.use(requireAuth);
technicianIncidentsRouter.use(requireTenantAccess);
technicianIncidentsRouter.use(requireBusinessAccess());

const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createTechnicianIncidentService(req.tenantPrisma);
};

// DELETE /technician-incidents/:id → 204
technicianIncidentsRouter.delete(
  "/:id",
  h(async (req, res) => {
    await svc(req).remove(req.params.id);
    res.status(204).send();
  })
);
