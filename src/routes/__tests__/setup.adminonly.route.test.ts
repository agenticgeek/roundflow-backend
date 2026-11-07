import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Wave 2B-2 (e): the setup wizard's business profile (step 1: bank/VAT) and payment (step 2) writes are ADMIN only.
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { role: req.headers["x-role"] ?? "ADMIN" };
    req.tenantPrisma = {};
    next();
  },
}));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));
const svc = { assertSetupIncomplete: vi.fn().mockResolvedValue(undefined), getBusinessSettings: vi.fn().mockResolvedValue(null) };
vi.mock("../../services/setup.service", () => ({ createSetupService: vi.fn(() => svc) }));
vi.mock("../../services/settings.service", () => ({ createSettingsService: vi.fn(() => ({})) }));

import { setupRouter } from "../setup";
import { errorHandler } from "../../lib/error-handler";

const app = express();
app.use(express.json());
app.use("/setup", setupRouter);
app.use(errorHandler);

beforeEach(() => vi.clearAllMocks());

describe("setup wizard ADMIN-only steps", () => {
  it.each(["/setup/step/1", "/setup/step/2"])("MANAGER POST %s -> 403 ADMIN_ONLY before the handler runs", async (path) => {
    const res = await request(app).post(path).set("x-role", "MANAGER").send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ADMIN_ONLY");
    expect(svc.assertSetupIncomplete).not.toHaveBeenCalled();
  });

  it.each(["/setup/step/1", "/setup/step/2"])("ADMIN POST %s is not rejected as ADMIN_ONLY", async (path) => {
    const res = await request(app).post(path).set("x-role", "ADMIN").send({});
    expect(res.body.code).not.toBe("ADMIN_ONLY");
  });

  it("MANAGER can still run the other steps (reads and step 3)", async () => {
    const get = await request(app).get("/setup/step/1").set("x-role", "MANAGER");
    expect(get.status).toBe(200);
    const post = await request(app).post("/setup/step/3").set("x-role", "MANAGER").send({});
    expect(post.body.code).not.toBe("ADMIN_ONLY");
  });
});
