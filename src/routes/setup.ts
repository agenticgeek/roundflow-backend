import { Request, Router } from "express";
import { PaymentTiming } from "../generated/tenant-client";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { validateWorkingDays, assertPositiveInt } from "../lib/validation";
import {
  asObject,
  asArray,
  h,
  requireString,
  requireNumber,
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
} from "../services/setup.service";

export const setupRouter = Router();
setupRouter.use(requireAuth);
setupRouter.use(requireTenantAccess);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
setupRouter.use(requireBusinessAccess());

const svc = (req: Request) => createSetupService(req.tenantPrisma!);

// ---- helpers -------------------------------------------------------------
// Generic request helpers (asObject, asArray, h, requireString, requireNumber)
// are shared via ../lib/http. Only route-local helpers live here.

// Returns the Supabase user ID of the acting caller (from the verified JWT).
// Named actorIdOf — not profileIdOf — because it returns supabaseUserId,
// which is distinct from Profile.id (a cuid). Phase 2 will add a separate
// tenantId resolver; do not conflate the two.
const actorIdOf = (req: Request): string => req.user!.supabaseUserId;

const STEP5_DEFERRED = {
  status: "deferred",
  reason: "SMS templates are managed via GHL",
} as const;

// ---- status --------------------------------------------------------------

setupRouter.get(
  "/status",
  h(async (req, res) => {
    res.json(await svc(req).getStatus(actorIdOf(req)));
  })
);

// ---- Step 1: Business Profile --------------------------------------------

setupRouter.get(
  "/step/1",
  h(async (req, res) => {
    res.json(await svc(req).getBusinessSettings(actorIdOf(req)));
  })
);
setupRouter.post(
  "/step/1",
  h(async (req, res) => {
    const profileId = actorIdOf(req);
    await svc(req).assertSetupIncomplete(profileId);
    const body = asObject(req.body);
    requireString(body.businessName, "businessName");
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
    };
    res.json(await svc(req).saveBusinessProfile(profileId, input));
  })
);

// ---- Step 2: Payment Setup -----------------------------------------------
// Real step (not a stub). Persists payment rules + VAT/debt-hold toggles to the
// BusinessSettings singleton. Connect toggles (gocardless/stripe) are Phase-1
// booleans — no real OAuth yet.

setupRouter.get(
  "/step/2",
  h(async (req, res) => {
    res.json(await svc(req).getPaymentSetup(actorIdOf(req)));
  })
);
setupRouter.post(
  "/step/2",
  h(async (req, res) => {
    const profileId = actorIdOf(req);
    await svc(req).assertSetupIncomplete(profileId);
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
    res.json(await svc(req).savePaymentSetup(profileId, input));
  })
);

// ---- Step 3: Service Catalogue -------------------------------------------

setupRouter.get(
  "/step/3",
  h(async (req, res) => {
    res.json(await svc(req).getServices(actorIdOf(req)));
  })
);
setupRouter.post(
  "/step/3",
  h(async (req, res) => {
    const profileId = actorIdOf(req);
    await svc(req).assertSetupIncomplete(profileId);
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
    res.json(await svc(req).saveServices(profileId, input));
  })
);

// ---- Step 4: Round Settings ----------------------------------------------

setupRouter.get(
  "/step/4",
  h(async (req, res) => {
    // Same BusinessSettings singleton as step 1; the frontend reads the
    // round-settings fields (defaultCycleLength / defaultWorkingDays) from it.
    res.json(await svc(req).getBusinessSettings(actorIdOf(req)));
  })
);
setupRouter.post(
  "/step/4",
  h(async (req, res) => {
    const profileId = actorIdOf(req);
    await svc(req).assertSetupIncomplete(profileId);
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
    res.json(await svc(req).saveRoundSettings(profileId, input));
  })
);

// ---- Step 5: SMS Templates (deferred) ------------------------------------

setupRouter.get("/step/5", h(async (_req, res) => res.json(STEP5_DEFERRED)));
setupRouter.post(
  "/step/5",
  h(async (_req, res) => {
    res.json(STEP5_DEFERRED); // deferred stub — no DB write, no setup-lock guard
  })
);

// ---- Step 6: Technicians (invite-pending) --------------------------------

setupRouter.get(
  "/step/6",
  h(async (req, res) => {
    res.json(await svc(req).getTechnicians(actorIdOf(req)));
  })
);
setupRouter.post(
  "/step/6",
  h(async (req, res) => {
    const profileId = actorIdOf(req);
    await svc(req).assertSetupIncomplete(profileId);
    const raw = asArray<Record<string, unknown>>(req.body, "technicians");
    const input: TechnicianInput[] = raw.map((t) => ({
      name: t.name as string | undefined,
      role: t.role as string | undefined,
      phone: t.phone as string | undefined,
      active: typeof t.active === "boolean" ? t.active : undefined,
    }));
    res.json(await svc(req).saveTechnicians(profileId, input));
  })
);

// ---- Step 7: Service Areas -----------------------------------------------

setupRouter.get(
  "/step/7",
  h(async (req, res) => {
    res.json(await svc(req).getServiceAreas(actorIdOf(req)));
  })
);
setupRouter.post(
  "/step/7",
  h(async (req, res) => {
    const profileId = actorIdOf(req);
    await svc(req).assertSetupIncomplete(profileId);
    const raw = asArray<Record<string, unknown>>(req.body, "serviceAreas");
    const input: ServiceAreaInput[] = raw.map((a, i) => ({
      name: requireString(a.name, `serviceAreas[${i}].name`),
      postcodeSector: a.postcodeSector as string | undefined,
      isDefault: typeof a.isDefault === "boolean" ? a.isDefault : undefined,
    }));
    res.json(await svc(req).saveServiceAreas(profileId, input));
  })
);

// ---- Step 8: First Round (ACTIVE) ----------------------------------------

setupRouter.get(
  "/step/8",
  h(async (req, res) => {
    res.json(await svc(req).getActiveRounds(actorIdOf(req)));
  })
);
setupRouter.post(
  "/step/8",
  h(async (req, res) => {
    const profileId = actorIdOf(req);
    await svc(req).assertSetupIncomplete(profileId);
    const body = asObject(req.body);
    const input: FirstRoundInput = {
      name: requireString(body.name, "name"),
      defaultDay: body.defaultDay as string | undefined,
      frequency: body.frequency as string | undefined,
      serviceAreaId: body.serviceAreaId as string | undefined,
    };
    res.json(await svc(req).saveFirstRound(profileId, input));
  })
);

// ---- Complete ------------------------------------------------------------
// Not guarded by assertSetupIncomplete: completing when already complete must
// return 409 (the service throws it), not the 403 that assert would raise.
setupRouter.post(
  "/complete",
  h(async (req, res) => {
    const profileId = actorIdOf(req);
    await svc(req).completeSetup(profileId);
    res.json(await svc(req).getStatus(profileId));
  })
);
