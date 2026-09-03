import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, optString, optId } from "../lib/http";
import { createComplaintService, ComplaintCreateInput, ComplaintListFilters } from "../services/complaint.service";
import { createReportsService } from "../services/reports.service";
import { ComplaintStatus, Severity } from "../generated/tenant-client";

export const complaintsRouter = Router();
complaintsRouter.use(requireAuth);
complaintsRouter.use(requireTenantAccess);
complaintsRouter.use(requireBusinessAccess());

const actorIdOf = (req: Request): string => req.user!.supabaseUserId;

const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createComplaintService(req.tenantPrisma);
};

function optSeverity(v: unknown): Severity | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "LOW" || v === "MEDIUM" || v === "HIGH") return v as Severity;
  throw new AppError(400, `"severity" must be LOW, MEDIUM, or HIGH`);
}

function optComplaintStatus(v: unknown): ComplaintStatus | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const valid = ["OPEN", "IN_REVIEW", "REVISIT_BOOKED", "RESOLVED"];
  if (typeof v === "string" && valid.includes(v)) return v as ComplaintStatus;
  throw new AppError(400, `"status" must be one of: ${valid.join(", ")}`);
}

// ==========================================================================
// GET /complaints — list complaints (optional: ?status=, ?search=, ?assignedTo=me)
// ==========================================================================
complaintsRouter.get(
  "/",
  h(async (req, res) => {
    const filters: ComplaintListFilters = {
      status: optComplaintStatus(req.query.status),
      search: typeof req.query.search === "string" ? req.query.search : undefined,
    };

    if (req.query.assignedTo !== undefined && req.query.assignedTo !== "me") {
      throw new AppError(400, `"assignedTo" must be "me" when provided`);
    }
    if (req.query.assignedTo === "me") {
      const tech = await req.tenantPrisma!.technician.findFirst({
        where: { profileId: req.profile!.id },
        select: { id: true },
      });
      if (tech) filters.technicianId = tech.id;
    } else if (typeof req.query.technicianId === "string") {
      filters.technicianId = req.query.technicianId;
    }

    const result = await svc(req).listComplaints(actorIdOf(req), filters);
    res.json(result);
  })
);

// ==========================================================================
// GET /complaints/:id — fetch a single complaint
// ==========================================================================
complaintsRouter.get(
  "/:id",
  h(async (req, res) => {
    const result = await svc(req).getComplaint(actorIdOf(req), req.params.id);
    res.json(result);
  })
);

// ==========================================================================
// GET /complaints/:id/messages — list message thread
// ==========================================================================
complaintsRouter.get(
  "/:id/messages",
  h(async (req, res) => {
    const result = await svc(req).getMessages(actorIdOf(req), req.params.id);
    res.json(result);
  })
);

// ==========================================================================
// POST /complaints/:id/messages — add an outbound reply
// ==========================================================================
complaintsRouter.post(
  "/:id/messages",
  h(async (req, res) => {
    const body = asObject(req.body);
    const text = requireString(body.body, "body");
    const result = await svc(req).addMessage(actorIdOf(req), req.params.id, text);
    res.status(201).json(result);
  })
);

// ==========================================================================
// POST /complaints — log a new complaint
// ==========================================================================
complaintsRouter.post(
  "/",
  h(async (req, res) => {
    const body = asObject(req.body);

    const input: ComplaintCreateInput = {
      customerId: requireString(body.customerId, "customerId"),
      title: requireString(body.title, "title"),
      description: optString(body.description, "description"),
      issueType: optString(body.issueType, "issueType"),
      severity: optSeverity(body.severity),
      propertyId: optId(body.propertyId, "propertyId"),
      technicianId: optId(body.technicianId, "technicianId"),
    };

    const result = await svc(req).logComplaint(actorIdOf(req), input);

    void createReportsService(req.tenantPrisma!).logActivity(
      "COMPLAINT_LOGGED",
      `Complaint logged: ${result.title} — ${result.customerName}`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );

    res.status(201).json(result);
  })
);

// ==========================================================================
// POST /complaints/:id/mark-in-review
// ==========================================================================
complaintsRouter.post(
  "/:id/mark-in-review",
  h(async (req, res) => {
    const result = await svc(req).markInReview(actorIdOf(req), req.params.id);
    res.json(result);
  })
);

// ==========================================================================
// POST /complaints/:id/schedule-revisit
// ==========================================================================
complaintsRouter.post(
  "/:id/schedule-revisit",
  h(async (req, res) => {
    const body = asObject(req.body);
    const revisitDate = requireString(body.revisitDate, "revisitDate");
    const result = await svc(req).scheduleRevisit(actorIdOf(req), req.params.id, revisitDate);
    res.json(result);
  })
);

// ==========================================================================
// POST /complaints/:id/resolve
// ==========================================================================
complaintsRouter.post(
  "/:id/resolve",
  h(async (req, res) => {
    const result = await svc(req).resolve(actorIdOf(req), req.params.id);
    res.json(result);
  })
);

// ==========================================================================
// POST /complaints/:id/reopen
// ==========================================================================
complaintsRouter.post(
  "/:id/reopen",
  h(async (req, res) => {
    const result = await svc(req).reopen(actorIdOf(req), req.params.id);
    res.json(result);
  })
);

// ==========================================================================
// POST /complaints/:id/assign-technician
// ==========================================================================
complaintsRouter.post(
  "/:id/assign-technician",
  h(async (req, res) => {
    const body = asObject(req.body);
    const technicianId = requireString(body.technicianId, "technicianId");
    const result = await svc(req).assignTechnician(actorIdOf(req), req.params.id, technicianId);
    res.json(result);
  })
);
