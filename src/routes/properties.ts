import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireBusinessAccess } from "../middleware/requireRole";
import { asObject, h, requireString, requireNumber, optString, optReqString } from "../lib/http";
import {
  assertPositive,
  optPaymentMethod,
  optIsoDate,
  parseIsoDate,
  requireNoteType,
} from "../lib/validation";
import {
  customerService,
  PropertyCreateInput,
  PropertyUpdateInput,
} from "../services/customer.service";

export const propertiesRouter = Router();
propertiesRouter.use(requireAuth);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
propertiesRouter.use(requireBusinessAccess());

// Thin routes: validate → call service → respond. No DB access here.
const actorIdOf = (req: Request): string => req.user!.supabaseUserId;

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
      serviceAreaId: optString(body.serviceAreaId, "serviceAreaId"),
      // Service Plan (step 2)
      serviceId: optString(body.serviceId, "serviceId"),
      price: assertPositive(requireNumber(body.price, "price"), "price"),
      cleanMethod: optString(body.cleanMethod, "cleanMethod"),
      paymentMethod: optPaymentMethod(body.paymentMethod),
      // Schedule (step 3)
      nextDueDate: optIsoDate(body.nextDueDate, "nextDueDate"),
      // Notes (step 4)
      accessNotes: optString(body.accessNotes, "accessNotes"),
      riskNotes: optString(body.riskNotes, "riskNotes"),
      // Assignment (step 5 / Screen 31) — null = Save & Assign Later (unassigned)
      roundId: optString(body.roundId, "roundId"),
    };
    res.status(201).json(await customerService.createProperty(actorIdOf(req), input));
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
      serviceAreaId: optString(body.serviceAreaId, "serviceAreaId"),
      accessNotes: optString(body.accessNotes, "accessNotes"),
      riskNotes: optString(body.riskNotes, "riskNotes"),
      roundId: optString(body.roundId, "roundId"), // null = unassign; id = assign/reassign
    };
    res.json(await customerService.updateProperty(actorIdOf(req), req.params.id, input));
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
    res.json(
      await customerService.pauseService(actorIdOf(req), req.params.id, {
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
    res.json(await customerService.resumeService(actorIdOf(req), req.params.id));
  })
);

// ==========================================================================
// GET /properties/:id/notes — Notes & Risk (newest first)
// ==========================================================================
propertiesRouter.get(
  "/:id/notes",
  h(async (req, res) => {
    res.json(await customerService.getNotes(actorIdOf(req), req.params.id));
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
    res.status(201).json(await customerService.addNote(actorIdOf(req), req.params.id, input));
  })
);
