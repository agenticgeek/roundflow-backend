import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, requireNumber, optString, optReqString, optId, optBool, optStringArray, parsePageParams } from "../lib/http";
import { PhotoType } from "../generated/tenant-client";
import {
  assertPositive,
  assertNonNegative,
  optPaymentMethod,
  optPropertyType,
  optIsoDate,
  parseIsoDate,
  requireNoteType,
  optCleaningFrequency,
  MAX_NAME_LENGTH,
  MAX_ADDRESS_LENGTH,
  MAX_NOTES_LENGTH,
} from "../lib/validation";
import {
  createCustomerService,
  PropertyCreateInput,
  PropertyUpdateInput,
} from "../services/customer.service";
import { createPropertyServicesService } from "../services/property-services";
import { createReportsService } from "../services/reports.service";
import { createPhotoGalleryService } from "../services/photo-gallery.service";

export const propertiesRouter = Router();
propertiesRouter.use(requireAuth);
propertiesRouter.use(requireTenantAccess);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
propertiesRouter.use(requireBusinessAccess());

// Thin routes: validate → call service → respond. No DB access here.
const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createCustomerService(req.tenantPrisma);
};

// ==========================================================================
// POST /properties — M6 Add Property (Customer + Property + ServicePlan, atomic)
// ==========================================================================
propertiesRouter.post(
  "/",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: PropertyCreateInput = {
      // Customer (step 1)
      customerName: requireString(body.customerName, "customerName", { maxLength: MAX_NAME_LENGTH }),
      phone: optString(body.phone, "phone"),
      landline: optString(body.landline, "landline"),
      email: optString(body.email, "email"),
      // Property (step 1)
      addressLine: requireString(body.addressLine, "addressLine", { maxLength: MAX_ADDRESS_LENGTH }).trim(),
      postcode: requireString(body.postcode, "postcode", { maxLength: MAX_ADDRESS_LENGTH }).trim(),
      propertyName: optString(body.propertyName, "propertyName", { maxLength: MAX_NAME_LENGTH }),
      propertyType: optPropertyType(body.propertyType),
      serviceAreaId: requireString(body.serviceAreaId, "serviceAreaId"),
      // Service Plan (step 2)
      serviceId: optId(body.serviceId, "serviceId"),
      price: assertPositive(requireNumber(body.price, "price"), "price", 9999.99),
      cleanMethod: optString(body.cleanMethod, "cleanMethod"),
      paymentMethod: optPaymentMethod(body.paymentMethod),
      // Schedule (step 3)
      nextDueDate: optIsoDate(body.nextDueDate, "nextDueDate"),
      lastCleanedDate: optIsoDate(body.lastCleanedDate, "lastCleanedDate"),
      // Notes (step 4)
      accessNotes: optString(body.accessNotes, "accessNotes", { maxLength: MAX_NOTES_LENGTH }),
      riskNotes: optString(body.riskNotes, "riskNotes", { maxLength: MAX_NOTES_LENGTH }),
      // Assignment (step 5 / Screen 31) — null = Save & Assign Later (unassigned)
      roundId: optId(body.roundId, "roundId"),
    };
    const result = await svc(req).createProperty(input);
    void createReportsService(req.tenantPrisma!).logActivity(
      "PROPERTY_ADDED",
      `Property added: ${input.addressLine}, ${input.postcode}`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );
    res.status(201).json(result);
  })
);

// ==========================================================================
// GET /properties/:id — one property with customer summary, plans, round,
// technician, payment status, pause state and next visit (contract:
// docs/BACKEND_CHANGES_2026-11-03.md section 19). 404 when unknown.
// ==========================================================================
propertiesRouter.get(
  "/:id",
  h(async (req, res) => {
    res.json(await svc(req).getProperty(req.params.id));
  })
);

// ==========================================================================
// PATCH /properties/:id — property edit + Move Round (assign/unassign).
// cleaningFrequency (without roundId) uses the B3 move logic shared with
// PATCH /service-plans/:id: 409 NO_MATCHING_ROUND (+ suggestions/proposedName)
// unless createRoundIfMissing; response adds movedToRound.
// ==========================================================================
propertiesRouter.patch(
  "/:id",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: PropertyUpdateInput = {
      addressLine: optReqString(body.addressLine, "addressLine", { maxLength: MAX_ADDRESS_LENGTH })?.trim(),
      postcode: optReqString(body.postcode, "postcode", { maxLength: MAX_ADDRESS_LENGTH })?.trim(),
      propertyName: optString(body.propertyName, "propertyName", { maxLength: MAX_NAME_LENGTH }),
      propertyType: optPropertyType(body.propertyType),
      serviceAreaId: optId(body.serviceAreaId, "serviceAreaId"),
      accessNotes: optString(body.accessNotes, "accessNotes", { maxLength: MAX_NOTES_LENGTH }),
      riskNotes: optString(body.riskNotes, "riskNotes", { maxLength: MAX_NOTES_LENGTH }),
      roundId: optId(body.roundId, "roundId"), // null = unassign; id = assign/reassign
      cleaningFrequency: optCleaningFrequency(body.cleaningFrequency),
      createRoundIfMissing: optBool(body.createRoundIfMissing, "createRoundIfMissing"),
    };
    res.json(await svc(req).updateProperty(req.params.id, input));
  })
);

// ==========================================================================
// PUT /properties/:id/services { serviceIds: string[], prices?: { [serviceId]: number } }
// BUG-08: replace the property's service list (add / remove / re-price) in one
// transaction → { propertyId, servicePlans, totalPrice, added, removed, cancelledVisits }.
// 400 empty list / bad prices, 404 unknown property or service, 400
// SERVICE_INACTIVE for an inactive service being added.
// ==========================================================================
propertiesRouter.put(
  "/:id/services",
  h(async (req, res) => {
    const body = asObject(req.body);
    const serviceIds = optStringArray(body.serviceIds, "serviceIds");
    if (!serviceIds || serviceIds.length === 0) {
      throw new AppError(400, "serviceIds must contain at least one service", "SERVICES_REQUIRED");
    }
    let prices: Record<string, number> | undefined;
    if (body.prices !== undefined) {
      const raw = asObject(body.prices);
      prices = {};
      for (const [id, v] of Object.entries(raw)) {
        prices[id] = assertNonNegative(requireNumber(v, `prices.${id}`), `prices.${id}`, 9999.99);
      }
    }
    res.json(
      await createPropertyServicesService(req.tenantPrisma!).setServices(
        req.params.id,
        { serviceIds, prices },
        { id: req.profile?.id, role: req.profile?.role }
      )
    );
  })
);

// ==========================================================================
// GET /properties/:id/services/history?page&pageSize — who changed the services
// when: { rows: [{ id, changedAt, actorId, actorRole, oldServices, newServices,
// added, removed }], pagination }, newest first.
// ==========================================================================
propertiesRouter.get(
  "/:id/services/history",
  h(async (req, res) => {
    const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, { defaultPageSize: 20, maxPageSize: 100 });
    res.json(await createPropertyServicesService(req.tenantPrisma!).history(req.params.id, page, pageSize));
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
      await svc(req).pauseService(req.params.id, {
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
    res.json(await svc(req).resumeService(req.params.id));
  })
);

// ==========================================================================
// GET /properties/:id/notes — Notes & Risk: pinned access/risk notes first,
// then notes newest first
// ==========================================================================
propertiesRouter.get(
  "/:id/notes",
  h(async (req, res) => {
    res.json(await svc(req).getNotes(req.params.id));
  })
);

// ==========================================================================
// GET /properties/:id/photos?type=BEFORE|AFTER|PROPERTY&page&pageSize (B4)
// ==========================================================================
const PHOTO_TYPES = Object.values(PhotoType) as string[];
propertiesRouter.get(
  "/:id/photos",
  h(async (req, res) => {
    const rawType = req.query.type;
    if (rawType !== undefined && (typeof rawType !== "string" || !PHOTO_TYPES.includes(rawType))) {
      throw new AppError(400, `type must be one of: ${PHOTO_TYPES.join(", ")}`);
    }
    const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, {
      defaultPageSize: 24,
      maxPageSize: 100,
    });
    res.json(
      await createPhotoGalleryService(req.tenantPrisma!).listPropertyPhotos(req.params.id, {
        page,
        pageSize,
        type: rawType as PhotoType | undefined,
      })
    );
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
    res.status(201).json(await svc(req).addNote(req.params.id, input));
  })
);

// ==========================================================================
// DELETE /properties/:id — soft-delete property (CANCELLED + cancels plans)
// ==========================================================================
propertiesRouter.delete(
  "/:id",
  h(async (req, res) => {
    await svc(req).deleteProperty(req.params.id);
    res.status(204).send();
  })
);
