import { NextFunction, Request, Response, Router } from "express";
import { PaymentTiming } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { validateWorkingDays, assertPositiveInt } from "../lib/validation";
import {
  setupService,
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
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
setupRouter.use(requireBusinessAccess());

// ---- helpers -------------------------------------------------------------

// Forward async errors to the centralised error handler (Express 4 doesn't
// auto-catch rejected promises).
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

// Accept either a raw array body or `{ [key]: [...] }`.
function asArray<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as any)[key])) {
    return (body as any)[key] as T[];
  }
  throw new AppError(400, `Expected an array (raw, or under "${key}").`);
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new AppError(400, `"${field}" is required and must be a non-empty string.`);
  }
  return v;
}

function requireNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AppError(400, `"${field}" is required and must be a number.`);
  }
  return v;
}

const STEP5_DEFERRED = {
  status: "deferred",
  reason: "SMS templates are managed via GHL",
} as const;

// ---- status --------------------------------------------------------------

setupRouter.get(
  "/status",
  h(async (req, res) => {
    res.json(await setupService.getStatus(profileIdOf(req)));
  })
);

// ---- Step 1: Business Profile --------------------------------------------

setupRouter.get(
  "/step/1",
  h(async (req, res) => {
    res.json(await setupService.getBusinessSettings(profileIdOf(req)));
  })
);
setupRouter.post(
  "/step/1",
  h(async (req, res) => {
    const profileId = profileIdOf(req);
    await setupService.assertSetupIncomplete(profileId);
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
    res.json(await setupService.saveBusinessProfile(profileId, input));
  })
);

// ---- Step 2: Payment Setup -----------------------------------------------
// Real step (not a stub). Persists payment rules + VAT/debt-hold toggles to the
// BusinessSettings singleton. Connect toggles (gocardless/stripe) are Phase-1
// booleans — no real OAuth yet.

setupRouter.get(
  "/step/2",
  h(async (req, res) => {
    res.json(await setupService.getPaymentSetup(profileIdOf(req)));
  })
);
setupRouter.post(
  "/step/2",
  h(async (req, res) => {
    const profileId = profileIdOf(req);
    await setupService.assertSetupIncomplete(profileId);
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
    res.json(await setupService.savePaymentSetup(profileId, input));
  })
);

// ---- Step 3: Service Catalogue -------------------------------------------

setupRouter.get(
  "/step/3",
  h(async (req, res) => {
    res.json(await setupService.getServices(profileIdOf(req)));
  })
);
setupRouter.post(
  "/step/3",
  h(async (req, res) => {
    const profileId = profileIdOf(req);
    await setupService.assertSetupIncomplete(profileId);
    const raw = asArray<Record<string, unknown>>(req.body, "services");
    const input: ServiceInput[] = raw.map((s, i) => ({
      name: requireString(s.name, `services[${i}].name`),
      category: s.category as string | undefined,
      description: s.description as string | undefined,
      defaultPrice: requireNumber(s.defaultPrice, `services[${i}].defaultPrice`),
      active: typeof s.active === "boolean" ? s.active : undefined,
    }));
    res.json(await setupService.saveServices(profileId, input));
  })
);

// ---- Step 4: Round Settings ----------------------------------------------

setupRouter.get(
  "/step/4",
  h(async (req, res) => {
    // Same BusinessSettings singleton as step 1; the frontend reads the
    // round-settings fields (defaultCycleLength / defaultWorkingDays) from it.
    res.json(await setupService.getBusinessSettings(profileIdOf(req)));
  })
);
setupRouter.post(
  "/step/4",
  h(async (req, res) => {
    const profileId = profileIdOf(req);
    await setupService.assertSetupIncomplete(profileId);
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
    res.json(await setupService.saveRoundSettings(profileId, input));
  })
);

// ---- Step 5: SMS Templates (deferred) ------------------------------------

setupRouter.get("/step/5", h(async (_req, res) => res.json(STEP5_DEFERRED)));
setupRouter.post(
  "/step/5",
  h(async (req, res) => {
    await setupService.assertSetupIncomplete(profileIdOf(req));
    res.json(STEP5_DEFERRED); // deferred stub — no DB write
  })
);

// ---- Step 6: Technicians (invite-pending) --------------------------------

setupRouter.get(
  "/step/6",
  h(async (req, res) => {
    res.json(await setupService.getTechnicians(profileIdOf(req)));
  })
);
setupRouter.post(
  "/step/6",
  h(async (req, res) => {
    const profileId = profileIdOf(req);
    await setupService.assertSetupIncomplete(profileId);
    const raw = asArray<Record<string, unknown>>(req.body, "technicians");
    const input: TechnicianInput[] = raw.map((t) => ({
      name: t.name as string | undefined,
      role: t.role as string | undefined,
      phone: t.phone as string | undefined,
      active: typeof t.active === "boolean" ? t.active : undefined,
    }));
    res.json(await setupService.saveTechnicians(profileId, input));
  })
);

// ---- Step 7: Service Areas -----------------------------------------------

setupRouter.get(
  "/step/7",
  h(async (req, res) => {
    res.json(await setupService.getServiceAreas(profileIdOf(req)));
  })
);
setupRouter.post(
  "/step/7",
  h(async (req, res) => {
    const profileId = profileIdOf(req);
    await setupService.assertSetupIncomplete(profileId);
    const raw = asArray<Record<string, unknown>>(req.body, "serviceAreas");
    const input: ServiceAreaInput[] = raw.map((a, i) => ({
      name: requireString(a.name, `serviceAreas[${i}].name`),
      postcodeSector: a.postcodeSector as string | undefined,
      isDefault: typeof a.isDefault === "boolean" ? a.isDefault : undefined,
    }));
    res.json(await setupService.saveServiceAreas(profileId, input));
  })
);

// ---- Step 8: First Round (ACTIVE) ----------------------------------------

setupRouter.get(
  "/step/8",
  h(async (req, res) => {
    res.json(await setupService.getActiveRounds(profileIdOf(req)));
  })
);
setupRouter.post(
  "/step/8",
  h(async (req, res) => {
    const profileId = profileIdOf(req);
    await setupService.assertSetupIncomplete(profileId);
    const body = asObject(req.body);
    const input: FirstRoundInput = {
      name: requireString(body.name, "name"),
      defaultDay: body.defaultDay as string | undefined,
      frequency: body.frequency as string | undefined,
      serviceAreaId: body.serviceAreaId as string | undefined,
    };
    res.json(await setupService.saveFirstRound(profileId, input));
  })
);

// ---- Complete ------------------------------------------------------------
// Not guarded by assertSetupIncomplete: completing when already complete must
// return 409 (the service throws it), not the 403 that assert would raise.
setupRouter.post(
  "/complete",
  h(async (req, res) => {
    const profileId = profileIdOf(req);
    await setupService.completeSetup(profileId);
    res.json(await setupService.getStatus(profileId));
  })
);
