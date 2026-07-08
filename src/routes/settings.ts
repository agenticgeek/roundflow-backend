import { NextFunction, Request, Response, Router } from "express";
import { ServiceCategory, PaymentTiming } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { AppError } from "../lib/app-error";
import {
  settingsService,
  BusinessProfileUpdateInput,
  RoundSettingsUpdateInput,
  ServiceCreateInput,
  ServiceUpdateInput,
  ServiceAreaCreateInput,
  ServiceAreaUpdateInput,
  TechnicianCreateInput,
  TechnicianUpdateInput,
  PaymentRulesUpdateInput,
} from "../services/settings.service";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

// ---- helpers -------------------------------------------------------------
// Same pattern as src/routes/setup.ts. Settings routes are thin: validate →
// call service → respond. No DB access here. NOTE: unlike the wizard, there is
// NO assertSetupIncomplete guard — Settings is post-completion, always open.

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h =
  (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const profileIdOf = (req: Request): string => req.user!.supabaseUserId;

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

// Required validators (for create bodies).
function reqString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new AppError(400, `"${field}" is required and must be a non-empty string.`);
  }
  return v;
}
function reqNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AppError(400, `"${field}" is required and must be a number.`);
  }
  return v;
}

// Optional validators (for partial updates). undefined = omitted (untouched).
// `null` clears a nullable field; the `*Req*` variants reject null.
function optString(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string") return v;
  throw new AppError(400, `"${field}" must be a string or null.`);
}
function optReqString(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && v.trim() !== "") return v;
  throw new AppError(400, `"${field}" must be a non-empty string.`);
}
function optBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  throw new AppError(400, `"${field}" must be a boolean.`);
}
function optNumber(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new AppError(400, `"${field}" must be a number or null.`);
}
function optReqNumber(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new AppError(400, `"${field}" must be a number.`);
}
function optStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new AppError(400, `"${field}" must be an array of strings.`);
}
function optCategory(v: unknown): ServiceCategory | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && (Object.values(ServiceCategory) as string[]).includes(v)) {
    return v as ServiceCategory;
  }
  throw new AppError(400, `Invalid category: ${String(v)}`);
}
function optPaymentTiming(v: unknown): PaymentTiming | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string" && (Object.values(PaymentTiming) as string[]).includes(v)) {
    return v as PaymentTiming;
  }
  throw new AppError(400, `Invalid paymentRule: ${String(v)}`);
}

// ==========================================================================
// Section 1 — Business Profile
// ==========================================================================

settingsRouter.get(
  "/business-profile",
  h(async (req, res) => {
    res.json(await settingsService.getBusinessProfile(profileIdOf(req)));
  })
);
settingsRouter.patch(
  "/business-profile",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: BusinessProfileUpdateInput = {
      businessName: optString(body.businessName, "businessName"),
      phone: optString(body.phone, "phone"),
      email: optString(body.email, "email"),
      companyNumber: optString(body.companyNumber, "companyNumber"),
      vatRegistered: optBool(body.vatRegistered, "vatRegistered"),
      vatRegistration: optString(body.vatRegistration, "vatRegistration"),
      timezone: optString(body.timezone, "timezone"),
      currency: optString(body.currency, "currency"),
      defaultWorkingDays: optStringArray(body.defaultWorkingDays, "defaultWorkingDays"),
    };
    res.json(await settingsService.updateBusinessProfile(profileIdOf(req), input));
  })
);

// ==========================================================================
// Section 2 — Round Settings
// ==========================================================================

settingsRouter.get(
  "/round-settings",
  h(async (req, res) => {
    res.json(await settingsService.getRoundSettings(profileIdOf(req)));
  })
);
settingsRouter.patch(
  "/round-settings",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: RoundSettingsUpdateInput = {
      defaultCycleLength: optNumber(body.defaultCycleLength, "defaultCycleLength"),
      defaultWorkingDays: optStringArray(body.defaultWorkingDays, "defaultWorkingDays"),
    };
    res.json(await settingsService.updateRoundSettings(profileIdOf(req), input));
  })
);

// ==========================================================================
// Section 3 — Service Catalogue
// ==========================================================================

settingsRouter.get(
  "/services",
  h(async (req, res) => {
    res.json(await settingsService.getServices(profileIdOf(req)));
  })
);
settingsRouter.post(
  "/services",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: ServiceCreateInput = {
      name: reqString(body.name, "name"),
      defaultPrice: reqNumber(body.defaultPrice, "defaultPrice"),
      category: optCategory(body.category),
      description: optString(body.description, "description"),
      active: optBool(body.active, "active"),
    };
    res.status(201).json(await settingsService.createService(profileIdOf(req), input));
  })
);
settingsRouter.patch(
  "/services/:id",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: ServiceUpdateInput = {
      name: optReqString(body.name, "name"),
      defaultPrice: optReqNumber(body.defaultPrice, "defaultPrice"),
      category: optCategory(body.category),
      description: optString(body.description, "description"),
      active: optBool(body.active, "active"),
    };
    res.json(await settingsService.updateService(profileIdOf(req), req.params.id, input));
  })
);
settingsRouter.delete(
  "/services/:id",
  h(async (req, res) => {
    await settingsService.deleteService(profileIdOf(req), req.params.id);
    res.status(204).end();
  })
);

// ==========================================================================
// Section 4 — Service Areas
// ==========================================================================

settingsRouter.get(
  "/service-areas",
  h(async (req, res) => {
    res.json(await settingsService.getServiceAreas(profileIdOf(req)));
  })
);
settingsRouter.post(
  "/service-areas",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: ServiceAreaCreateInput = {
      name: reqString(body.name, "name"),
      postcodeSector: optString(body.postcodeSector, "postcodeSector"),
      isDefault: optBool(body.isDefault, "isDefault"),
    };
    res.status(201).json(await settingsService.createServiceArea(profileIdOf(req), input));
  })
);
settingsRouter.patch(
  "/service-areas/:id",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: ServiceAreaUpdateInput = {
      name: optReqString(body.name, "name"),
      postcodeSector: optString(body.postcodeSector, "postcodeSector"),
      isDefault: optBool(body.isDefault, "isDefault"),
    };
    res.json(await settingsService.updateServiceArea(profileIdOf(req), req.params.id, input));
  })
);
settingsRouter.delete(
  "/service-areas/:id",
  h(async (req, res) => {
    await settingsService.deleteServiceArea(profileIdOf(req), req.params.id);
    res.status(204).end();
  })
);

// ==========================================================================
// Section 5 — Technician Management
// ==========================================================================

settingsRouter.get(
  "/technicians",
  h(async (req, res) => {
    res.json(await settingsService.getTechnicians(profileIdOf(req)));
  })
);
settingsRouter.post(
  "/technicians",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: TechnicianCreateInput = {
      name: optString(body.name, "name"),
      phone: optString(body.phone, "phone"),
      role: optString(body.role, "role"),
      active: optBool(body.active, "active"),
    };
    res.status(201).json(await settingsService.createTechnician(profileIdOf(req), input));
  })
);
settingsRouter.patch(
  "/technicians/:id",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: TechnicianUpdateInput = {
      name: optString(body.name, "name"),
      phone: optString(body.phone, "phone"),
      role: optString(body.role, "role"),
      active: optBool(body.active, "active"),
    };
    res.json(await settingsService.updateTechnician(profileIdOf(req), req.params.id, input));
  })
);
settingsRouter.delete(
  "/technicians/:id",
  h(async (req, res) => {
    await settingsService.deleteTechnician(profileIdOf(req), req.params.id);
    res.status(204).end();
  })
);

// ==========================================================================
// Section 6 — Payment Setup
// ==========================================================================

settingsRouter.get(
  "/payment",
  h(async (req, res) => {
    res.json(await settingsService.getPaymentSetup(profileIdOf(req)));
  })
);
settingsRouter.patch(
  "/payment",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: PaymentRulesUpdateInput = {
      paymentRule: optPaymentTiming(body.paymentRule),
      vatInInvoices: optBool(body.vatInInvoices, "vatInInvoices"),
      debtHoldEnabled: optBool(body.debtHoldEnabled, "debtHoldEnabled"),
    };
    res.json(await settingsService.updatePaymentRules(profileIdOf(req), input));
  })
);
settingsRouter.post(
  "/payment/:provider/connect",
  h(async (req, res) => {
    const provider = req.params.provider;
    if (provider !== "gocardless" && provider !== "stripe") {
      throw new AppError(400, `Unknown provider: ${provider}. Use "gocardless" or "stripe".`);
    }
    res.json(await settingsService.connectProvider(profileIdOf(req), provider));
  })
);

// ==========================================================================
// Section 7 — SMS Templates (deferred stub)
// ==========================================================================

settingsRouter.get(
  "/message-templates",
  h(async (req, res) => {
    res.json(await settingsService.getMessageTemplates(profileIdOf(req)));
  })
);
settingsRouter.patch(
  "/message-templates",
  h(async (req, res) => {
    // Deferred stub — no DB write; returns the same deferred payload.
    res.json(await settingsService.getMessageTemplates(profileIdOf(req)));
  })
);
