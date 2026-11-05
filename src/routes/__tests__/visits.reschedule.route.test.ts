import { it, expect, vi, describe, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const reschedule = vi.fn();
vi.mock("../../services/visit-reschedule", () => ({ createVisitRescheduleService: vi.fn(() => ({ reschedule })) }));
vi.mock("../../services/visit.service", () => ({ createVisitService: vi.fn(() => ({})) }));
vi.mock("../../services/reports.service", () => ({ createReportsService: vi.fn(() => ({})) }));
vi.mock("../../services/visit-completion", () => ({ createVisitCompletionService: vi.fn(() => ({})), parseCompletionPayment: vi.fn() }));
vi.mock("../../services/visit-photos.service", () => ({ createVisitPhotosService: vi.fn(() => ({})) }));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { visitsRouter } from "../visits";
import { errorHandler } from "../../lib/error-handler";

function makeApp(tenantPrisma: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.tenantPrisma = tenantPrisma; req.profile = { id: "u1", role: "MANAGER" }; next(); });
  app.use("/visits", visitsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe("PATCH /visits/:id/reschedule", () => {
  it("reschedules with the parsed date and the actor", async () => {
    reschedule.mockResolvedValue({ id: "v1", status: "SCHEDULED", date: "2026-11-10" });
    const res = await request(makeApp()).patch("/visits/v1/reschedule").send({ date: "2026-11-10" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "v1", status: "SCHEDULED", date: "2026-11-10" });
    expect(reschedule).toHaveBeenCalledWith("v1", { date: new Date("2026-11-10T00:00:00.000Z"), actor: { id: "u1", role: "MANAGER" } });
  });

  it("400s for a missing or malformed date", async () => {
    expect((await request(makeApp()).patch("/visits/v1/reschedule").send({})).status).toBe(400);
    expect((await request(makeApp()).patch("/visits/v1/reschedule").send({ date: "2026-02-30" })).status).toBe(400);
    expect((await request(makeApp()).patch("/visits/v1/reschedule").send({ date: 5 })).status).toBe(400);
    expect(reschedule).not.toHaveBeenCalled();
  });

  it("500s when the tenant client is missing", async () => {
    expect((await request(makeApp(null)).patch("/visits/v1/reschedule").send({ date: "2026-11-10" })).status).toBe(500);
  });
});
