import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// requireAuth is mocked to 401 unless x-test-auth is set, so the tests can
// prove /settings/ghl/callback is public and everything else is not.
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, res: any, next: any) =>
    req.headers["x-test-auth"] ? next() : res.status(401).json({ error: "Unauthorized" }),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { tenantId: "tenant-1", role: "ADMIN" };
    next();
  },
}));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  requireBusinessAccess: () => (_q: any, _s: any, n: any) => n(),
}));

const secretRow = {
  businessName: "Coates",
  vatRate: "20.00",
  ghlAccessTokenEncrypted: "secret-1",
  ghlWebhookSecretEncrypted: "secret-2",
  stripeSecretKeyEncrypted: "secret-3",
};
const settingsSvc = {
  assertSetupComplete: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockResolvedValue(secretRow),
  updateBusinessProfile: vi.fn().mockResolvedValue(secretRow),
  updateRoundSettings: vi.fn().mockResolvedValue(secretRow),
  updatePaymentRules: vi.fn().mockResolvedValue(secretRow),
  createTechnician: vi.fn().mockResolvedValue({ id: "t1" }),
  updateTechnician: vi.fn().mockResolvedValue({ id: "t1" }),
};
const invalidateCachedBusinessSettings = vi.fn();
vi.mock("../../services/settings.service", () => ({
  createSettingsService: vi.fn(() => settingsSvc),
  invalidateCachedBusinessSettings: (...a: unknown[]) => invalidateCachedBusinessSettings(...a),
}));

const buildGhlAuthUrl = vi.fn((redirectUri: string, state: string) => `https://ghl.test/oauth?redirect_uri=${redirectUri}&state=${state}`);
const exchangeGhlCode = vi.fn();
vi.mock("../../integrations/ghl/oauth", () => ({
  buildGhlAuthUrl: (...a: [string, string]) => buildGhlAuthUrl(...a),
  exchangeGhlCode: (...a: unknown[]) => exchangeGhlCode(...a),
}));
const getGhlToken = vi.fn();
vi.mock("../../integrations/ghl/api", () => ({ getGhlToken: (...a: unknown[]) => getGhlToken(...a) }));
const fetchGhlLocation = vi.fn();
vi.mock("../../integrations/ghl/connection", async (orig) => ({
  ...(await orig<typeof import("../../integrations/ghl/connection")>()),
  fetchGhlLocation: (...a: unknown[]) => fetchGhlLocation(...a),
}));

const tenantFindUnique = vi.fn();
const tenantUpdate = vi.fn().mockResolvedValue({});
vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a), update: (...a: unknown[]) => tenantUpdate(...a) } },
}));
const callbackTp = { businessSettings: { updateMany: vi.fn().mockResolvedValue({}) } };
const getTenantPrismaForSchema = vi.fn(() => callbackTp);
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...a: unknown[]) => getTenantPrismaForSchema(...(a as [])),
}));

import { settingsRouter } from "../settings";
import { signOAuthState, verifyOAuthState } from "../../lib/oauth-state";
import { encrypt } from "../../lib/crypto";

function makeTp() {
  return { businessSettings: { findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({}) } };
}
function makeApp(tp: ReturnType<typeof makeTp> = makeTp()) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = tp;
    next();
  });
  app.use("/settings", settingsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  });
  return app;
}
const authed = (r: request.Test) => r.set("x-test-auth", "1");
const json = (r: request.Test) => r.set("Accept", "application/json");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_API_URL = "https://api.test";
  process.env.FRONTEND_URL = "https://app.test";
  settingsSvc.assertSetupComplete.mockRejectedValue(Object.assign(new Error("setup incomplete"), { statusCode: 403 }));
});

const expectNoSecrets = (body: Record<string, unknown>) => {
  expect(JSON.stringify(body)).not.toMatch(/Encrypted|secret-/);
  expect(body.vatRate).toBe(20);
};

describe("BusinessSettings DTO + new fields", () => {
  it("GET /business-profile, /round-settings and /payment strip *Encrypted fields (D-1)", async () => {
    for (const path of ["business-profile", "round-settings", "payment"]) {
      const res = await authed(request(makeApp()).get(`/settings/${path}`));
      expect(res.status).toBe(200);
      expectNoSecrets(res.body);
    }
  });

  it("PATCH /business-profile accepts address + vatRate (B1)", async () => {
    settingsSvc.assertSetupComplete.mockResolvedValue(undefined);
    const res = await authed(request(makeApp()).patch("/settings/business-profile")).send({
      addressLine1: "1 Audit St", addressLine2: "Flat 2", town: "Alnwick", postcode: "NE66 1TD", vatRate: 0,
    });
    expect(res.status).toBe(200);
    expectNoSecrets(res.body);
    expect(settingsSvc.updateBusinessProfile).toHaveBeenCalledWith(expect.objectContaining({
      addressLine1: "1 Audit St", addressLine2: "Flat 2", town: "Alnwick", postcode: "NE66 1TD", vatRate: 0,
    }));
    const bad = await authed(request(makeApp()).patch("/settings/business-profile")).send({ vatRate: -5 });
    expect(bad.status).toBe(400);
  });

  it("PATCH /round-settings accepts the B2 fields and maps the deprecated timings only when reminderMode is absent", async () => {
    settingsSvc.assertSetupComplete.mockResolvedValue(undefined);
    const res = await authed(request(makeApp()).patch("/settings/round-settings")).send({
      reminderMode: "MORNING_OF", reminderTime: "07:00", defaultCleanMethod: null, autoCreateNextVisit: false,
      preCleanReminderTimings: ["EVENING_BEFORE"],
    });
    expect(res.status).toBe(200);
    expectNoSecrets(res.body);
    expect(settingsSvc.updateRoundSettings).toHaveBeenCalledWith(expect.objectContaining({
      reminderMode: "MORNING_OF", reminderTime: "07:00", defaultCleanMethod: null, autoCreateNextVisit: false,
    }));

    await authed(request(makeApp()).patch("/settings/round-settings")).send({ preCleanReminderTimings: [] });
    expect(settingsSvc.updateRoundSettings).toHaveBeenLastCalledWith(expect.objectContaining({ reminderMode: "NONE" }));

    const bad = await authed(request(makeApp()).patch("/settings/round-settings")).send({ reminderTime: "25:00" });
    expect(bad.status).toBe(400);
  });

  it("PATCH /payment accepts COLLECT_DAILY_BATCH and the payment defaults (GAP-008)", async () => {
    settingsSvc.assertSetupComplete.mockResolvedValue(undefined);
    const res = await authed(request(makeApp()).patch("/settings/payment")).send({
      paymentRule: "COLLECT_DAILY_BATCH", defaultPaymentMethod: "CASH", invoiceDueDays: 30, noDirectDebitAction: "SEND_INVOICE",
    });
    expect(res.status).toBe(200);
    expectNoSecrets(res.body);
    expect(settingsSvc.updatePaymentRules).toHaveBeenCalledWith(expect.objectContaining({
      paymentRule: "COLLECT_DAILY_BATCH", defaultPaymentMethod: "CASH", invoiceDueDays: 30, noDirectDebitAction: "SEND_INVOICE",
    }));
    const bad = await authed(request(makeApp()).patch("/settings/payment")).send({ noDirectDebitAction: "NOPE" });
    expect(bad.status).toBe(400);
  });

  it("technicians create/update fold a singular serviceAreaId into serviceAreaIds (GAP-004)", async () => {
    settingsSvc.assertSetupComplete.mockResolvedValue(undefined);
    await authed(request(makeApp()).post("/settings/technicians")).send({ name: "Sam", serviceAreaId: "a1" });
    expect(settingsSvc.createTechnician).toHaveBeenCalledWith(expect.objectContaining({ serviceAreaIds: ["a1"] }));
    await authed(request(makeApp()).patch("/settings/technicians/t1")).send({ serviceAreaIds: ["a1"], serviceAreaId: "a2" });
    expect(settingsSvc.updateTechnician).toHaveBeenCalledWith("t1", expect.objectContaining({ serviceAreaIds: ["a1", "a2"] }));
  });
});

describe("GET /settings/ghl/authorize", () => {
  it("returns JSON { url } with a signed state for this tenant, before setup is complete", async () => {
    const res = await json(authed(request(makeApp()).get("/settings/ghl/authorize")));
    expect(res.status).toBe(200);
    const [redirectUri, state] = buildGhlAuthUrl.mock.calls[0];
    expect(redirectUri).toBe("https://api.test/settings/ghl/callback");
    expect(res.body.url).toContain("https://ghl.test/oauth");
    expect(verifyOAuthState(state)).toMatchObject({ ok: true, payload: { tenantId: "tenant-1", redirectUri } });
    expect(settingsSvc.assertSetupComplete).not.toHaveBeenCalled();
  });

  it("accepts a web redirectUri on a FRONTEND_URL origin and rejects any other", async () => {
    const ok = await authed(request(makeApp()).get("/settings/ghl/authorize?redirectUri=https://app.test/settings/ghl/callback"));
    expect(ok.status).toBe(200);
    expect(buildGhlAuthUrl.mock.calls[0][0]).toBe("https://app.test/settings/ghl/callback");
    const bad = await authed(request(makeApp()).get("/settings/ghl/authorize?redirectUri=https://evil.test/cb"));
    expect(bad.status).toBe(400);
  });

  it("still 302s a top-level browser navigation (one release)", async () => {
    const res = await authed(request(makeApp()).get("/settings/ghl/authorize")).set("Accept", "text/html");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://ghl.test/oauth");
  });
});

describe("GET /settings/ghl/callback (public)", () => {
  const tokens = { access_token: "at", refresh_token: "rt", expires_in: 3600, locationId: "loc1", token_type: "Bearer" };
  const goodState = () => signOAuthState({ tenantId: "tenant-1", redirectUri: "https://app.test/settings/ghl/callback" });

  it("connects without a bearer token: verifies state, exchanges with the state's redirectUri, stores tokens, redirects", async () => {
    tenantFindUnique.mockResolvedValue({ schemaName: "t_1" });
    exchangeGhlCode.mockResolvedValue(tokens);
    const res = await request(makeApp()).get(`/settings/ghl/callback?code=c1&state=${goodState()}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/app\.test\/settings\/integrations\?ghl=connected&webhookUrl=/);
    expect(exchangeGhlCode).toHaveBeenCalledWith("c1", "https://app.test/settings/ghl/callback");
    expect(getTenantPrismaForSchema).toHaveBeenCalledWith("t_1");
    expect(callbackTp.businessSettings.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ ghlConnected: true, ghlLocationId: "loc1" }),
    });
    expect(invalidateCachedBusinessSettings).toHaveBeenCalledWith(callbackTp);
    expect(tenantUpdate).toHaveBeenCalledWith({ where: { id: "tenant-1" }, data: { ghlLocationId: "loc1" } });
  });

  it("answers 200 JSON when called with Accept: application/json", async () => {
    tenantFindUnique.mockResolvedValue({ schemaName: "t_1" });
    exchangeGhlCode.mockResolvedValue(tokens);
    const res = await json(request(makeApp()).get(`/settings/ghl/callback?code=c1&state=${goodState()}`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "connected", method: "oauth", locationId: "loc1",
      webhookUrl: expect.stringMatching(/^https:\/\/api\.test\/webhooks\/ghl\?tenantId=tenant-1&secret=[0-9a-f]{64}$/),
    });
  });

  it("redirects with ghl=error for a denied, incomplete or tampered callback (browser)", async () => {
    const denied = await request(makeApp()).get("/settings/ghl/callback?error=access_denied");
    expect(denied.status).toBe(302);
    expect(denied.headers.location).toContain("ghl=error");
    expect(decodeURIComponent(denied.headers.location.replace(/\+/g, " "))).toContain("GHL authorisation denied: access_denied");

    const missing = await request(makeApp()).get("/settings/ghl/callback?code=c1");
    expect(missing.headers.location).toContain("ghl=error");

    const tampered = await request(makeApp()).get("/settings/ghl/callback?code=c1&state=abc.def");
    expect(tampered.headers.location).toContain("ghl=error");
    expect(exchangeGhlCode).not.toHaveBeenCalled();
  });

  it("returns JSON errors: INVALID_STATE (tampered/expired), 404 unknown tenant, 502 failed exchange", async () => {
    const tampered = await json(request(makeApp()).get("/settings/ghl/callback?code=c1&state=abc.def"));
    expect(tampered.status).toBe(400);
    expect(tampered.body).toMatchObject({ code: "INVALID_STATE", error: expect.stringContaining("Invalid") });

    const expired = signOAuthState({ tenantId: "tenant-1", redirectUri: "x" }, Date.now() - 11 * 60 * 1000);
    const exp = await json(request(makeApp()).get(`/settings/ghl/callback?code=c1&state=${expired}`));
    expect(exp.body).toMatchObject({ code: "INVALID_STATE", error: expect.stringContaining("expired") });

    tenantFindUnique.mockResolvedValue(null);
    const noTenant = await json(request(makeApp()).get(`/settings/ghl/callback?code=c1&state=${goodState()}`));
    expect(noTenant.status).toBe(404);

    tenantFindUnique.mockResolvedValue({ schemaName: "t_1" });
    exchangeGhlCode.mockRejectedValue(new Error("invalid_grant"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await json(request(makeApp()).get(`/settings/ghl/callback?code=c1&state=${goodState()}`));
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe("GHL_SEND_FAILED");
    expect(err).toHaveBeenCalled();
    expect(callbackTp.businessSettings.updateMany).not.toHaveBeenCalled();
  });
});

describe("GHL status / test / connect-private / disconnect", () => {
  it("status: not connected", async () => {
    const tp = makeTp();
    tp.businessSettings.findFirst.mockResolvedValue(null);
    const res = await authed(request(makeApp(tp)).get("/settings/ghl/status"));
    expect(res.body).toEqual({ connected: false, method: null, locationId: null, locationName: null, webhookUrl: null, connectedAt: null });
  });

  it("status: OAuth connection with location name and webhook URL", async () => {
    const tp = makeTp();
    tp.businessSettings.findFirst.mockResolvedValue({
      ghlConnected: true, ghlLocationId: "loc1", ghlRefreshTokenEncrypted: "x", ghlWebhookSecretEncrypted: encrypt("whsec"),
    });
    getGhlToken.mockResolvedValue({ accessToken: "at", locationId: "loc1" });
    fetchGhlLocation.mockResolvedValue({ ok: true, locationName: "Coates Windows" });
    const res = await authed(request(makeApp(tp)).get("/settings/ghl/status"));
    expect(res.body).toEqual({
      connected: true, method: "oauth", locationId: "loc1", locationName: "Coates Windows",
      webhookUrl: "https://api.test/webhooks/ghl?tenantId=tenant-1&secret=whsec", connectedAt: null,
    });
  });

  it("status: private connection; location name null when GHL can't be reached or the token is gone", async () => {
    const tp = makeTp();
    tp.businessSettings.findFirst.mockResolvedValue({
      ghlConnected: true, ghlLocationId: "loc1", ghlRefreshTokenEncrypted: null, ghlWebhookSecretEncrypted: null,
    });
    getGhlToken.mockResolvedValue({ accessToken: "at", locationId: "loc1" });
    fetchGhlLocation.mockResolvedValue({ ok: false, status: 401, message: "no" });
    const res = await authed(request(makeApp(tp)).get("/settings/ghl/status"));
    expect(res.body).toMatchObject({ method: "private", locationName: null, webhookUrl: null });

    getGhlToken.mockResolvedValue(null);
    const res2 = await authed(request(makeApp(tp)).get("/settings/ghl/status"));
    expect(res2.body.locationName).toBeNull();
  });

  it("test: 409 when not connected, 502 GHL_SEND_FAILED on a GHL error, 200 with the location name", async () => {
    getGhlToken.mockResolvedValue(null);
    const notConnected = await authed(request(makeApp()).post("/settings/ghl/test"));
    expect(notConnected.status).toBe(409);
    expect(notConnected.body.code).toBe("GHL_NOT_CONNECTED");

    getGhlToken.mockResolvedValue({ accessToken: "at", locationId: "loc1" });
    fetchGhlLocation.mockResolvedValue({ ok: false, status: 401, message: "Invalid JWT" });
    const failed = await authed(request(makeApp()).post("/settings/ghl/test"));
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ code: "GHL_SEND_FAILED", error: "GoHighLevel test failed: Invalid JWT" });

    fetchGhlLocation.mockResolvedValue({ ok: true, locationName: "Coates Windows" });
    const ok = await authed(request(makeApp()).post("/settings/ghl/test"));
    expect(ok.body).toEqual({ ok: true, locationName: "Coates Windows" });
    expect(fetchGhlLocation).toHaveBeenCalledWith("at", "loc1");
  });

  it("connect-private validates the key via GHL and works before setup completes", async () => {
    fetchGhlLocation.mockResolvedValue({ ok: false, status: 401, message: "no" });
    const bad = await authed(request(makeApp()).post("/settings/ghl/connect-private")).send({ apiKey: "pit-1", locationId: "loc1" });
    expect(bad.status).toBe(400);

    fetchGhlLocation.mockResolvedValue({ ok: true, locationName: "X" });
    const tp = makeTp();
    const ok = await authed(request(makeApp(tp)).post("/settings/ghl/connect-private")).send({ apiKey: "pit-1", locationId: "loc1" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "connected", method: "private", webhookUrl: expect.stringContaining("tenantId=tenant-1") });
    expect(tenantUpdate).toHaveBeenCalledWith({ where: { id: "tenant-1" }, data: { ghlLocationId: "loc1" } });
    expect(settingsSvc.assertSetupComplete).not.toHaveBeenCalled();
  });

  it("disconnect clears Tenant.ghlLocationId too (D-8)", async () => {
    const tp = makeTp();
    const res = await authed(request(makeApp(tp)).post("/settings/ghl/disconnect"));
    expect(res.body).toEqual({ status: "disconnected" });
    expect(tp.businessSettings.updateMany).toHaveBeenCalledWith({ data: expect.objectContaining({ ghlConnected: false, ghlLocationId: null }) });
    expect(tenantUpdate).toHaveBeenCalledWith({ where: { id: "tenant-1" }, data: { ghlLocationId: null } });
  });

  it("everything except the callback still needs auth", async () => {
    expect((await request(makeApp()).get("/settings/ghl/status")).status).toBe(401);
  });
});

describe("Stripe / GoCardless routes work before setup completes", () => {
  it("disconnect and webhook-secret don't call assertSetupComplete", async () => {
    const tp = makeTp();
    tp.businessSettings.findFirst.mockResolvedValue({ gocardlessConnected: true });
    expect((await authed(request(makeApp(tp)).post("/settings/stripe/disconnect"))).status).toBe(200);
    expect((await authed(request(makeApp(tp)).post("/settings/payment/gocardless/disconnect"))).status).toBe(200);
    expect((await authed(request(makeApp(tp)).patch("/settings/payment/gocardless/webhook-secret")).send({ secret: "s" })).status).toBe(200);
    expect(settingsSvc.assertSetupComplete).not.toHaveBeenCalled();
  });
});
