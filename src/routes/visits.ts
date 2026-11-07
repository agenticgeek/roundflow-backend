import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, requireNumber, optString, optId, optBool, optStringArray } from "../lib/http";
import { assertPositive, optPaymentMethod } from "../lib/validation";
import { createVisitService, VisitCreateInput } from "../services/visit.service";
import { createReportsService } from "../services/reports.service";
import { createVisitCompletionService, parseCompletionPayment } from "../services/visit-completion";
import { createVisitPhotosService } from "../services/visit-photos.service";
import { createVisitRescheduleService } from "../services/visit-reschedule";
import { createCarryoverService } from "../services/carryover.service";
import { parseOptionalDateOnly } from "../lib/validation";

export const visitsRouter = Router();
visitsRouter.use(requireAuth);
visitsRouter.use(requireTenantAccess);
visitsRouter.use(requireBusinessAccess());

const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createVisitService(req.tenantPrisma);
};

// ==========================================================================
// Job carryover (ACT-02..04). Registered before the /:id routes.
// GET /visits/carryover/options?date=YYYY-MM-DD
//   -> 200 { date, options: [{ key: NEXT_WORKING_DAY|SATURDAY|MONDAY, date, label, default }] }
//   Friday: always Saturday + Monday (Monday default); other days: the next working day.
// ==========================================================================
visitsRouter.get(
  "/carryover/options",
  h(async (req, res) => {
    const date = parseOptionalDateOnly(req.query.date, "date");
    if (!date) throw new AppError(400, '"date" is required (YYYY-MM-DD)');
    if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
    res.json(await createCarryoverService(req.tenantPrisma).options(date));
  })
);

// POST /visits/carryover { date, target, visitIds?, notifyCustomers?, dryRun? }
//   Moves the unfinished (SCHEDULED/IN_PROGRESS) visits of `date` (or `visitIds`) to the target day.
//   -> 200 { moved, targetDate, conflicts[{ visitId, technicianId, reason }], notifiedTechnicians,
//            notifiedCustomers, skipped[{ visitId, reason }], dryRun }
//   400 INVALID_CARRYOVER_TARGET / CARRYOVER_TARGET_IN_PAST / bad body · 409 CARRYOVER_TARGET_CLOSED
visitsRouter.post(
  "/carryover",
  h(async (req, res) => {
    const body = asObject(req.body);
    const date = parseOptionalDateOnly(body.date, "date");
    if (!date) throw new AppError(400, '"date" is required (YYYY-MM-DD)');
    const visitIds = optStringArray(body.visitIds, "visitIds");
    if (visitIds && (visitIds.length === 0 || visitIds.length > 500)) {
      throw new AppError(400, '"visitIds" must contain 1 to 500 ids');
    }
    if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
    const result = await createCarryoverService(req.tenantPrisma).carryover({
      date,
      target: requireString(body.target, "target"),
      visitIds,
      notifyCustomers: optBool(body.notifyCustomers, "notifyCustomers"),
      dryRun: optBool(body.dryRun, "dryRun"),
      actor: { id: req.profile?.id, role: req.profile?.role ?? undefined },
    });
    res.json(result);
  })
);

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

// PATCH /visits/:id/assign { technicianId: string | null } (B2)
// Assign (id) or unassign (null) one SCHEDULED visit.
//   -> 200 { id, status, technicianId, technicianName, technicianOverride }
//   400 technician inactive / invite not accepted · 404 unknown visit or technician
//   409 VISIT_NOT_SCHEDULED
visitsRouter.patch(
  "/:id/assign",
  h(async (req, res) => {
    const body = asObject(req.body);
    if (body.technicianId === undefined) {
      throw new AppError(400, '"technicianId" is required (a technician id, or null to unassign).');
    }
    const technicianId = optId(body.technicianId, "technicianId") ?? null;
    const result = await svc(req).assignVisit(req.params.id, technicianId);
    void createReportsService(req.tenantPrisma!).logActivity(
      "VISIT_ASSIGNED",
      technicianId ? `Visit ${req.params.id} assigned to technician ${technicianId}` : `Visit ${req.params.id} unassigned`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );
    res.json(result);
  })
);

// PATCH /visits/:id/reschedule { date: YYYY-MM-DD }
// Moves a SCHEDULED or SKIPPED visit to a new date (a skipped one becomes SCHEDULED again,
// e.g. after a "manual" weather hold). Clears its reminder markers, cancels reminders still
// queued with the old date and logs VISIT_RESCHEDULED.
//   -> 200 { id, status, date }
//   400 date missing / invalid / in the past · 404 unknown visit
//   409 VISIT_NOT_RESCHEDULABLE (completed / in progress / cancelled) · 409 day already closed (date = today)
visitsRouter.patch(
  "/:id/reschedule",
  h(async (req, res) => {
    const body = asObject(req.body);
    const date = parseOptionalDateOnly(body.date, "date");
    if (!date) throw new AppError(400, '"date" is required (YYYY-MM-DD)');
    if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
    res.json(
      await createVisitRescheduleService(req.tenantPrisma).reschedule(req.params.id, {
        date,
        actor: { id: req.profile?.id, role: req.profile?.role ?? undefined },
      })
    );
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
