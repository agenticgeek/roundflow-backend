import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, requireNumber, optString, optReqString, optId } from "../lib/http";
import {
  assertPositive,
  optPaymentMethod,
  optIsoDate,
  parseIsoDate,
  requireNoteType,
  optCleaningFrequency,
} from "../lib/validation";
import {
  createCustomerService,
  PropertyCreateInput,
  PropertyUpdateInput,
} from "../services/customer.service";

export const propertiesRouter = Router();
propertiesRouter.use(requireAuth);
propertiesRouter.use(requireTenantAccess);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
propertiesRouter.use(requireBusinessAccess());

// Thin routes: validate → call service → respond. No DB access here.
const actorIdOf = (req: Request): string => req.user!.supabaseUserId;
const svc = (req: Request) => createCustomerService(req.tenantPrisma!);

// ==========================================================================
// POST /properties — M6 Add Property (Customer + Property + ServicePlan, atomic)
// ==========================================================================
propertiesRouter.post(
  "/",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: PropertyCreateInput = {
      // Customer (step 1)
      customerName: requireString(body.customerName, "customerName"),
      phone: optString(body.phone, "phone"),
      email: optString(body.email, "email"),
      // Property (step 1)
      addressLine: requireString(body.addressLine, "addressLine"),
      postcode: requireString(body.postcode, "postcode").trim(),
      propertyName: optString(body.propertyName, "propertyName"),
      propertyType: optString(body.propertyType, "propertyType"),
      serviceAreaId: requireString(body.serviceAreaId, "serviceAreaId"),
      // Service Plan (step 2)
      serviceId: optId(body.serviceId, "serviceId"),
      price: assertPositive(requireNumber(body.price, "price"), "price"),
      cleanMethod: optString(body.cleanMethod, "cleanMethod"),
      paymentMethod: optPaymentMethod(body.paymentMethod),
      // Schedule (step 3)
      nextDueDate: optIsoDate(body.nextDueDate, "nextDueDate"),
      // Notes (step 4)
      accessNotes: optString(body.accessNotes, "accessNotes"),
      riskNotes: optString(body.riskNotes, "riskNotes"),
      // Assignment (step 5 / Screen 31) — null = Save & Assign Later (unassigned)
      roundId: optId(body.roundId, "roundId"),
    };
    res.status(201).json(await svc(req).createProperty(actorIdOf(req), input));
  })
);

// ==========================================================================
// PATCH /properties/:id — property edit + Move Round (assign/unassign)
// ==========================================================================
propertiesRouter.patch(
  "/:id",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: PropertyUpdateInput = {
      addressLine: optReqString(body.addressLine, "addressLine"),
      postcode: optReqString(body.postcode, "postcode"),
      propertyName: optString(body.propertyName, "propertyName"),
      propertyType: optString(body.propertyType, "propertyType"),
      serviceAreaId: optId(body.serviceAreaId, "serviceAreaId"),
      accessNotes: optString(body.accessNotes, "accessNotes"),
      riskNotes: optString(body.riskNotes, "riskNotes"),
      roundId: optId(body.roundId, "roundId"), // null = unassign; id = assign/reassign
      cleaningFrequency: optCleaningFrequency(body.cleaningFrequency),
    };
    res.json(await svc(req).updateProperty(actorIdOf(req), req.params.id, input));
  })
);

// ==========================================================================
// POST /properties/:id/pause — M9 Pause Service
// ==========================================================================
propertiesRouter.post(
  "/:id/pause",
  h(async (req, res) => {
    const body = asObject(req.body);
    // `reason` is required in the UI but has no schema column — validated, not
    // persisted (could become an ActivityLog / note entry later).
    requireString(body.reason, "reason");
    const pauseStartDate = parseIsoDate(body.pauseStartDate, "pauseStartDate");
    const pauseEndDate = optIsoDate(body.pauseEndDate, "pauseEndDate");
    if (pauseEndDate !== undefined && pauseEndDate !== null && pauseEndDate <= pauseStartDate) {
      throw new AppError(400, "pauseEndDate must be after pauseStartDate");
    }
    res.json(
      await svc(req).pauseService(actorIdOf(req), req.params.id, {
        pauseStartDate,
        pauseEndDate,
      })
    );
  })
);

// ==========================================================================
// POST /properties/:id/resume — clear the pause
// ==========================================================================
propertiesRouter.post(
  "/:id/resume",
  h(async (req, res) => {
    res.json(await svc(req).resumeService(actorIdOf(req), req.params.id));
  })
);

// ==========================================================================
// GET /properties/:id/notes — Notes & Risk (newest first)
// ==========================================================================
propertiesRouter.get(
  "/:id/notes",
  h(async (req, res) => {
    res.json(await svc(req).getNotes(actorIdOf(req), req.params.id));
  })
);

// ==========================================================================
// POST /properties/:id/notes — M20 Add Note (author = acting Profile)
// ==========================================================================
propertiesRouter.post(
  "/:id/notes",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input = {
      type: requireNoteType(body.type),
      body: requireString(body.body, "body"),
      authorProfileId: req.profile?.id ?? null,
    };
    res.status(201).json(await svc(req).addNote(actorIdOf(req), req.params.id, input));
  })
);

// ==========================================================================
// DELETE /properties/:id — soft-delete property (CANCELLED + cancels plans)
// ==========================================================================
propertiesRouter.delete(
  "/:id",
  h(async (req, res) => {
    await svc(req).deleteProperty(actorIdOf(req), req.params.id);
    res.status(204).send();
  })
);
