import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// The completion logic itself is covered in services/__tests__/visit-completion.test.ts;
// these tests cover the web route wiring (body parsing, actor, response) and
// GET /visits/:id/photos.

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (_req: any, _res: any, next: any) => {
    _req.profile = { id: "prof-admin", tenantId: "tenant-1", role: "ADMIN" };
    next();
  },
}));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  requireBusinessAccess: () => (_req: any, _res: any, next: any) => next(),
}));

const completeVisit = vi.fn();
vi.mock("../../services/visit-completion", async (orig) => {
  const actual = await orig<typeof import("../../services/visit-completion")>();
  return { ...actual, createVisitCompletionService: () => ({ completeVisit: (...a: unknown[]) => completeVisit(...a) }) };
});

const listForVisit = vi.fn();
vi.mock("../../services/visit-photos.service", () => ({
  createVisitPhotosService: () => ({ listForVisit: (...a: unknown[]) => listForVisit(...a) }),
}));

import { visitsRouter } from "../visits";
import { AppError } from "../../lib/app-error";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = {};
    next();
  });
  app.use("/visits", visitsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  completeVisit.mockResolvedValue({ id: "visit-1", status: "COMPLETED", payment: null });
});

describe("PATCH /visits/:id/complete", () => {
  it("passes the parsed payment and the admin actor to the shared completion", async () => {
    const res = await request(makeApp())
      .patch("/visits/visit-1/complete")
      .send({ payment: { method: "CHEQUE", chequeNumber: "0042" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "visit-1", status: "COMPLETED", payment: null });
    expect(completeVisit).toHaveBeenCalledWith("visit-1", {
      payment: { method: "CHEQUE", amount: undefined, chequeNumber: "0042" },
      actorProfileId: "prof-admin",
      actorRole: "ADMIN",
    });
  });

  it("keeps the deprecated cashConfirmed alias", async () => {
    await request(makeApp()).patch("/visits/visit-1/complete").send({ cashConfirmed: true });
    expect(completeVisit.mock.calls[0][1].payment).toEqual({ method: "CASH" });
  });

  it("400s on invalid payment input without calling the service", async () => {
    const res = await request(makeApp()).patch("/visits/visit-1/complete").send({ payment: { method: "PAYPAL" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYMENT");
    expect(completeVisit).not.toHaveBeenCalled();
  });

  it("relays service errors", async () => {
    completeVisit.mockRejectedValue(new AppError(400, "confirm cash", "PAYMENT_CONFIRMATION_REQUIRED"));
    const res = await request(makeApp()).patch("/visits/visit-1/complete").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PAYMENT_CONFIRMATION_REQUIRED");
  });
});

describe("GET /visits/:id/photos", () => {
  it("returns the photo rows", async () => {
    listForVisit.mockResolvedValue({ rows: [{ id: "ph1" }], pagination: { page: 1, pageSize: 1, total: 1, totalPages: 1 } });
    const res = await request(makeApp()).get("/visits/visit-1/photos");
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([{ id: "ph1" }]);
    expect(listForVisit).toHaveBeenCalledWith("visit-1");
  });
});
