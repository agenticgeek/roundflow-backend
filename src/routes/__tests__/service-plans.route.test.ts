import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const updateServicePlan = vi.fn();
const pauseServicePlan = vi.fn();
const resumeServicePlan = vi.fn();

vi.mock("../../services/customer.service", () => ({
  createCustomerService: vi.fn(() => ({ updateServicePlan, pauseServicePlan, resumeServicePlan })),
}));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  requireBusinessAccess: () => (_req: any, _res: any, next: any) => next(),
}));

import { servicePlansRouter } from "../../routes/service-plans";
import { AppError } from "../../lib/app-error";
import { errorHandler } from "../../lib/error-handler";
import { NoMatchingRoundError } from "../../services/service-plan-lifecycle";

// Uses the real centralised error handler (extra AppError fields forwarded).
function makeRealApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.tenantPrisma = {}; next(); });
  app.use("/service-plans", servicePlansRouter);
  app.use(errorHandler);
  return app;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.tenantPrisma = {}; next(); });
  app.use("/service-plans", servicePlansRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

function makeAppWithUndefinedBody() {
  const app = express();
  app.use((req: any, _res: any, next: any) => { req.tenantPrisma = {}; req.body = undefined; next(); });
  app.use("/service-plans", servicePlansRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("servicePlansRouter is exported", () => {
  expect(servicePlansRouter).toBeDefined();
});

it("500s when req.tenantPrisma is not initialised", async () => {
  const app = express();
  app.use(express.json());
  app.use("/service-plans", servicePlansRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: "Internal error" });
  });
  const res = await request(app).post("/service-plans/sp1/resume");
  expect(res.status).toBe(500);
});

// ---------------------------------------------------------------------------
// PATCH /service-plans/:id
// ---------------------------------------------------------------------------

it("PATCH /service-plans/:id passes through every provided field", async () => {
  updateServicePlan.mockResolvedValue({ id: "sp1", price: 50 });
  const res = await request(makeApp())
    .patch("/service-plans/sp1")
    .send({ price: 50, cleanMethod: "Water Fed Pole", paymentMethod: "GOCARDLESS", cleaningFrequency: "FOUR_WEEKLY" });

  expect(res.status).toBe(200);
  expect(updateServicePlan).toHaveBeenCalledWith("sp1", {
    price: 50,
    cleanMethod: "Water Fed Pole",
    paymentMethod: "GOCARDLESS",
    cleaningFrequency: "FOUR_WEEKLY",
  });
});

it("PATCH /service-plans/:id with an empty body sends all-undefined fields", async () => {
  updateServicePlan.mockResolvedValue({ id: "sp1" });
  const res = await request(makeApp()).patch("/service-plans/sp1").send({});
  expect(res.status).toBe(200);
  expect(updateServicePlan).toHaveBeenCalledWith("sp1", {
    price: undefined,
    cleanMethod: undefined,
    paymentMethod: undefined,
    cleaningFrequency: undefined,
  });
});

it("PATCH /service-plans/:id 400s when price is not a number", async () => {
  const res = await request(makeApp()).patch("/service-plans/sp1").send({ price: "fifty" });
  expect(res.status).toBe(400);
  expect(updateServicePlan).not.toHaveBeenCalled();
});

it("PATCH /service-plans/:id 400s when price exceeds the max", async () => {
  const res = await request(makeApp()).patch("/service-plans/sp1").send({ price: 99999 });
  expect(res.status).toBe(400);
});

it("PATCH /service-plans/:id 404s when the service rejects with AppError(404)", async () => {
  updateServicePlan.mockRejectedValue(new AppError(404, "Service plan not found"));
  const res = await request(makeApp()).patch("/service-plans/missing").send({ price: 50 });
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// POST /service-plans/:id/pause
// ---------------------------------------------------------------------------

it("POST /service-plans/:id/pause 400s when reason is missing", async () => {
  const res = await request(makeApp()).post("/service-plans/sp1/pause").send({ pauseStartDate: "2026-02-01" });
  expect(res.status).toBe(400);
  expect(pauseServicePlan).not.toHaveBeenCalled();
});

it("POST /service-plans/:id/pause 400s when req.body is undefined", async () => {
  const res = await request(makeAppWithUndefinedBody()).post("/service-plans/sp1/pause");
  expect(res.status).toBe(400);
});

it("POST /service-plans/:id/pause 400s when pauseEndDate is not after pauseStartDate", async () => {
  const res = await request(makeApp())
    .post("/service-plans/sp1/pause")
    .send({ reason: "Holiday", pauseStartDate: "2026-02-01", pauseEndDate: "2026-01-01" });
  expect(res.status).toBe(400);
  expect(pauseServicePlan).not.toHaveBeenCalled();
});

it("POST /service-plans/:id/pause pauses with a start and end date", async () => {
  pauseServicePlan.mockResolvedValue({ id: "sp1", status: "PAUSED" });
  const res = await request(makeApp())
    .post("/service-plans/sp1/pause")
    .send({ reason: "Holiday", pauseStartDate: "2026-02-01", pauseEndDate: "2026-03-01" });

  expect(res.status).toBe(200);
  const call = pauseServicePlan.mock.calls[0];
  expect(call[0]).toBe("sp1");
  expect(call[1].pauseStartDate).toBeInstanceOf(Date);
  expect(call[1].pauseEndDate).toBeInstanceOf(Date);
});

it("POST /service-plans/:id/pause pauses with no end date", async () => {
  pauseServicePlan.mockResolvedValue({ id: "sp1", status: "PAUSED" });
  const res = await request(makeApp())
    .post("/service-plans/sp1/pause")
    .send({ reason: "Holiday", pauseStartDate: "2026-02-01" });

  expect(res.status).toBe(200);
  const call = pauseServicePlan.mock.calls[0];
  expect(call[1].pauseEndDate).toBeUndefined();
});

it("POST /service-plans/:id/pause 409s when the service rejects (already paused)", async () => {
  pauseServicePlan.mockRejectedValue(new AppError(409, "Service plan is already paused"));
  const res = await request(makeApp())
    .post("/service-plans/sp1/pause")
    .send({ reason: "Holiday", pauseStartDate: "2026-02-01" });
  expect(res.status).toBe(409);
});

// ---------------------------------------------------------------------------
// POST /service-plans/:id/resume
// ---------------------------------------------------------------------------

it("POST /service-plans/:id/resume resumes the plan", async () => {
  resumeServicePlan.mockResolvedValue({ id: "sp1", status: "ACTIVE" });
  const res = await request(makeApp()).post("/service-plans/sp1/resume");
  expect(res.status).toBe(200);
  expect(resumeServicePlan).toHaveBeenCalledWith("sp1");
});

it("POST /service-plans/:id/resume 409s when the service rejects (not paused)", async () => {
  resumeServicePlan.mockRejectedValue(new AppError(409, "Service plan is not paused"));
  const res = await request(makeApp()).post("/service-plans/sp1/resume");
  expect(res.status).toBe(409);
});

// ---------------------------------------------------------------------------
// B3: frequency change → round move
// ---------------------------------------------------------------------------

it("PATCH /service-plans/:id passes createRoundIfMissing through and returns { servicePlan, movedToRound }", async () => {
  const body = { servicePlan: { id: "sp1" }, movedToRound: { id: "r9", name: "Alnwick Fri 6wk", created: true } };
  updateServicePlan.mockResolvedValue(body);
  const res = await request(makeApp())
    .patch("/service-plans/sp1")
    .send({ cleaningFrequency: "SIX_WEEKLY", createRoundIfMissing: true });
  expect(res.status).toBe(200);
  expect(res.body).toEqual(body);
  expect(updateServicePlan.mock.calls[0][1].createRoundIfMissing).toBe(true);
});

it("PATCH /service-plans/:id 400s when createRoundIfMissing is not a boolean", async () => {
  const res = await request(makeApp()).patch("/service-plans/sp1").send({ createRoundIfMissing: "yes" });
  expect(res.status).toBe(400);
});

it("PATCH /service-plans/:id 409s NO_MATCHING_ROUND with suggestions and proposedName", async () => {
  const suggestions = [{ id: "r2", name: "Alnwick Fri 4wk", frequency: "FOUR_WEEKLY" as const, defaultDay: "FRI" as const }];
  updateServicePlan.mockRejectedValue(new NoMatchingRoundError("No match", suggestions, "Alnwick Fri 6wk"));
  const res = await request(makeRealApp()).patch("/service-plans/sp1").send({ cleaningFrequency: "SIX_WEEKLY" });
  expect(res.status).toBe(409);
  expect(res.body).toEqual({
    error: "No match",
    code: "NO_MATCHING_ROUND",
    suggestions,
    proposedName: "Alnwick Fri 6wk",
  });
});
