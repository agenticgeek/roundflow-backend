import { Request, Router } from "express";
import { ServiceCategory, PaymentTiming } from "../generated/tenant-client";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { validateWorkingDays, assertPositiveInt, assertPositive, assertNonNegative, requireMessageChannel, optMessageChannel } from "../lib/validation";
import {
  asObject,
  h,
  requireString,
  requireNumber,
  optString,
  optReqString,
  optBool,
  optNumber,
  optReqNumber,
  optStringArray,
} from "../lib/http";
import {
  createSettingsService,
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
settingsRouter.use(requireTenantAccess);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
settingsRouter.use(requireBusinessAccess());

const svc = (req: Request) => createSettingsService(req.tenantPrisma!);

// ---- helpers -------------------------------------------------------------
// Settings routes are thin: validate → call service → respond. No DB access
// here. GET endpoints are always open (so the Setup Wizard can read back saved
// values); every mutating handler (PATCH, POST, DELETE) first calls
// `assertSetupComplete`, which 403s until setup is complete. (This is the
// inverse of the wizard's `assertSetupIncomplete`.)
//
// Generic request helpers (asObject, h, requireString, requireNumber, and the
// opt* validators) are shared via ../lib/http. Only route-local helpers — the
// actor id and the domain-specific validators — live here.

// Returns the Supabase user ID of the acting caller (from the verified JWT).
// Named actorIdOf — not profileIdOf — because it returns supabaseUserId,
// which is distinct from Profile.id (a cuid). Phase 2 will add a separate
// tenantId resolver; do not conflate the two.
const actorIdOf = (req: Request): string => req.user!.supabaseUserId;

// Working-days array: omitted = untouched; otherwise every element must be a
// valid DayOfWeek (shared validator).
function optWorkingDays(v: unknown, field: string): string[] | undefined {
  const arr = optStringArray(v, field);
  return arr === undefined ? undefined : validateWorkingDays(arr);
}
// Cycle length: omitted = untouched; null clears; a number must be a positive integer.
function optCycleLength(v: unknown): number | null | undefined {
  const n = optNumber(v, "defaultCycleLength");
  if (typeof n === "number") assertPositiveInt(n, "defaultCycleLength");
  return n;
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
    res.json(await svc(req).getBusinessProfile(actorIdOf(req)));
  })
);
settingsRouter.patch(
  "/business-profile",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
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
      defaultWorkingDays: optWorkingDays(body.defaultWorkingDays, "defaultWorkingDays"),
    };
    res.json(await svc(req).updateBusinessProfile(actorIdOf(req), input));
  })
);

// ==========================================================================
// Section 2 — Round Settings
// ==========================================================================

settingsRouter.get(
  "/round-settings",
  h(async (req, res) => {
    res.json(await svc(req).getRoundSettings(actorIdOf(req)));
  })
);
settingsRouter.patch(
  "/round-settings",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const body = asObject(req.body);
    const input: RoundSettingsUpdateInput = {
      defaultCycleLength: optCycleLength(body.defaultCycleLength),
      defaultWorkingDays: optWorkingDays(body.defaultWorkingDays, "defaultWorkingDays"),
    };
    res.json(await svc(req).updateRoundSettings(actorIdOf(req), input));
  })
);

// ==========================================================================
// Section 3 — Service Catalogue
// ==========================================================================

settingsRouter.get(
  "/services",
  h(async (req, res) => {
    res.json(await svc(req).getServices(actorIdOf(req)));
  })
);
settingsRouter.post(
  "/services",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const body = asObject(req.body);
    const input: ServiceCreateInput = {
      name: requireString(body.name, "name"),
      defaultPrice: assertNonNegative(requireNumber(body.defaultPrice, "defaultPrice"), "defaultPrice", 9999.99),
      category: optCategory(body.category),
      description: optString(body.description, "description"),
      active: optBool(body.active, "active"),
    };
    res.status(201).json(await svc(req).createService(actorIdOf(req), input));
  })
);
settingsRouter.patch(
  "/services/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const body = asObject(req.body);
    const price = optReqNumber(body.defaultPrice, "defaultPrice");
    if (price !== undefined) assertNonNegative(price, "defaultPrice", 9999.99);
    const input: ServiceUpdateInput = {
      name: optReqString(body.name, "name"),
      defaultPrice: price,
      category: optCategory(body.category),
      description: optString(body.description, "description"),
      active: optBool(body.active, "active"),
    };
    res.json(await svc(req).updateService(actorIdOf(req), req.params.id, input));
  })
);
settingsRouter.delete(
  "/services/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    await svc(req).deleteService(actorIdOf(req), req.params.id);
    res.status(204).end();
  })
);

// ==========================================================================
// Section 4 — Service Areas
// ==========================================================================

settingsRouter.get(
  "/service-areas",
  h(async (req, res) => {
    res.json(await svc(req).getServiceAreas(actorIdOf(req)));
  })
);
settingsRouter.post(
  "/service-areas",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const body = asObject(req.body);
    const input: ServiceAreaCreateInput = {
      name: requireString(body.name, "name"),
      postcodeSector: optString(body.postcodeSector, "postcodeSector"),
      isDefault: optBool(body.isDefault, "isDefault"),
    };
    res.status(201).json(await svc(req).createServiceArea(actorIdOf(req), input));
  })
);
settingsRouter.patch(
  "/service-areas/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const body = asObject(req.body);
    const input: ServiceAreaUpdateInput = {
      name: optReqString(body.name, "name"),
      postcodeSector: optString(body.postcodeSector, "postcodeSector"),
      isDefault: optBool(body.isDefault, "isDefault"),
    };
    res.json(await svc(req).updateServiceArea(actorIdOf(req), req.params.id, input));
  })
);
settingsRouter.delete(
  "/service-areas/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    await svc(req).deleteServiceArea(actorIdOf(req), req.params.id);
    res.status(204).end();
  })
);

// ==========================================================================
// Section 5 — Technician Management
// ==========================================================================

settingsRouter.get(
  "/technicians",
  h(async (req, res) => {
    res.json(await svc(req).getTechnicians(actorIdOf(req)));
  })
);
settingsRouter.post(
  "/technicians",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const body = asObject(req.body);
    const input: TechnicianCreateInput = {
      name: optString(body.name, "name"),
      phone: optString(body.phone, "phone"),
      role: optString(body.role, "role"),
      active: optBool(body.active, "active"),
    };
    res.status(201).json(await svc(req).createTechnician(actorIdOf(req), input));
  })
);
settingsRouter.patch(
  "/technicians/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const body = asObject(req.body);
    const input: TechnicianUpdateInput = {
      name: optString(body.name, "name"),
      phone: optString(body.phone, "phone"),
      role: optString(body.role, "role"),
      active: optBool(body.active, "active"),
    };
    res.json(await svc(req).updateTechnician(actorIdOf(req), req.params.id, input));
  })
);
settingsRouter.delete(
  "/technicians/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    await svc(req).deleteTechnician(actorIdOf(req), req.params.id);
    res.status(204).end();
  })
);

// ==========================================================================
// Section 6 — Payment Setup
// ==========================================================================

settingsRouter.get(
  "/payment",
  h(async (req, res) => {
    res.json(await svc(req).getPaymentSetup(actorIdOf(req)));
  })
);
settingsRouter.patch(
  "/payment",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const body = asObject(req.body);
    const input: PaymentRulesUpdateInput = {
      paymentRule: optPaymentTiming(body.paymentRule),
      vatInInvoices: optBool(body.vatInInvoices, "vatInInvoices"),
      debtHoldEnabled: optBool(body.debtHoldEnabled, "debtHoldEnabled"),
    };
    res.json(await svc(req).updatePaymentRules(actorIdOf(req), input));
  })
);
settingsRouter.post(
  "/payment/:provider/connect",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const provider = req.params.provider;
    if (provider !== "gocardless" && provider !== "stripe") {
      throw new AppError(400, `Unknown provider: ${provider}. Use "gocardless" or "stripe".`);
    }
    res.json(await svc(req).connectProvider(actorIdOf(req), provider));
  })
);

// ==========================================================================
// Section 7 — Message Templates (SMS / WhatsApp / Email via Resend)
// ==========================================================================

settingsRouter.get(
  "/message-templates",
  h(async (req, res) => {
    res.json(await svc(req).getMessageTemplates(actorIdOf(req)));
  })
);

settingsRouter.post(
  "/message-templates",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const body = asObject(req.body);
    const input = {
      name: requireString(body.name, "name"),
      channel: requireMessageChannel(body.channel),
      body: requireString(body.body, "body"),
      subject: optString(body.subject, "subject"),
    };
    res.status(201).json(await svc(req).createMessageTemplate(actorIdOf(req), input));
  })
);

settingsRouter.patch(
  "/message-templates/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    const body = asObject(req.body);
    const input = {
      name: optReqString(body.name, "name"),
      channel: optMessageChannel(body.channel),
      body: optReqString(body.body, "body"),
      subject: optString(body.subject, "subject"),
    };
    res.json(await svc(req).updateMessageTemplate(actorIdOf(req), req.params.id, input));
  })
);

settingsRouter.delete(
  "/message-templates/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete(actorIdOf(req));
    await svc(req).deleteMessageTemplate(actorIdOf(req), req.params.id);
    res.status(204).send();
  })
);
