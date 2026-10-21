import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (_req: any, _res: any, next: any) => {
    _req.profile = { tenantId: "tenant-1", role: "ADMIN" };
    _req.tenantSchemaName = "tenant_1";
    next();
  },
}));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  requireBusinessAccess: () => (_req: any, _res: any, next: any) => next(),
}));

const assertSetupComplete = vi.fn().mockResolvedValue(undefined);
const updatePaymentRules = vi.fn();
const invalidateCachedBusinessSettings = vi.fn((..._args: unknown[]) => undefined);
vi.mock("../../services/settings.service", () => ({
  createSettingsService: vi.fn(() => ({ assertSetupComplete, updatePaymentRules })),
  invalidateCachedBusinessSettings: (...args: unknown[]) => invalidateCachedBusinessSettings(...args),
}));

const buildStripeAuthUrl = vi.fn((..._args: unknown[]) => "https://connect.stripe.com/oauth/authorize?mock=1");
const exchangeStripeCode = vi.fn((..._args: unknown[]) => Promise.resolve({}));
vi.mock("../../integrations/stripe/oauth", () => ({
  buildStripeAuthUrl: (...args: unknown[]) => buildStripeAuthUrl(...args),
  exchangeStripeCode: (...args: unknown[]) => exchangeStripeCode(...args),
}));

const encrypt = vi.fn((v: string) => `encrypted(${v})`);
vi.mock("../../lib/crypto", () => ({
  encrypt: (...args: [string]) => encrypt(...args),
}));

const tenantUpdate = vi.fn((..._args: unknown[]) => Promise.resolve({}));
vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { update: (...args: unknown[]) => tenantUpdate(...args) } },
}));

const creditorsList = vi.fn((..._args: unknown[]) => Promise.resolve({ creditors: [] }));
const getGcClient = vi.fn((..._args: unknown[]) => ({ creditors: { list: (...args: unknown[]) => creditorsList(...args) } }));
vi.mock("../../integrations/gocardless/client", () => ({
  getGcClient: (...args: unknown[]) => getGcClient(...args),
}));

import { settingsRouter } from "../settings";
import { AppError } from "../../lib/app-error";

function makeTenantPrisma() {
  return {
    businessSettings: { findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({}) },
  };
}

function makeApp(tp: ReturnType<typeof makeTenantPrisma> = makeTenantPrisma()) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = tp;
    next();
  });
  app.use("/settings", settingsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  assertSetupComplete.mockResolvedValue(undefined);
  process.env.PUBLIC_API_URL = "https://api.test.roundflow.example";
});

describe("PATCH /settings/payment", () => {
  it("updates the payment rules with the given fields", async () => {
    updatePaymentRules.mockResolvedValue({ paymentRule: "COLLECT_BEFORE_VISIT" });

    const res = await request(makeApp())
      .patch("/settings/payment")
      .send({ paymentRule: "COLLECT_BEFORE_VISIT", vatInInvoices: true, debtHoldEnabled: true, debtHoldMaxInvoices: 2, debtHoldMaxAmount: 100 });

    expect(res.status).toBe(200);
    expect(updatePaymentRules).toHaveBeenCalledWith({
      paymentRule: "COLLECT_BEFORE_VISIT",
      vatInInvoices: true,
      debtHoldEnabled: true,
      debtHoldMaxInvoices: 2,
      debtHoldMaxAmount: 100,
    });
  });

  it("passes null to clear debtHoldMaxInvoices/debtHoldMaxAmount", async () => {
    updatePaymentRules.mockResolvedValue({});
    const res = await request(makeApp())
      .patch("/settings/payment")
      .send({ debtHoldMaxInvoices: null, debtHoldMaxAmount: null });

    expect(res.status).toBe(200);
    expect(updatePaymentRules).toHaveBeenCalledWith(
      expect.objectContaining({ debtHoldMaxInvoices: null, debtHoldMaxAmount: null })
    );
  });

  it("403s (via assertSetupComplete) before setup is finished", async () => {
    assertSetupComplete.mockRejectedValue(new AppError(403, "Setup is not complete"));
    const res = await request(makeApp()).patch("/settings/payment").send({});
    expect(res.status).toBe(403);
  });
});

describe("POST /settings/payment/gocardless/connect", () => {
  it("400s on an invalid environment", async () => {
    const res = await request(makeApp())
      .post("/settings/payment/gocardless/connect")
      .send({ accessToken: "tok_123", environment: "staging" });
    expect(res.status).toBe(400);
  });

  it("400s when the access token can't be verified against GoCardless", async () => {
    creditorsList.mockRejectedValue(new Error("unauthorized"));
    const res = await request(makeApp())
      .post("/settings/payment/gocardless/connect")
      .send({ accessToken: "tok_bad", environment: "sandbox" });
    expect(res.status).toBe(400);
  });

  it("connects, stores the encrypted token, and returns a webhook url", async () => {
    creditorsList.mockResolvedValue({ creditors: [] });
    const tp = makeTenantPrisma();

    const res = await request(makeApp(tp))
      .post("/settings/payment/gocardless/connect")
      .send({ accessToken: "tok_good", environment: "sandbox" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("connected");
    expect(res.body.webhookUrl).toContain("/webhooks/gocardless?tenantId=tenant-1&secret=");
    expect(tp.businessSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gocardlessConnected: true,
          gocardlessEnvironment: "sandbox",
        }),
      })
    );
    expect(invalidateCachedBusinessSettings).toHaveBeenCalledWith(tp);
  });
});

describe("POST /settings/payment/gocardless/disconnect", () => {
  it("clears the gocardless fields including the signing secret", async () => {
    const tp = makeTenantPrisma();
    const res = await request(makeApp(tp)).post("/settings/payment/gocardless/disconnect");

    expect(res.status).toBe(200);
    expect(tp.businessSettings.updateMany).toHaveBeenCalledWith({
      data: {
        gocardlessConnected: false,
        gocardlessAccessTokenEncrypted: null,
        gocardlessWebhookSecretEncrypted: null,
        gocardlessWebhookSigningSecretEncrypted: null,
        gocardlessEnvironment: null,
      },
    });
  });
});

describe("PATCH /settings/payment/gocardless/webhook-secret", () => {
  it("409s when GoCardless is not connected", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ gocardlessConnected: false });

    const res = await request(makeApp(tp))
      .patch("/settings/payment/gocardless/webhook-secret")
      .send({ secret: "real-secret" });

    expect(res.status).toBe(409);
  });

  it("saves the real signing secret when GoCardless is connected", async () => {
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ gocardlessConnected: true });

    const res = await request(makeApp(tp))
      .patch("/settings/payment/gocardless/webhook-secret")
      .send({ secret: "real-secret" });

    expect(res.status).toBe(200);
    expect(encrypt).toHaveBeenCalledWith("real-secret");
    expect(tp.businessSettings.updateMany).toHaveBeenCalledWith({
      data: { gocardlessWebhookSigningSecretEncrypted: "encrypted(real-secret)" },
    });
  });

  it("400s when secret is missing", async () => {
    const res = await request(makeApp()).patch("/settings/payment/gocardless/webhook-secret").send({});
    expect(res.status).toBe(400);
  });
});

describe("GET /settings/stripe/authorize", () => {
  it("redirects to the Stripe Connect authorize url", async () => {
    const res = await request(makeApp()).get("/settings/stripe/authorize");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://connect.stripe.com/oauth/authorize?mock=1");
    expect(buildStripeAuthUrl).toHaveBeenCalledWith(expect.stringMatching(/^tenant-1:[0-9a-f]+$/));
  });
});

describe("GET /settings/stripe/callback", () => {
  it("400s when Stripe reports an authorisation error", async () => {
    const res = await request(makeApp()).get("/settings/stripe/callback?error=access_denied");
    expect(res.status).toBe(400);
  });

  it("400s when code or state is missing", async () => {
    const res = await request(makeApp()).get("/settings/stripe/callback?state=abc");
    expect(res.status).toBe(400);
  });

  it("stores the connected account, mirrors it onto the public Tenant row, and redirects", async () => {
    exchangeStripeCode.mockResolvedValue({
      access_token: "acct_token",
      stripe_user_id: "acct_123",
      stripe_publishable_key: "pk_test_123",
      livemode: false,
    });
    const tp = makeTenantPrisma();

    const res = await request(makeApp(tp)).get("/settings/stripe/callback?code=ac_123&state=tenant-1:abc");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://app.test.roundflow.example/settings/integrations?stripe=connected");
    expect(tp.businessSettings.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stripeConnected: true,
        stripeConnectAccountId: "acct_123",
        stripePublishableKey: "pk_test_123",
        stripeSecretKeyEncrypted: "encrypted(acct_token)",
      }),
    });
    expect(tenantUpdate).toHaveBeenCalledWith({ where: { id: "tenant-1" }, data: { stripeConnectAccountId: "acct_123" } });
    expect(invalidateCachedBusinessSettings).toHaveBeenCalledWith(tp);
  });
});

describe("POST /settings/stripe/disconnect", () => {
  it("clears the stripe fields and the mirrored Tenant row", async () => {
    const tp = makeTenantPrisma();
    const res = await request(makeApp(tp)).post("/settings/stripe/disconnect");

    expect(res.status).toBe(200);
    expect(tp.businessSettings.updateMany).toHaveBeenCalledWith({
      data: {
        stripeConnected: false,
        stripeConnectAccountId: null,
        stripePublishableKey: null,
        stripeSecretKeyEncrypted: null,
      },
    });
    expect(tenantUpdate).toHaveBeenCalledWith({ where: { id: "tenant-1" }, data: { stripeConnectAccountId: null } });
  });
});
