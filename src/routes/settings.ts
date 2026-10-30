import { randomBytes } from "crypto";
import { Request, Router } from "express";
import { ServiceCategory, PaymentTiming } from "../generated/tenant-client";
import { encrypt, decrypt } from "../lib/crypto";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { buildGhlAuthUrl, exchangeGhlCode } from "../integrations/ghl/oauth";
import { getGhlToken } from "../integrations/ghl/api";
import {
  fetchGhlLocation,
  ghlApiRedirectUri,
  ghlWebhookUrl,
  frontendBaseUrl,
  isAllowedWebRedirect,
} from "../integrations/ghl/connection";
import { buildStripeAuthUrl, exchangeStripeCode } from "../integrations/stripe/oauth";
import { signOAuthState, verifyOAuthState } from "../lib/oauth-state";
import { toBusinessSettingsDto } from "../lib/settings-dto";
import {
  optReminderMode,
  optReminderTime,
  optCleanMethod,
  optPaymentMethod,
  optNoDirectDebitAction,
  optVatRate,
  optInvoiceDueDays,
  reminderModeFromLegacy,
  foldServiceAreaIds,
} from "../lib/settings-validators";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { invalidateCachedBusinessSettings } from "../services/settings.service";
import { validateWorkingDays, assertPositiveInt, assertNonNegative, requireMessageChannel, optMessageChannel, optTechnicianRole, isValidEmail, MAX_NAME_LENGTH, MAX_ADDRESS_LENGTH } from "../lib/validation";
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

// ---- content negotiation for the connect flows ----------------------------
// The web calls authorize/callback with fetch + bearer and Accept: application/json.
// A top-level browser navigation (Accept: text/html) keeps the old redirect
// behaviour for one release.
const wantsJson = (req: Request) => (req.get("accept") ?? "").includes("application/json");
const isBrowserNavigation = (req: Request) =>
  !wantsJson(req) && (req.get("accept") ?? "").includes("text/html");

// GET /settings/ghl/callback — PUBLIC (registered before requireAuth). GHL
// redirects the admin's browser here with no bearer token, so the tenant and
// the redirect URI the code was issued for come from the signed, 10-minute
// `state` minted by GET /settings/ghl/authorize. With Accept: application/json
// (a web callback page relaying ?code&state) it answers 200 JSON / 4xx JSON;
// otherwise it redirects to /settings/integrations?ghl=connected|error.
settingsRouter.get(
  "/ghl/callback",
  h(async (req, res) => {
    const fail = (status: number, message: string, code?: string) => {
      if (wantsJson(req)) throw new AppError(status, message, code);
      const qs = new URLSearchParams({ ghl: "error", message });
      res.redirect(`${frontendBaseUrl()}/settings/integrations?${qs}`);
    };

    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) return fail(400, `GHL authorisation denied: ${error}`);
    if (!code || !state) return fail(400, "Missing code or state from GHL");

    const verified = verifyOAuthState(state);
    if (!verified.ok) {
      return fail(
        400,
        verified.reason === "expired"
          ? "This GHL connection link has expired. Start again from Settings."
          : "Invalid GHL connection state. Start again from Settings.",
        "INVALID_STATE"
      );
    }
    const { tenantId, redirectUri } = verified.payload;

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { schemaName: true } });
    if (!tenant) return fail(404, "Tenant not found");
    const tp = getTenantPrismaForSchema(tenant.schemaName);

    let tokens;
    try {
      tokens = await exchangeGhlCode(code, redirectUri);
    } catch (err) {
      console.error("[settings/ghl/callback] token exchange failed:", err);
      return fail(502, "GoHighLevel rejected the authorisation code. Try connecting again.", "GHL_SEND_FAILED");
    }

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const webhookSecret = randomBytes(32).toString("hex");
    await tp.businessSettings.updateMany({
      data: {
        ghlConnected:                true,
        ghlLocationId:               tokens.locationId,
        ghlAccessTokenEncrypted:     encrypt(tokens.access_token),
        ghlRefreshTokenEncrypted:    encrypt(tokens.refresh_token),
        ghlTokenExpiresAt:           expiresAt,
        ghlWebhookSecretEncrypted:   encrypt(webhookSecret),
      },
    });
    invalidateCachedBusinessSettings(tp);

    // Stamp on global Tenant for fast webhook lookup by locationId
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { ghlLocationId: tokens.locationId },
    });

    const webhookUrl = ghlWebhookUrl(tenantId, webhookSecret);
    if (wantsJson(req)) {
      return res.json({ status: "connected", method: "oauth", locationId: tokens.locationId, webhookUrl });
    }
    res.redirect(`${frontendBaseUrl()}/settings/integrations?ghl=connected&webhookUrl=${encodeURIComponent(webhookUrl)}`);
  })
);

settingsRouter.use(requireAuth);
settingsRouter.use(requireTenantAccess);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
settingsRouter.use(requireBusinessAccess());

const svc = (req: Request) => createSettingsService(req.tenantPrisma!, req.tenantSchemaName!);

// ---- helpers -------------------------------------------------------------
// Settings routes are thin: validate → call service → respond. No DB access
// here. GET endpoints are always open (so the Setup Wizard can read back saved
// values); every mutating handler (PATCH, POST, DELETE) first calls
// `assertSetupComplete`, which 403s until setup is complete. (This is the
// inverse of the wizard's `assertSetupIncomplete`.) Exception: the GHL /
// Stripe / GoCardless connect, disconnect, status and webhook-secret routes,
// which the wizard uses before setup completes (A5/A6).
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
    res.json(toBusinessSettingsDto(await svc(req).getSettings()));
  })
);
settingsRouter.patch(
  "/business-profile",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input: BusinessProfileUpdateInput = {
      businessName: optString(body.businessName, "businessName", { maxLength: MAX_NAME_LENGTH }),
      phone: optString(body.phone, "phone"),
      email: optString(body.email, "email"),
      companyNumber: optString(body.companyNumber, "companyNumber"),
      vatRegistered: optBool(body.vatRegistered, "vatRegistered"),
      vatRegistration: optString(body.vatRegistration, "vatRegistration"),
      timezone: optString(body.timezone, "timezone"),
      currency: optString(body.currency, "currency"),
      defaultWorkingDays: optWorkingDays(body.defaultWorkingDays, "defaultWorkingDays"),
      bankDetails: parseBankDetails(body.bankDetails),
      addressLine1: optString(body.addressLine1, "addressLine1", { maxLength: MAX_ADDRESS_LENGTH }),
      addressLine2: optString(body.addressLine2, "addressLine2", { maxLength: MAX_ADDRESS_LENGTH }),
      town: optString(body.town, "town", { maxLength: MAX_ADDRESS_LENGTH }),
      postcode: optString(body.postcode, "postcode", { maxLength: MAX_ADDRESS_LENGTH }),
      vatRate: optVatRate(body.vatRate),
    };
    res.json(toBusinessSettingsDto(await svc(req).updateBusinessProfile(input)));
  })
);

// ==========================================================================
// Section 2 — Round Settings
// ==========================================================================

settingsRouter.get(
  "/round-settings",
  h(async (req, res) => {
    res.json(toBusinessSettingsDto(await svc(req).getSettings()));
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
      reminderMode: optReminderMode(body.reminderMode),
      reminderTime: optReminderTime(body.reminderTime),
      defaultCleanMethod: optCleanMethod(body.defaultCleanMethod),
      autoCreateNextVisit: optBool(body.autoCreateNextVisit, "autoCreateNextVisit"),
      // Deprecated (B2): still accepted from old clients and mapped onto
      // reminderMode when reminderMode itself wasn't sent.
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
    if (input.preCleanReminderTimings && input.reminderMode === undefined) {
      input.reminderMode = reminderModeFromLegacy(input.preCleanReminderTimings);
    }
    res.json(toBusinessSettingsDto(await svc(req).updateRoundSettings(input)));
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
      name: requireString(body.name, "name", { maxLength: MAX_NAME_LENGTH }),
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
      name: optReqString(body.name, "name", { maxLength: MAX_NAME_LENGTH }),
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
      name: optString(body.name, "name", { maxLength: MAX_NAME_LENGTH }),
      phone: optString(body.phone, "phone"),
      role: optTechnicianRole(body.role),
      active: optBool(body.active, "active"),
      serviceAreaIds: foldServiceAreaIds(body),
    };
    const emailRaw = optString(body.email, "email");
    if (emailRaw !== undefined && emailRaw !== null) {
      const normalised = emailRaw.toLowerCase().trim();
      if (!isValidEmail(normalised)) throw new AppError(400, "Invalid email address");
      input.email = normalised;
    } else {
      input.email = emailRaw;
    }
    res.status(201).json(await svc(req).createTechnician(input));
  })
);
settingsRouter.patch(
  "/technicians/:id",
  h(async (req, res) => {
    await svc(req).assertSetupComplete();
    const body = asObject(req.body);
    const input: TechnicianUpdateInput = {
      name: optString(body.name, "name", { maxLength: MAX_NAME_LENGTH }),
      phone: optString(body.phone, "phone"),
      role: optTechnicianRole(body.role),
      active: optBool(body.active, "active"),
      serviceAreaIds: foldServiceAreaIds(body),
    };
    // Email validated separately to normalise case (mirrors PATCH /technicians/:id)
    const emailRaw = optString(body.email, "email");
    if (emailRaw !== undefined && emailRaw !== null) {
      const normalised = emailRaw.toLowerCase().trim();
      if (!isValidEmail(normalised)) throw new AppError(400, "Invalid email address");
      input.email = normalised;
    } else {
      input.email = emailRaw; // undefined or null — pass through
    }
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
    res.json(toBusinessSettingsDto(await svc(req).getSettings()));
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
      defaultPaymentMethod: optPaymentMethod(body.defaultPaymentMethod, "defaultPaymentMethod"),
      invoiceDueDays: optInvoiceDueDays(body.invoiceDueDays),
      noDirectDebitAction: optNoDirectDebitAction(body.noDirectDebitAction),
    };
    res.json(toBusinessSettingsDto(await svc(req).updatePaymentRules(input)));
  })
);
settingsRouter.post(
  "/payment/gocardless/connect",
  // No assertSetupComplete: the wizard connects providers before setup completes (A5/A6).
  h(async (req, res) => {
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
    invalidateCachedBusinessSettings(req.tenantPrisma!);

    const tenantId = req.profile!.tenantId;
    const webhookUrl = `${process.env.PUBLIC_API_URL}/webhooks/gocardless?tenantId=${tenantId}&secret=${webhookSecret}`;
    res.json({ status: "connected", webhookUrl });
  })
);

settingsRouter.post(
  "/payment/gocardless/disconnect",
  // No assertSetupComplete: the wizard connects providers before setup completes (A5/A6).
  h(async (req, res) => {
    await req.tenantPrisma!.businessSettings.updateMany({
      data: {
        gocardlessConnected: false,
        gocardlessAccessTokenEncrypted: null,
        gocardlessWebhookSecretEncrypted: null,
        gocardlessWebhookSigningSecretEncrypted: null,
        gocardlessEnvironment: null,
      },
    });
    invalidateCachedBusinessSettings(req.tenantPrisma!);
    res.json({ status: "disconnected" });
  })
);

// PATCH /settings/payment/gocardless/webhook-secret — GoCardless has no API to
// create webhook endpoints (dashboard-only), so the admin must manually add one
// pointing at the URL returned by /payment/gocardless/connect, then paste the
// *real* signing secret GoCardless shows them here. That secret — not a value
// RoundFlow invents — is what verifies incoming webhook signatures.
settingsRouter.patch(
  "/payment/gocardless/webhook-secret",
  // No assertSetupComplete: the wizard connects providers before setup completes (A5/A6).
  h(async (req, res) => {
    const body = asObject(req.body);
    const secret = requireString(body.secret, "secret");

    const bs = await req.tenantPrisma!.businessSettings.findFirst({
      select: { gocardlessConnected: true },
    });
    if (!bs?.gocardlessConnected) {
      throw new AppError(409, "GoCardless is not connected for this account");
    }

    await req.tenantPrisma!.businessSettings.updateMany({
      data: { gocardlessWebhookSigningSecretEncrypted: encrypt(secret) },
    });
    invalidateCachedBusinessSettings(req.tenantPrisma!);
    res.json({ status: "saved" });
  })
);

// GET /settings/stripe/authorize — the Stripe Connect consent URL as JSON
// { url } (the web now builds this URL itself; kept for API clients). A
// top-level browser navigation still gets the old 302 for one release.
settingsRouter.get(
  "/stripe/authorize",
  h(async (req, res) => {
    const state = `${req.profile!.tenantId}:${randomBytes(8).toString("hex")}`;
    const url = buildStripeAuthUrl(state);
    if (isBrowserNavigation(req)) return res.redirect(url);
    res.json({ url });
  })
);

// GET /settings/stripe/callback — Stripe redirects here after the admin authorises.
// Unlike GoCardless, there is nothing further to configure: webhook delivery for
// Stripe runs through one platform-level Connect webhook (see
// docs/handoff/backend) set up once, not per tenant, so no webhook URL/secret
// needs to be generated or handed back to the frontend here.
settingsRouter.get(
  "/stripe/callback",
  h(async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;
    if (error) throw new AppError(400, `Stripe authorisation denied: ${error}`);
    if (!code || !state) throw new AppError(400, "Missing code or state from Stripe");

    const tokens = await exchangeStripeCode(code);
    const tenantId = req.profile!.tenantId;

    await req.tenantPrisma!.businessSettings.updateMany({
      data: {
        stripeConnected:          true,
        stripeConnectAccountId:   tokens.stripe_user_id,
        stripePublishableKey:     tokens.stripe_publishable_key,
        stripeSecretKeyEncrypted: encrypt(tokens.access_token),
      },
    });
    // Mirrored onto the public Tenant row so the platform-level Connect
    // webhook can resolve `event.account` -> tenant without first knowing
    // which tenant schema to look in.
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { stripeConnectAccountId: tokens.stripe_user_id },
    });
    invalidateCachedBusinessSettings(req.tenantPrisma!);

    // The web's callback page calls this with fetch + bearer + Accept: application/json.
    if (wantsJson(req)) {
      return res.json({ status: "connected", stripeConnectAccountId: tokens.stripe_user_id });
    }
    res.redirect(`${frontendBaseUrl()}/settings/integrations?stripe=connected`);
  })
);

settingsRouter.post(
  "/stripe/disconnect",
  // No assertSetupComplete: the wizard connects providers before setup completes (A5/A6).
  h(async (req, res) => {
    const tenantId = req.profile!.tenantId;
    await req.tenantPrisma!.businessSettings.updateMany({
      data: {
        stripeConnected:          false,
        stripeConnectAccountId:   null,
        stripePublishableKey:     null,
        stripeSecretKeyEncrypted: null,
      },
    });
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { stripeConnectAccountId: null },
    });
    invalidateCachedBusinessSettings(req.tenantPrisma!);
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

// GET /settings/ghl/authorize → 200 { url }. The url carries a signed,
// 10-minute `state` naming this tenant and the redirect URI, which the public
// callback verifies. Optional ?redirectUri= lets the web use its own callback
// page instead of the API one; it must be on a FRONTEND_URL origin. A
// top-level browser navigation still gets the old 302 for one release.
settingsRouter.get(
  "/ghl/authorize",
  h(async (req, res) => {
    const requested = typeof req.query.redirectUri === "string" ? req.query.redirectUri : undefined;
    if (requested !== undefined && !isAllowedWebRedirect(requested)) {
      throw new AppError(400, "redirectUri must be on the web app's origin");
    }
    const redirectUri = requested ?? ghlApiRedirectUri();
    const state = signOAuthState({ tenantId: req.profile!.tenantId, redirectUri });
    const url = buildGhlAuthUrl(redirectUri, state);
    if (isBrowserNavigation(req)) return res.redirect(url);
    res.json({ url });
  })
);

// GET /settings/ghl/status — connection card for Settings and the wizard.
settingsRouter.get(
  "/ghl/status",
  h(async (req, res) => {
    const tp = req.tenantPrisma!;
    const bs = await tp.businessSettings.findFirst({
      select: {
        ghlConnected: true,
        ghlLocationId: true,
        ghlRefreshTokenEncrypted: true,
        ghlWebhookSecretEncrypted: true,
      },
    });
    if (!bs?.ghlConnected) {
      return res.json({ connected: false, method: null, locationId: null, locationName: null, webhookUrl: null, connectedAt: null });
    }
    res.json({
      connected: true,
      // Private integrations store no refresh token (location API keys don't expire).
      method: bs.ghlRefreshTokenEncrypted ? "oauth" : "private",
      locationId: bs.ghlLocationId,
      locationName: await ghlLocationName(tp),
      webhookUrl: bs.ghlWebhookSecretEncrypted
        ? ghlWebhookUrl(req.profile!.tenantId, decrypt(bs.ghlWebhookSecretEncrypted))
        : null,
      // Not stored yet (needs a BusinessSettings.ghlConnectedAt column).
      connectedAt: null,
    });
  })
);

// Best-effort location name for the status card: null when GHL can't be reached.
async function ghlLocationName(tp: TenantPrismaClient): Promise<string | null> {
  const ctx = await getGhlToken(tp);
  if (!ctx) return null;
  const result = await fetchGhlLocation(ctx.accessToken, ctx.locationId);
  return result.ok ? result.locationName : null;
}

// POST /settings/ghl/test — calls GHL /locations/:id with the stored token.
// 200 { ok: true, locationName } · 409 GHL_NOT_CONNECTED · 502 GHL_SEND_FAILED
settingsRouter.post(
  "/ghl/test",
  h(async (req, res) => {
    const ctx = await getGhlToken(req.tenantPrisma!);
    if (!ctx) throw new AppError(409, "GoHighLevel is not connected", "GHL_NOT_CONNECTED");
    const result = await fetchGhlLocation(ctx.accessToken, ctx.locationId);
    if (!result.ok) throw new AppError(502, `GoHighLevel test failed: ${result.message}`, "GHL_SEND_FAILED");
    res.json({ ok: true, locationName: result.locationName });
  })
);

// POST /settings/ghl/connect-private — connect a specific GHL sub-account using a
// Location API key (private integration, no OAuth flow). The key is found under
// sub-account Settings → Integrations → API Keys. Unlike OAuth tokens these never
// expire, so no refresh token or expiry is stored. The key is validated against the
// GHL locations API before being saved.
settingsRouter.post(
  "/ghl/connect-private",
  // No assertSetupComplete: the wizard connects providers before setup completes (A5/A6).
  h(async (req, res) => {
    const body       = asObject(req.body);
    const apiKey     = requireString(body.apiKey,     "apiKey");
    const locationId = requireString(body.locationId, "locationId");

    // Validate key + locationId by fetching the location from GHL
    const verify = await fetchGhlLocation(apiKey, locationId);
    if (!verify.ok) {
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
    invalidateCachedBusinessSettings(req.tenantPrisma!);

    // Stamp on global Tenant for fast webhook lookup by locationId
    await prisma.tenant.update({
      where: { id: req.profile!.tenantId },
      data:  { ghlLocationId: locationId },
    });

    const webhookUrl = ghlWebhookUrl(req.profile!.tenantId, webhookSecret);
    res.json({ status: "connected", method: "private", webhookUrl });
  })
);

// POST /settings/ghl/disconnect
settingsRouter.post(
  "/ghl/disconnect",
  // No assertSetupComplete: the wizard connects providers before setup completes (A5/A6).
  h(async (req, res) => {
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
    invalidateCachedBusinessSettings(req.tenantPrisma!);
    // D-8: the webhook resolves tenants by Tenant.ghlLocationId — clear it too.
    await prisma.tenant.update({
      where: { id: req.profile!.tenantId },
      data: { ghlLocationId: null },
    });
    res.json({ status: "disconnected" });
  })
);
