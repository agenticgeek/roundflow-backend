import { randomBytes } from "crypto";
import { Request, Router } from "express";
import { ServiceCategory, PaymentTiming } from "../generated/tenant-client";
import { encrypt } from "../lib/crypto";
import { prisma } from "../lib/prisma";
import { buildGhlAuthUrl, exchangeGhlCode } from "../integrations/ghl/oauth";
import { buildStripeAuthUrl, exchangeStripeCode } from "../integrations/stripe/oauth";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { validateWorkingDays, assertPositiveInt, assertNonNegative, requireMessageChannel, optMessageChannel } from "../lib/validation";
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
  BankDetails,
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
// domain-specific validators — live here.

function parseBankDetails(v: unknown): BankDetails | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new AppError(400, '"bankDetails" must be an object or null');
  }
  const b = v as Record<string, unknown>;
  const accountName = requireString(b.accountName, "bankDetails.accountName").trim();
  if (!accountName) throw new AppError(400, '"bankDetails.accountName" must not be blank');
  const accountNumber = requireString(b.accountNumber, "bankDetails.accountNumber").trim();
  if (!accountNumber) throw new AppError(400, '"bankDetails.accountNumber" must not be blank');
  const sortCode = requireString(b.sortCode, "bankDetails.sortCode").trim();
  if (!sortCode) throw new AppError(400, '"bankDetails.sortCode" must not be blank');
  const bankName = optString(b.bankName, "bankDetails.bankName") ?? null;
  return { accountName, bankName, accountNumber, sortCode };
}

// Working-days array: omitted = untouched; otherwise every element must be a
// valid DayOfWeek (shared validator).
function optWorkingDays(v: unknown, field: string): string[] | undefined {
  const arr = optStringArray(v, field);
  return arr === undefined ? undefined : validateWorkingDays(arr);
}
// Cycle length: omitted = untouched; null clears; a number must be a positive integer.
function optCycleLength(v: unknown): number | null | undefined {
  const n = optNumber(v, "defaultCycleLength");
  if (typeof n === "number") {
    assertPositiveInt(n, "defaultCycleLength");
    if (n > 365) throw new AppError(400, "defaultCycleLength must be at most 365");
  }
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
    res.json(await svc(req).getSettings());
  })
);
settingsRouter.patch(
  "/business-profile",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
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
      bankDetails: parseBankDetails(body.bankDetails),
    };
    res.json(await svc(req).updateBusinessProfile(input));
  })
);

// ==========================================================================
// Section 2 — Round Settings
// ==========================================================================

settingsRouter.get(
  "/round-settings",
  h(async (req, res) => {
    res.json(await svc(req).getSettings());
  })
);
settingsRouter.patch(
  "/round-settings",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input: RoundSettingsUpdateInput = {
      defaultCycleLength: optCycleLength(body.defaultCycleLength),
      defaultWorkingDays: optWorkingDays(body.defaultWorkingDays, "defaultWorkingDays"),
      preCleanReminderTimings: (() => {
        const arr = optStringArray(body.preCleanReminderTimings, "preCleanReminderTimings");
        if (!arr) return arr;
        if (arr.length > 2) throw new AppError(400, "preCleanReminderTimings must have at most 2 items");
        const valid = ["EVENING_BEFORE", "TWO_HOURS_BEFORE"];
        const bad = arr.find((v) => !valid.includes(v));
        if (bad) throw new AppError(400, `preCleanReminderTimings contains invalid value: "${bad}". Must be one of: ${valid.join(", ")}`);
        return arr;
      })(),
    };
    res.json(await svc(req).updateRoundSettings(input));
  })
);

// ==========================================================================
// Section 3 — Service Catalogue
// ==========================================================================

settingsRouter.get(
  "/services",
  h(async (req, res) => {
    res.json(await svc(req).getServices());
  })
);
settingsRouter.post(
  "/services",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input: ServiceCreateInput = {
      name: requireString(body.name, "name"),
      defaultPrice: assertNonNegative(requireNumber(body.defaultPrice, "defaultPrice"), "defaultPrice", 9999.99),
      category: optCategory(body.category),
      description: optString(body.description, "description"),
      active: optBool(body.active, "active"),
    };
    res.status(201).json(await svc(req).createService(input));
  })
);
settingsRouter.patch(
  "/services/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
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
    res.json(await svc(req).updateService(req.params.id, input));
  })
);
settingsRouter.delete(
  "/services/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    await svc(req).deleteService(req.params.id);
    res.status(204).end();
  })
);

// ==========================================================================
// Section 4 — Service Areas
// ==========================================================================

settingsRouter.get(
  "/service-areas",
  h(async (req, res) => {
    res.json(await svc(req).getServiceAreas());
  })
);
settingsRouter.post(
  "/service-areas",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input: ServiceAreaCreateInput = {
      name: requireString(body.name, "name"),
      postcodeSector: optString(body.postcodeSector, "postcodeSector"),
      isDefault: optBool(body.isDefault, "isDefault"),
    };
    res.status(201).json(await svc(req).createServiceArea(input));
  })
);
settingsRouter.patch(
  "/service-areas/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input: ServiceAreaUpdateInput = {
      name: optReqString(body.name, "name"),
      postcodeSector: optString(body.postcodeSector, "postcodeSector"),
      isDefault: optBool(body.isDefault, "isDefault"),
    };
    res.json(await svc(req).updateServiceArea(req.params.id, input));
  })
);
settingsRouter.delete(
  "/service-areas/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    await svc(req).deleteServiceArea(req.params.id);
    res.status(204).end();
  })
);

// ==========================================================================
// Section 5 — Technician Management
// ==========================================================================

settingsRouter.get(
  "/technicians",
  h(async (req, res) => {
    res.json(await svc(req).getTechnicians());
  })
);
settingsRouter.post(
  "/technicians",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input: TechnicianCreateInput = {
      name: optString(body.name, "name"),
      phone: optString(body.phone, "phone"),
      role: optString(body.role, "role"),
      active: optBool(body.active, "active"),
    };
    res.status(201).json(await svc(req).createTechnician(input));
  })
);
settingsRouter.patch(
  "/technicians/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input: TechnicianUpdateInput = {
      name: optString(body.name, "name"),
      phone: optString(body.phone, "phone"),
      role: optString(body.role, "role"),
      active: optBool(body.active, "active"),
    };
    res.json(await svc(req).updateTechnician(req.params.id, input));
  })
);
settingsRouter.delete(
  "/technicians/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    await svc(req).deleteTechnician(req.params.id);
    res.status(204).end();
  })
);

// ==========================================================================
// Section 6 — Payment Setup
// ==========================================================================

settingsRouter.get(
  "/payment",
  h(async (req, res) => {
    res.json(await svc(req).getSettings());
  })
);
settingsRouter.patch(
  "/payment",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input: PaymentRulesUpdateInput = {
      paymentRule: optPaymentTiming(body.paymentRule),
      vatInInvoices: optBool(body.vatInInvoices, "vatInInvoices"),
      debtHoldEnabled: optBool(body.debtHoldEnabled, "debtHoldEnabled"),
      debtHoldMaxInvoices: body.debtHoldMaxInvoices !== undefined ? (body.debtHoldMaxInvoices === null ? null : Number(body.debtHoldMaxInvoices)) : undefined,
      debtHoldMaxAmount: body.debtHoldMaxAmount !== undefined ? (body.debtHoldMaxAmount === null ? null : Number(body.debtHoldMaxAmount)) : undefined,
    };
    res.json(await svc(req).updatePaymentRules(input));
  })
);
settingsRouter.post(
  "/payment/gocardless/connect",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const accessToken = requireString(body.accessToken, "accessToken");
    const environment = requireString(body.environment, "environment");

    if (environment !== "sandbox" && environment !== "live") {
      throw new AppError(400, 'environment must be "sandbox" or "live"');
    }

    // Validate token by hitting the GoCardless API
    try {
      const { getGcClient } = await import("../integrations/gocardless/client.js");
      const client = getGcClient(accessToken, environment);
      await client.creditors.list();
    } catch {
      throw new AppError(400, "GoCardless access token is invalid or could not be verified");
    }

    const webhookSecret = randomBytes(32).toString("hex");
    await req.tenantPrisma!.businessSettings.updateMany({
      data: {
        gocardlessConnected: true,
        gocardlessAccessTokenEncrypted: encrypt(accessToken),
        gocardlessWebhookSecretEncrypted: encrypt(webhookSecret),
        gocardlessEnvironment: environment,
      },
    });

    const tenantId = req.profile!.tenantId;
    const webhookUrl = `${process.env.PUBLIC_API_URL}/webhooks/gocardless?tenantId=${tenantId}&secret=${webhookSecret}`;
    res.json({ status: "connected", webhookUrl });
  })
);

settingsRouter.post(
  "/payment/gocardless/disconnect",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    await req.tenantPrisma!.businessSettings.updateMany({
      data: {
        gocardlessConnected: false,
        gocardlessAccessTokenEncrypted: null,
        gocardlessWebhookSecretEncrypted: null,
        gocardlessEnvironment: null,
      },
    });
    res.json({ status: "disconnected" });
  })
);

// GET /settings/stripe/authorize — redirect the admin to Stripe Connect consent page
settingsRouter.get(
  "/stripe/authorize",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const state = `${req.profile!.tenantId}:${randomBytes(8).toString("hex")}`;
    res.redirect(buildStripeAuthUrl(state));
  })
);

// GET /settings/stripe/callback — Stripe redirects here after the admin authorises
settingsRouter.get(
  "/stripe/callback",
  h(async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;
    if (error) throw new AppError(400, `Stripe authorisation denied: ${error}`);
    if (!code || !state) throw new AppError(400, "Missing code or state from Stripe");

    const tokens = await exchangeStripeCode(code);

    const webhookSecret = randomBytes(32).toString("hex");
    await req.tenantPrisma!.businessSettings.updateMany({
      data: {
        stripeConnected:             true,
        stripeConnectAccountId:      tokens.stripe_user_id,
        stripePublishableKey:        tokens.stripe_publishable_key,
        stripeSecretKeyEncrypted:    encrypt(tokens.access_token),
        stripeWebhookSecretEncrypted: encrypt(webhookSecret),
      },
    });

    const tenantId = req.profile!.tenantId;
    const webhookUrl = `${process.env.PUBLIC_API_URL}/webhooks/stripe?tenantId=${tenantId}&secret=${webhookSecret}`;
    const frontendUrl = process.env.FRONTEND_URL!;
    res.redirect(`${frontendUrl}/settings/integrations?stripe=connected&webhookUrl=${encodeURIComponent(webhookUrl)}`);
  })
);

settingsRouter.post(
  "/stripe/disconnect",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    await req.tenantPrisma!.businessSettings.updateMany({
      data: {
        stripeConnected:             false,
        stripeConnectAccountId:      null,
        stripePublishableKey:        null,
        stripeSecretKeyEncrypted:    null,
        stripeWebhookSecretEncrypted: null,
      },
    });
    res.json({ status: "disconnected" });
  })
);

// ==========================================================================
// Section 7 — Message Templates (SMS / WhatsApp / Email via GHL)
// ==========================================================================

settingsRouter.get(
  "/message-templates",
  h(async (req, res) => {
    res.json(await svc(req).getMessageTemplates());
  })
);

settingsRouter.post(
  "/message-templates",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input = {
      name: requireString(body.name, "name"),
      channel: requireMessageChannel(body.channel),
      body: requireString(body.body, "body"),
      subject: optString(body.subject, "subject"),
    };
    res.status(201).json(await svc(req).createMessageTemplate(input));
  })
);

settingsRouter.patch(
  "/message-templates/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input = {
      name: optReqString(body.name, "name"),
      channel: optMessageChannel(body.channel),
      body: optReqString(body.body, "body"),
      subject: optString(body.subject, "subject"),
    };
    res.json(await svc(req).updateMessageTemplate(req.params.id, input));
  })
);

settingsRouter.delete(
  "/message-templates/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    await svc(req).deleteMessageTemplate(req.params.id);
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// Section 8 — GHL OAuth
// ---------------------------------------------------------------------------

// GET /settings/ghl/authorize — redirect the admin to GHL's OAuth consent page
settingsRouter.get(
  "/ghl/authorize",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const state = `${req.profile!.tenantId}:${randomBytes(8).toString("hex")}`;
    const redirectUri = `${process.env.PUBLIC_API_URL}/settings/ghl/callback`;
    res.redirect(buildGhlAuthUrl(redirectUri, state));
  })
);

// GET /settings/ghl/callback — GHL redirects here after the admin authorises
settingsRouter.get(
  "/ghl/callback",
  h(async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;
    if (error) throw new AppError(400, `GHL authorisation denied: ${error}`);
    if (!code || !state) throw new AppError(400, "Missing code or state from GHL");

    const redirectUri = `${process.env.PUBLIC_API_URL}/settings/ghl/callback`;
    const tokens = await exchangeGhlCode(code, redirectUri);

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const webhookSecret = randomBytes(32).toString("hex");
    await req.tenantPrisma!.businessSettings.updateMany({
      data: {
        ghlConnected:                true,
        ghlLocationId:               tokens.locationId,
        ghlAccessTokenEncrypted:     encrypt(tokens.access_token),
        ghlRefreshTokenEncrypted:    encrypt(tokens.refresh_token),
        ghlTokenExpiresAt:           expiresAt,
        ghlWebhookSecretEncrypted:   encrypt(webhookSecret),
      },
    });

    // Stamp on global Tenant for fast webhook lookup by locationId
    await prisma.tenant.update({
      where: { id: req.profile!.tenantId },
      data: { ghlLocationId: tokens.locationId },
    });

    const tenantId = req.profile!.tenantId;
    const webhookUrl = `${process.env.PUBLIC_API_URL}/webhooks/ghl?tenantId=${tenantId}&secret=${webhookSecret}`;
    const frontendUrl = process.env.FRONTEND_URL!;
    res.redirect(`${frontendUrl}/settings/integrations?ghl=connected&webhookUrl=${encodeURIComponent(webhookUrl)}`);
  })
);

// POST /settings/ghl/connect-private — connect a specific GHL sub-account using a
// Location API key (private integration, no OAuth flow). The key is found under
// sub-account Settings → Integrations → API Keys. Unlike OAuth tokens these never
// expire, so no refresh token or expiry is stored. The key is validated against the
// GHL locations API before being saved.
settingsRouter.post(
  "/ghl/connect-private",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body       = asObject(req.body);
    const apiKey     = requireString(body.apiKey,     "apiKey");
    const locationId = requireString(body.locationId, "locationId");

    // Validate key + locationId by fetching the location from GHL
    const verifyRes = await fetch(
      `https://services.leadconnectorhq.com/locations/${locationId}`,
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Version":       "2021-07-28",
        },
      }
    );
    if (!verifyRes.ok) {
      throw new AppError(400, "GHL API key or location ID is invalid");
    }

    const webhookSecret = randomBytes(32).toString("hex");
    await req.tenantPrisma!.businessSettings.updateMany({
      data: {
        ghlConnected:              true,
        ghlLocationId:             locationId,
        ghlAccessTokenEncrypted:   encrypt(apiKey),
        ghlRefreshTokenEncrypted:  null,
        ghlTokenExpiresAt:         null,
        ghlWebhookSecretEncrypted: encrypt(webhookSecret),
      },
    });

    // Stamp on global Tenant for fast webhook lookup by locationId
    await prisma.tenant.update({
      where: { id: req.profile!.tenantId },
      data:  { ghlLocationId: locationId },
    });

    const tenantId = req.profile!.tenantId;
    const webhookUrl = `${process.env.PUBLIC_API_URL}/webhooks/ghl?tenantId=${tenantId}&secret=${webhookSecret}`;
    res.json({ status: "connected", method: "private", webhookUrl });
  })
);

// POST /settings/ghl/disconnect
settingsRouter.post(
  "/ghl/disconnect",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    await req.tenantPrisma!.businessSettings.updateMany({
      data: {
        ghlConnected:              false,
        ghlLocationId:             null,
        ghlAccessTokenEncrypted:   null,
        ghlRefreshTokenEncrypted:  null,
        ghlTokenExpiresAt:         null,
        ghlWebhookSecretEncrypted: null,
      },
    });
    res.json({ status: "disconnected" });
  })
);
