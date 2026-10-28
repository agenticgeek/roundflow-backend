import { Request, Router } from "express";
import { PaymentTiming } from "../generated/tenant-client";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import {
  validateWorkingDays,
  assertPositiveInt,
  assertPositive,
  MAX_NAME_LENGTH,
  MAX_ADDRESS_LENGTH,
  MAX_NOTES_LENGTH,
} from "../lib/validation";
import {
  asObject,
  asArray,
  h,
  requireString,
  requireNumber,
  optString,
  optId,
  optStringArray,
} from "../lib/http";
import {
  createSetupService,
  BusinessProfileInput,
  PaymentSetupInput,
  RoundSettingsInput,
  ServiceInput,
  TechnicianInput,
  ServiceAreaInput,
  FirstRoundInput,
  SetupPropertyInput,
  BulkSetupPropertyResult,
  RoundTechnicianAssignment,
  ActivationInput,
} from "../services/setup.service";
import {
  createSettingsService,
  MessageTemplateInput,
} from "../services/settings.service";
import { requireMessageChannel } from "../lib/validation";

export const setupRouter = Router();
setupRouter.use(requireAuth);
setupRouter.use(requireTenantAccess);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
setupRouter.use(requireBusinessAccess());

const svc = (req: Request) => createSetupService(req.tenantPrisma!);

// ---- helpers -------------------------------------------------------------
// Generic request helpers (asObject, asArray, h, requireString, requireNumber)
// are shared via ../lib/http. Only route-local helpers live here.


const settingsSvc = (req: Request) => createSettingsService(req.tenantPrisma!, req.tenantSchemaName!);

// ---- status --------------------------------------------------------------

setupRouter.get(
  "/status",
  h(async (req, res) => {
    res.json(await svc(req).getStatus());
  })
);

// ---- Step 1: Business Profile --------------------------------------------

setupRouter.get(
  "/step/1",
  h(async (req, res) => {
    res.json(await svc(req).getBusinessSettings());
  })
);
setupRouter.post(
  "/step/1",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();
    const body = asObject(req.body);
    requireString(body.businessName, "businessName", { maxLength: MAX_NAME_LENGTH });
    let bankDetails: BusinessProfileInput["bankDetails"] = undefined;
    if (body.bankDetails !== undefined) {
      if (body.bankDetails === null) {
        bankDetails = null;
      } else if (typeof body.bankDetails !== "object" || Array.isArray(body.bankDetails)) {
        throw new AppError(400, '"bankDetails" must be an object or null');
      } else {
        const b = body.bankDetails as Record<string, unknown>;
        const accountName = requireString(b.accountName, "bankDetails.accountName").trim();
        if (!accountName) throw new AppError(400, '"bankDetails.accountName" must not be blank');
        const accountNumber = requireString(b.accountNumber, "bankDetails.accountNumber").trim();
        if (!accountNumber) throw new AppError(400, '"bankDetails.accountNumber" must not be blank');
        const sortCode = requireString(b.sortCode, "bankDetails.sortCode").trim();
        if (!sortCode) throw new AppError(400, '"bankDetails.sortCode" must not be blank');
        const bankName = typeof b.bankName === "string" ? b.bankName : null;
        bankDetails = { accountName, bankName, accountNumber, sortCode };
      }
    }
    const input: BusinessProfileInput = {
      businessName: body.businessName as string,
      phone: body.phone as string | undefined,
      email: body.email as string | undefined,
      companyNumber: body.companyNumber as string | undefined,
      vatRegistered:
        typeof body.vatRegistered === "boolean" ? body.vatRegistered : undefined,
      vatRegistration: body.vatRegistration as string | undefined,
      defaultWorkingDays: Array.isArray(body.defaultWorkingDays)
        ? validateWorkingDays(body.defaultWorkingDays)
        : undefined,
      timezone: body.timezone as string | undefined,
      currency: body.currency as string | undefined,
      bankDetails,
    };
    res.json(await svc(req).saveBusinessProfile(input));
  })
);

// ---- Step 2: Payment Setup -----------------------------------------------
// Real step (not a stub). Persists payment rules + VAT/debt-hold toggles to the
// BusinessSettings singleton. Connect toggles (gocardless/stripe) are Phase-1
// booleans — no real OAuth yet.

setupRouter.get(
  "/step/2",
  h(async (req, res) => {
    res.json(await svc(req).getPaymentSetup());
  })
);
setupRouter.post(
  "/step/2",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();
    const body = asObject(req.body);

    let paymentRule: PaymentTiming | undefined;
    if (body.paymentRule != null) {
      if (!(Object.values(PaymentTiming) as string[]).includes(body.paymentRule as string)) {
        throw new AppError(400, `Invalid paymentRule: ${String(body.paymentRule)}`);
      }
      paymentRule = body.paymentRule as PaymentTiming;
    }

    const input: PaymentSetupInput = {
      paymentRule,
      debtHoldEnabled:
        typeof body.debtHoldEnabled === "boolean" ? body.debtHoldEnabled : undefined,
      vatInInvoices:
        typeof body.vatInInvoices === "boolean" ? body.vatInInvoices : undefined,
      gocardlessConnected:
        typeof body.gocardlessConnected === "boolean" ? body.gocardlessConnected : undefined,
      stripeConnected:
        typeof body.stripeConnected === "boolean" ? body.stripeConnected : undefined,
    };
    res.json(await svc(req).savePaymentSetup(input));
  })
);

// ---- Step 3: Service Catalogue -------------------------------------------

setupRouter.get(
  "/step/3",
  h(async (req, res) => {
    res.json(await svc(req).getServices());
  })
);
setupRouter.post(
  "/step/3",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();
    const raw = asArray<Record<string, unknown>>(req.body, "services");
    const input: ServiceInput[] = raw.map((s, i) => ({
      name: requireString(s.name, `services[${i}].name`),
      category: s.category as string | undefined,
      description: s.description as string | undefined,
      defaultPrice: (() => {
        const p = requireNumber(s.defaultPrice, `services[${i}].defaultPrice`);
        if (p < 0) throw new AppError(400, `services[${i}].defaultPrice must be >= 0`);
        return p;
      })(),
      active: typeof s.active === "boolean" ? s.active : undefined,
    }));
    res.json(await svc(req).saveServices(input));
  })
);

// ---- Step 4: Round Settings ----------------------------------------------

setupRouter.get(
  "/step/4",
  h(async (req, res) => {
    // Same BusinessSettings singleton as step 1; the frontend reads the
    // round-settings fields (defaultCycleLength / defaultWorkingDays) from it.
    res.json(await svc(req).getBusinessSettings());
  })
);
setupRouter.post(
  "/step/4",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();
    const body = asObject(req.body);
    const input: RoundSettingsInput = {
      defaultCycleLength: assertPositiveInt(
        requireNumber(body.defaultCycleLength, "defaultCycleLength"),
        "defaultCycleLength"
      ),
      defaultWorkingDays: Array.isArray(body.defaultWorkingDays)
        ? validateWorkingDays(body.defaultWorkingDays)
        : undefined,
    };
    res.json(await svc(req).saveRoundSettings(input));
  })
);

// ---- Step 5: Message Templates (SMS / WhatsApp / Email) ------------------

setupRouter.get(
  "/step/5",
  h(async (req, res) => {
    res.json(await settingsSvc(req).getMessageTemplates());
  })
);
setupRouter.post(
  "/step/5",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();
    const raw = asArray<Record<string, unknown>>(req.body, "templates");
    const templates: MessageTemplateInput[] = raw.map((t) => ({
      name: requireString(t.name, "name"),
      channel: requireMessageChannel(t.channel),
      body: requireString(t.body, "body"),
      subject: optString(t.subject, "subject"),
    }));
    res.json(await settingsSvc(req).replaceTemplates(templates));
  })
);

// ---- Step 6: Technicians (invite-pending) --------------------------------

setupRouter.get(
  "/step/6",
  h(async (req, res) => {
    res.json(await svc(req).getTechnicians());
  })
);
setupRouter.post(
  "/step/6",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();
    const raw = asArray<Record<string, unknown>>(req.body, "technicians");
    const input: TechnicianInput[] = raw.map((t, i) => ({
      name: optString(t.name, `technicians[${i}].name`, { maxLength: MAX_NAME_LENGTH }),
      role: optString(t.role, `technicians[${i}].role`),
      phone: optString(t.phone, `technicians[${i}].phone`),
      email: optString(t.email, `technicians[${i}].email`),
      active: typeof t.active === "boolean" ? t.active : undefined,
      serviceAreaIds: optStringArray(t.serviceAreaIds, `technicians[${i}].serviceAreaIds`),
    }));
    res.json(await svc(req).saveTechnicians(input));
  })
);

// ---- Step 7: Service Areas -----------------------------------------------

setupRouter.get(
  "/step/7",
  h(async (req, res) => {
    res.json(await svc(req).getServiceAreas());
  })
);
setupRouter.post(
  "/step/7",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();
    const raw = asArray<Record<string, unknown>>(req.body, "serviceAreas");
    if (raw.length === 0) throw new AppError(400, "At least one service area is required.");
    const input: ServiceAreaInput[] = raw.map((a, i) => ({
      name: requireString(a.name, `serviceAreas[${i}].name`, { maxLength: MAX_NAME_LENGTH }),
      postcodeSector: a.postcodeSector as string | undefined,
      isDefault: typeof a.isDefault === "boolean" ? a.isDefault : undefined,
    }));
    res.json(await svc(req).saveServiceAreas(input));
  })
);

// ---- Step 8: First Round (ACTIVE) ----------------------------------------

setupRouter.get(
  "/step/8",
  h(async (req, res) => {
    res.json(await svc(req).getActiveRounds());
  })
);
setupRouter.post(
  "/step/8",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();
    const body = asObject(req.body);
    const input: FirstRoundInput = {
      name: requireString(body.name, "name"),
      defaultDay: body.defaultDay as string | undefined,
      frequency: body.frequency as string | undefined,
      serviceAreaId: body.serviceAreaId as string | undefined,
    };
    res.json(await svc(req).saveFirstRound(input));
  })
);

// ---- Step 9: Add Property ------------------------------------------------
// One-time setup property creation. Does NOT reuse /customers or /properties.
// Multiple properties may be added during setup by calling this endpoint
// multiple times.

setupRouter.get(
  "/step/9",
  h(async (req, res) => {
    res.json(await svc(req).getSetupProperties());
  })
);
setupRouter.post(
  "/step/9",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();
    const body = asObject(req.body);

    const input: SetupPropertyInput = {
      customerName: requireString(body.customerName, "customerName", { maxLength: MAX_NAME_LENGTH }),
      propertyName: optString(body.propertyName, "propertyName", { maxLength: MAX_NAME_LENGTH }) ?? null,
      phone: optString(body.phone, "phone") ?? null,
      landline: optString(body.landline, "landline") ?? null,
      email: optString(body.email, "email") ?? null,
      fullAddress: requireString(body.fullAddress, "fullAddress", { maxLength: MAX_ADDRESS_LENGTH }),
      postcode: requireString(body.postcode, "postcode", { maxLength: MAX_ADDRESS_LENGTH }),
      serviceAreaId: requireString(body.serviceAreaId, "serviceAreaId"),
      propertyType: optString(body.propertyType, "propertyType") ?? null,
      price: assertPositive(requireNumber(body.price, "price"), "price"),
      cleaningFrequency: optString(body.cleaningFrequency, "cleaningFrequency") ?? null,
      paymentMethod: optString(body.paymentMethod, "paymentMethod") ?? null,
      serviceId: optId(body.serviceId, "serviceId") ?? null,
      serviceIds: optStringArray(body.serviceIds, "serviceIds") ?? null,
      accessNotes: optString(body.accessNotes, "accessNotes", { maxLength: MAX_NOTES_LENGTH }) ?? null,
      riskNotes: optString(body.riskNotes, "riskNotes", { maxLength: MAX_NOTES_LENGTH }) ?? null,
      // L-1: roundId is required so the property counts toward step 9 completion.
      // A property with no round cannot be scheduled and would leave step 9 stuck.
      roundId: requireString(body.roundId, "roundId"),
    };

    res.status(201).json(await svc(req).addSetupProperty(input));
  })
);

// ---- Step 9: Bulk Import Properties --------------------------------------
// Accepts up to 1000 properties in one call. Processes in batches of 100,
// each batch in its own transaction. A row that fails parsing/validation (or
// a batch that fails to commit) is reported in `errors[]` by its original
// row index — it does not abort the other, valid rows in the same request.
// Pass `idempotencyKey` to make a retried call (e.g. after a client timeout)
// safe: a repeat call with the same key returns the original result instead
// of re-creating the same rows.

// Attaches which field failed to a parse error, so the response's errors[]
// can report a real field name instead of "unknown".
class RowFieldError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
  }
}

function need<T>(field: string, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    throw new RowFieldError(field, err instanceof Error ? err.message : String(err));
  }
}

function parseBulkRow(body: Record<string, unknown>): SetupPropertyInput {
  return {
    customerName: need("customerName", () => requireString(body.customerName, "customerName", { maxLength: MAX_NAME_LENGTH })),
    propertyName: need("propertyName", () => optString(body.propertyName, "propertyName", { maxLength: MAX_NAME_LENGTH }) ?? null),
    phone: need("phone", () => optString(body.phone, "phone") ?? null),
    landline: need("landline", () => optString(body.landline, "landline") ?? null),
    email: need("email", () => optString(body.email, "email") ?? null),
    fullAddress: need("fullAddress", () => requireString(body.fullAddress, "fullAddress", { maxLength: MAX_ADDRESS_LENGTH })),
    postcode: need("postcode", () => requireString(body.postcode, "postcode", { maxLength: MAX_ADDRESS_LENGTH })),
    serviceAreaId: need("serviceAreaId", () => requireString(body.serviceAreaId, "serviceAreaId")),
    propertyType: need("propertyType", () => optString(body.propertyType, "propertyType") ?? null),
    price: need("price", () => assertPositive(requireNumber(body.price, "price"), "price")),
    cleaningFrequency: need("cleaningFrequency", () => optString(body.cleaningFrequency, "cleaningFrequency") ?? null),
    paymentMethod: need("paymentMethod", () => optString(body.paymentMethod, "paymentMethod") ?? null),
    serviceId: need("serviceId", () => optId(body.serviceId, "serviceId") ?? null),
    serviceIds: need("serviceIds", () => optStringArray(body.serviceIds, "serviceIds") ?? null),
    accessNotes: need("accessNotes", () => optString(body.accessNotes, "accessNotes", { maxLength: MAX_NOTES_LENGTH }) ?? null),
    riskNotes: need("riskNotes", () => optString(body.riskNotes, "riskNotes", { maxLength: MAX_NOTES_LENGTH }) ?? null),
    roundId: need("roundId", () => requireString(body.roundId, "roundId")),
  };
}

setupRouter.post(
  "/step/9/bulk",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();

    const body = asObject(req.body);
    const rows = asArray<Record<string, unknown>>(body.properties, "properties");
    const idempotencyKey = optString(body.idempotencyKey, "idempotencyKey") ?? undefined;

    // originalIndexes[i] = the row's position in `rows`, for inputs[i].
    const errors: { row: number; field: string; message: string }[] = [];
    const inputs: SetupPropertyInput[] = [];
    const originalIndexes: number[] = [];
    rows.forEach((row, i) => {
      try {
        inputs.push(parseBulkRow(row));
        originalIndexes.push(i);
      } catch (err) {
        // parseBulkRow() wraps every field parser through need(), which only
        // ever throws RowFieldError — this always has a real field name.
        const e = err as RowFieldError;
        errors.push({ row: i, field: e.field, message: e.message });
      }
    });

    const serviceResult: BulkSetupPropertyResult =
      inputs.length > 0
        ? await svc(req).bulkAddSetupProperties(inputs, idempotencyKey)
        : { created: 0, failed: 0, results: [], errors: [] };

    // Remap service-level errors (indexed into `inputs`) back to the
    // original `rows` index so every error in the response is addressable
    // against what the caller actually submitted.
    const remappedServiceErrors = serviceResult.errors.map((e) => ({
      ...e,
      row: originalIndexes[e.row],
    }));

    const result: BulkSetupPropertyResult = {
      created: serviceResult.created,
      failed: rows.length - serviceResult.created,
      results: serviceResult.results,
      errors: [...errors, ...remappedServiceErrors].sort((a, b) => a.row - b.row),
      ...(serviceResult.idempotent ? { idempotent: true } : {}),
    };

    const allRowsFailed = rows.length > 0 && result.created === 0 && !result.idempotent;
    res.status(allRowsFailed ? 400 : 201).json(result);
  })
);

// ---- Step 10: Assign Technicians to Rounds --------------------------------

setupRouter.get(
  "/step/10",
  h(async (req, res) => {
    res.json(await svc(req).getSetupRoundAssignments());
  })
);
setupRouter.post(
  "/step/10",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();

    const raw = asArray<Record<string, unknown>>(req.body, "assignments");
    const assignments: RoundTechnicianAssignment[] = raw.map((a, i) => {
      const roundId = requireString(a.roundId, `assignments[${i}].roundId`);
      const techIds = a.technicianIds;
      if (!Array.isArray(techIds) || !techIds.every((t) => typeof t === "string")) {
        throw new AppError(
          400,
          `assignments[${i}].technicianIds must be an array of strings`
        );
      }
      return { roundId, technicianIds: techIds as string[] };
    });

    res.json(await svc(req).assignTechniciansToRounds(assignments));
  })
);

// ---- Step 11: Activate System & Generate Visits ---------------------------

setupRouter.get(
  "/step/11",
  h(async (req, res) => {
    res.json(await svc(req).getActivationStatus());
  })
);
setupRouter.post(
  "/step/11",
  h(async (req, res) => {
    await svc(req).assertSetupIncomplete();
    const body = asObject(req.body);

    const generateAll =
      typeof body.generateAll === "boolean" ? body.generateAll : true;
    const startDate = requireString(body.startDate, "startDate");
    const cycleWeeks = assertPositiveInt(
      requireNumber(body.cycleWeeks, "cycleWeeks"),
      "cycleWeeks"
    );

    let roundIds: string[] | undefined;
    if (!generateAll) {
      if (!Array.isArray(body.roundIds) || body.roundIds.length === 0) {
        throw new AppError(
          400,
          "roundIds is required and must be a non-empty array when generateAll is false"
        );
      }
      if (!body.roundIds.every((id: unknown) => typeof id === "string")) {
        throw new AppError(400, "roundIds must be an array of strings");
      }
      roundIds = body.roundIds as string[];
    }

    const input: ActivationInput = { generateAll, startDate, cycleWeeks, roundIds };
    res.json(await svc(req).activateSystem(input));
  })
);

// ---- Step 12: Review & Launch (checklist) ---------------------------------

setupRouter.get(
  "/step/12",
  h(async (req, res) => {
    res.json(await svc(req).getReviewChecklist());
  })
);

// ---- Complete ------------------------------------------------------------
// Not guarded by assertSetupIncomplete: completing when already complete must
// return 409 (the service throws it), not the 403 that assert would raise.
setupRouter.post(
  "/complete",
  h(async (req, res) => {
    await svc(req).completeSetup();
    res.json(await svc(req).getStatus());
  })
);
