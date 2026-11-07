import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// BE-01: a MANAGER is blocked from the ADMIN-only settings actions; an ADMIN is not.
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { tenantId: "tenant-1", role: req.headers["x-role"] ?? "ADMIN" };
    req.tenantSchemaName = "t_0123456789abcdef0123";
    req.tenantPrisma = {};
    next();
  },
}));

const svc = {
  assertSetupComplete: vi.fn().mockResolvedValue(undefined),
  updateBusinessProfile: vi.fn().mockResolvedValue({}),
  updatePaymentRules: vi.fn().mockResolvedValue({}),
  deleteTechnician: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../../services/settings.service", () => ({
  createSettingsService: vi.fn(() => svc),
  invalidateCachedBusinessSettings: vi.fn(),
}));
vi.mock("../../lib/settings-dto", () => ({ toBusinessSettingsDto: (x: unknown) => x }));

import { settingsRouter } from "../settings";
import { errorHandler } from "../../lib/error-handler";

const app = express();
app.use(express.json());
app.use("/settings", settingsRouter);
app.use(errorHandler);

beforeEach(() => vi.clearAllMocks());

const ADMIN_ONLY: Array<[string, string]> = [
  ["patch", "/settings/payment"],
  ["post", "/settings/payment/gocardless/connect"],
  ["post", "/settings/payment/gocardless/disconnect"],
  ["patch", "/settings/payment/gocardless/webhook-secret"],
  ["get", "/settings/stripe/authorize"],
  ["get", "/settings/stripe/callback"],
  ["post", "/settings/stripe/disconnect"],
  ["get", "/settings/ghl/authorize"],
  ["post", "/settings/ghl/test"],
  ["post", "/settings/ghl/connect-private"],
  ["post", "/settings/ghl/disconnect"],
  ["delete", "/settings/technicians/t1"],
];

describe("settings: ADMIN-only actions", () => {
  it.each(ADMIN_ONLY)("MANAGER %s %s -> 403 ADMIN_ONLY before the handler runs", async (method, path) => {
    const res = await (request(app) as any)[method](path).set("x-role", "MANAGER").send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ADMIN_ONLY");
    expect(svc.updatePaymentRules).not.toHaveBeenCalled();
    expect(svc.deleteTechnician).not.toHaveBeenCalled();
  });

  it.each(ADMIN_ONLY)("ADMIN %s %s is not rejected as ADMIN_ONLY", async (method, path) => {
    const res = await (request(app) as any)[method](path).set("x-role", "ADMIN").send({});
    expect(res.body.code).not.toBe("ADMIN_ONLY");
  });

  it("PATCH /settings/business-profile: a MANAGER cannot change bank or VAT fields", async () => {
    for (const body of [{ bankDetails: null }, { vatRegistered: true }, { vatRegistration: "GB1" }, { vatRate: 20 }]) {
      const res = await request(app).patch("/settings/business-profile").set("x-role", "MANAGER").send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("ADMIN_ONLY");
    }
    expect(svc.updateBusinessProfile).not.toHaveBeenCalled();
  });

  it("PATCH /settings/business-profile: a MANAGER can still edit name/phone; an ADMIN can edit VAT", async () => {
    const ok = await request(app).patch("/settings/business-profile").set("x-role", "MANAGER").send({ phone: "0123" });
    expect(ok.status).toBe(200);
    const admin = await request(app).patch("/settings/business-profile").set("x-role", "ADMIN").send({ vatRegistered: true, vatRegistration: "GB123456789" });
    expect(admin.status).toBe(200);
    expect(svc.updateBusinessProfile).toHaveBeenCalledTimes(2);
  });

  it("everything else under /settings stays open to a MANAGER", async () => {
    const res = await request(app).patch("/settings/round-settings").set("x-role", "MANAGER").send({});
    expect(res.body.code).not.toBe("ADMIN_ONLY");
  });
});
