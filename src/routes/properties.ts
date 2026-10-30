import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, requireNumber, optString, optReqString, optId, optBool, parsePageParams } from "../lib/http";
import { PhotoType } from "../generated/tenant-client";
import {
  assertPositive,
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
