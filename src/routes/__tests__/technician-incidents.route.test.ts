import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const remove = vi.fn();
vi.mock("../../services/technician-incident.service", () => ({
  createTechnicianIncidentService: vi.fn(() => ({ remove })),
}));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { technicianIncidentsRouter } from "../technician-incidents";
import { AppError } from "../../lib/app-error";

function makeApp(withTenant = true) {
  const app = express();
  app.use((req: any, _res, next) => {
    if (withTenant) req.tenantPrisma = {};
    next();
  });
  app.use("/technician-incidents", technicianIncidentsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

beforeEach(() => vi.clearAllMocks());

it("DELETE removes the incident → 204", async () => {
  remove.mockResolvedValue(undefined);
  const res = await request(makeApp()).delete("/technician-incidents/i1");
  expect(res.status).toBe(204);
  expect(remove).toHaveBeenCalledWith("i1");
});

it("DELETE 404s when the service does", async () => {
  remove.mockRejectedValue(new AppError(404, "Incident not found"));
  expect((await request(makeApp()).delete("/technician-incidents/x")).status).toBe(404);
});

it("500s without a tenant client", async () => {
  expect((await request(makeApp(false)).delete("/technician-incidents/i1")).status).toBe(500);
});
