import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

const generateForTenant = vi.fn();
vi.mock("../../jobs/visitGeneration", () => ({ generateForTenant: (...a: unknown[]) => generateForTenant(...a) }));

let role = "ADMIN";
const tenantA = { businessSettings: { findFirst: vi.fn().mockResolvedValue({ timezone: "UTC" }) }, name: "A" };
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: { tenantPrisma?: unknown; profile?: unknown; header: (n: string) => string | undefined }, _s: unknown, n: () => void) => {
    if (req.header("x-no-tenant") !== "1") req.tenantPrisma = tenantA;
    req.profile = { role };
    n();
  },
}));

import { createTestHooksRouter } from "../test-hooks";
import { now, testClockMiddleware } from "../../lib/clock";
import { errorHandler } from "../../lib/error-handler";

const saved = { flag: process.env.ALLOW_TEST_CLOCK, env: process.env.NODE_ENV };
beforeEach(() => {
  process.env.ALLOW_TEST_CLOCK = "1";
  process.env.NODE_ENV = "test";
  role = "ADMIN";
  generateForTenant.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  if (saved.flag === undefined) delete process.env.ALLOW_TEST_CLOCK;
  else process.env.ALLOW_TEST_CLOCK = saved.flag;
  process.env.NODE_ENV = saved.env;
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(testClockMiddleware);
  app.use("/test-hooks", createTestHooksRouter());
  app.use(errorHandler);
  return app;
}

describe("POST /test-hooks/run-nightly", () => {
  it("runs the nightly job for the calling tenant at body.at and returns the date", async () => {
    const res = await request(makeApp()).post("/test-hooks/run-nightly").send({ at: "2031-07-09T23:30:00.000Z" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ date: "2031-07-09" });
    expect(generateForTenant).toHaveBeenCalledTimes(1);
    const [tp, today] = generateForTenant.mock.calls[0];
    expect(tp).toBe(tenantA);
    expect((today as Date).toISOString()).toBe("2031-07-09T00:00:00.000Z");
  });

  it("runs the job's own work inside the scoped clock", async () => {
    let seen = "";
    generateForTenant.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen = now().toISOString();
    });
    await request(makeApp()).post("/test-hooks/run-nightly").send({ at: "2031-07-09T10:00:00.000Z" });
    expect(seen).toBe("2031-07-09T10:00:00.000Z");
  });

  it("falls back to the X-Test-Now header when the body has no at", async () => {
    const res = await request(makeApp()).post("/test-hooks/run-nightly").set("X-Test-Now", "2032-02-03T12:00:00.000Z").send({});
    expect(res.body).toEqual({ date: "2032-02-03" });
  });

  it("uses the real date when neither body nor header give one", async () => {
    const res = await request(makeApp()).post("/test-hooks/run-nightly");
    expect(res.status).toBe(200);
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.date).not.toBe("2031-07-09");
  });

  it.each([["not-a-date"], [12345], [{}]])("400 INVALID_TEST_NOW for at=%j", async (at) => {
    const res = await request(makeApp()).post("/test-hooks/run-nightly").send({ at });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_TEST_NOW");
    expect(generateForTenant).not.toHaveBeenCalled();
  });

  it.each(["MANAGER", "TECHNICIAN"])("403 for %s (ADMIN only)", async (r) => {
    role = r;
    const res = await request(makeApp()).post("/test-hooks/run-nightly").send({});
    expect(res.status).toBe(403);
    expect(generateForTenant).not.toHaveBeenCalled();
  });

  it("500 without a tenant client", async () => {
    const res = await request(makeApp()).post("/test-hooks/run-nightly").set("x-no-tenant", "1").send({});
    expect(res.status).toBe(500);
  });

  it("runs exactly once, for the caller's tenant only (never loops over tenants)", async () => {
    await request(makeApp()).post("/test-hooks/run-nightly").send({});
    expect(generateForTenant).toHaveBeenCalledTimes(1);
  });
});
