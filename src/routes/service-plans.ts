import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, optString, optReqNumber } from "../lib/http";
import { assertPositive, optPaymentMethod, optCleaningFrequency, parseIsoDate, optIsoDate } from "../lib/validation";
import { createCustomerService, ServicePlanUpdateInput } from "../services/customer.service";

// Per-plan write surface: targets one ServicePlan by its own id, so a
// property with 2+ plans (multi-plan customers) can have each plan edited
// independently instead of every write guessing at the property's "primary"
// plan (see CustomerService.primaryPlan()).
export const servicePlansRouter = Router();
servicePlansRouter.use(requireAuth);
servicePlansRouter.use(requireTenantAccess);
servicePlansRouter.use(requireBusinessAccess());

const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createCustomerService(req.tenantPrisma);
};

// ==========================================================================
// PATCH /service-plans/:id — price / clean method / payment method / frequency
// ==========================================================================
servicePlansRouter.patch(
  "/:id",
  h(async (req, res) => {
    const body = asObject(req.body);
    const rawPrice = optReqNumber(body.price, "price");
    const input: ServicePlanUpdateInput = {
      price: rawPrice !== undefined ? assertPositive(rawPrice, "price", 9999.99) : undefined,
      cleanMethod: optString(body.cleanMethod, "cleanMethod"),
      paymentMethod: optPaymentMethod(body.paymentMethod),
      cleaningFrequency: optCleaningFrequency(body.cleaningFrequency),
    };
    res.json(await svc(req).updateServicePlan(req.params.id, input));
  })
);

// ==========================================================================
// POST /service-plans/:id/pause
// ==========================================================================
servicePlansRouter.post(
  "/:id/pause",
  h(async (req, res) => {
    const body = asObject(req.body);
    // `reason` is required in the UI but has no schema column — validated,
    // not persisted (mirrors POST /properties/:id/pause).
    requireString(body.reason, "reason");
    const pauseStartDate = parseIsoDate(body.pauseStartDate, "pauseStartDate");
    const pauseEndDate = optIsoDate(body.pauseEndDate, "pauseEndDate");
    if (pauseEndDate !== undefined && pauseEndDate !== null && pauseEndDate <= pauseStartDate) {
      throw new AppError(400, "pauseEndDate must be after pauseStartDate");
    }
    res.json(await svc(req).pauseServicePlan(req.params.id, { pauseStartDate, pauseEndDate }));
  })
);

// ==========================================================================
// POST /service-plans/:id/resume
// ==========================================================================
servicePlansRouter.post(
  "/:id/resume",
  h(async (req, res) => {
    res.json(await svc(req).resumeServicePlan(req.params.id));
  })
);
