import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, requireNumber, optString, optId } from "../lib/http";
import { assertPositive, optPaymentMethod } from "../lib/validation";
import { createVisitService, VisitCreateInput } from "../services/visit.service";
import { createReportsService } from "../services/reports.service";
import { createVisitCompletionService, parseCompletionPayment } from "../services/visit-completion";
import { createVisitPhotosService } from "../services/visit-photos.service";

export const visitsRouter = Router();
visitsRouter.use(requireAuth);
visitsRouter.use(requireTenantAccess);
visitsRouter.use(requireBusinessAccess());

const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createVisitService(req.tenantPrisma);
};

// ==========================================================================
// POST /visits — create a one-off (ad-hoc) visit
// ==========================================================================
visitsRouter.post(
  "/",
  h(async (req, res) => {
    const body = asObject(req.body);
    const price = requireNumber(body.price, "price");
    assertPositive(price, "price", 9999.99);

    const input: VisitCreateInput = {
      propertyId: requireString(body.propertyId, "propertyId"),
      date: requireString(body.date, "date"),
      price,
      serviceId: optId(body.serviceId, "serviceId"),
      technicianId: optId(body.technicianId, "technicianId"),
      roundId: optId(body.roundId, "roundId"),
      notes: optString(body.notes, "notes"),
      paymentMethod: optPaymentMethod(body.paymentMethod),
    };

    const result = await svc(req).createVisit(input);

    void createReportsService(req.tenantPrisma!).logActivity(
      "ONE_OFF_JOB_ADDED",
      `One-off job added: ${input.date} — ${result.addressLine}`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );

    res.status(201).json(result);
  })
);

// PATCH /visits/:id/complete
// Marks a visit COMPLETED and creates the Payment for its method (shared with
// the technician app, see services/visit-completion.ts):
//   payment { method: CASH|CHEQUE|NONE, amount?, chequeNumber? } — or the
//   deprecated cashConfirmed: true for CASH. Validation happens before any
//   write; status + payment + outbox events are one transaction (D-2).
visitsRouter.patch(
  "/:id/complete",
  h(async (req, res) => {
    const body = asObject(req.body);
    const payment = parseCompletionPayment(body);
    const result = await createVisitCompletionService(req.tenantPrisma!).completeVisit(req.params.id, {
      payment,
      actorProfileId: req.profile?.id,
      actorRole: req.profile?.role ?? undefined,
    });
    return res.json(result);
  })
);

// GET /visits/:id/photos — before/after photos with 1 h signed read URLs (B4).
visitsRouter.get(
  "/:id/photos",
  h(async (req, res) => {
    res.json(await createVisitPhotosService(req.tenantPrisma!).listForVisit(req.params.id));
  })
);
