import { it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

const mockBatchResult = [
  { roundId: "r1", occurrences: [{ date: "2026-01-01", stopCount: 2, totalValue: 150, completedCount: 1, completionPct: 50, holdCount: 1, issueCount: 2 }] },
  { roundId: "r2", occurrences: [] },
];

const listOccurrencesForRounds = vi.fn().mockResolvedValue(mockBatchResult);

vi.mock("../../services/round.service", () => ({
  createRoundService: vi.fn(() => ({
    listOccurrencesForRounds,
    listRounds: vi.fn(),
    createRound: vi.fn(),
    getRound: vi.fn(),
    updateRound: vi.fn(),
    setTechnicians: vi.fn(),
    listOccurrences: vi.fn(),
    getOccurrence: vi.fn(),
    getTodayPanel: vi.fn(),
    reassignTechnician: vi.fn(),
    pushMissedJobs: vi.fn(),
  })),
}));

vi.mock("../../services/reports.service", () => ({
  createReportsService: vi.fn(() => ({ logActivity: vi.fn() })),
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

import { roundsRouter } from "../../routes/rounds";
import { AppError } from "../../lib/app-error";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.tenantPrisma = {}; next(); });
  app.use("/rounds", roundsRouter);
  // Mirrors the centralised error handler in src/index.ts: AppError -> its
  // own status code, anything else -> 500.
  app.use((err: unknown, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

it("roundsRouter is exported", () => {
  expect(roundsRouter).toBeDefined();
});

it("GET /rounds/planner/occurrences returns 200 with per-round occurrence buckets (happy path)", async () => {
  const app = makeApp();
  const res = await request(app).get("/rounds/planner/occurrences?roundIds=r1,r2&from=2026-01-01&to=2026-01-31");
  expect(res.status).toBe(200);
  expect(listOccurrencesForRounds).toHaveBeenCalledWith(
    ["r1", "r2"],
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-31T00:00:00.000Z"),
  );
  expect(res.body).toEqual(mockBatchResult);
});

it("GET /rounds/planner/occurrences trims whitespace and drops empty entries in roundIds", async () => {
  const app = makeApp();
  const res = await request(app).get("/rounds/planner/occurrences?roundIds=%20r1%20,,r2&from=2026-01-01");
  expect(res.status).toBe(200);
  expect(listOccurrencesForRounds).toHaveBeenCalledWith(["r1", "r2"], new Date("2026-01-01T00:00:00.000Z"), undefined);
});

it("GET /rounds/planner/occurrences returns 400 when roundIds is missing", async () => {
  const app = makeApp();
  const res = await request(app).get("/rounds/planner/occurrences?from=2026-01-01");
  expect(res.status).toBe(400);
});

it("GET /rounds/planner/occurrences returns 400 when roundIds is empty/blank", async () => {
  const app = makeApp();
  const res = await request(app).get("/rounds/planner/occurrences?roundIds=%20,,&from=2026-01-01");
  expect(res.status).toBe(400);
});

it("GET /rounds/planner/occurrences returns 400 when more than 50 roundIds are given", async () => {
  const app = makeApp();
  const ids = Array.from({ length: 51 }, (_, i) => `r${i}`).join(",");
  const res = await request(app).get(`/rounds/planner/occurrences?roundIds=${ids}&from=2026-01-01`);
  expect(res.status).toBe(400);
});

it("GET /rounds/planner/occurrences returns 400 for an invalid 'from' date format", async () => {
  const app = makeApp();
  const res = await request(app).get("/rounds/planner/occurrences?roundIds=r1&from=not-a-date");
  expect(res.status).toBe(400);
});

it("GET /rounds/planner/occurrences returns 400 for an invalid 'to' date format", async () => {
  const app = makeApp();
  const res = await request(app).get("/rounds/planner/occurrences?roundIds=r1&from=2026-01-01&to=01/02/2026");
  expect(res.status).toBe(400);
});

it("GET /rounds/planner/occurrences returns 400 when the service rejects a >90-day range", async () => {
  const app = makeApp();
  listOccurrencesForRounds.mockRejectedValueOnce(
    new AppError(400, "Date range must not exceed 90 days")
  );
  const res = await request(app).get("/rounds/planner/occurrences?roundIds=r1&from=2026-01-01&to=2026-12-31");
  expect(res.status).toBe(400);
});

it("GET /rounds/planner/occurrences returns 400 when the service rejects from > to", async () => {
  const app = makeApp();
  listOccurrencesForRounds.mockRejectedValueOnce(
    new AppError(400, '"from" must be before "to"')
  );
  const res = await request(app).get("/rounds/planner/occurrences?roundIds=r1&from=2026-02-01&to=2026-01-01");
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// Calendar-date validation (parseOptionalDateOnly) — regression tests for:
// the old `/^\d{4}-\d{2}-\d{2}$/` regex-only check accepted a well-formed but
// nonexistent calendar date (e.g. Feb 30) and either silently rolled it over
// (new Date() normalizes out-of-range components) or produced an Invalid
// Date that NaN-compared as false against the from>to guard, letting it
// through to the service/query layer instead of a clean 400.
// ---------------------------------------------------------------------------

it("GET /rounds/planner/occurrences returns 400 for a nonexistent calendar date (Feb 30)", async () => {
  const app = makeApp();
  const callsBefore = listOccurrencesForRounds.mock.calls.length;
  const res = await request(app).get("/rounds/planner/occurrences?roundIds=r1&from=2026-02-30");
  expect(res.status).toBe(400);
  // Validation must reject before the service is ever called for this request.
  expect(listOccurrencesForRounds.mock.calls.length).toBe(callsBefore);
});

it("GET /rounds/planner/occurrences returns 400 for day-of-month 00", async () => {
  const app = makeApp();
  const callsBefore = listOccurrencesForRounds.mock.calls.length;
  const res = await request(app).get("/rounds/planner/occurrences?roundIds=r1&from=2026-01-00");
  expect(res.status).toBe(400);
  expect(listOccurrencesForRounds.mock.calls.length).toBe(callsBefore);
});

it("GET /rounds/:id/planner/occurrences returns 400 for a nonexistent calendar date (Feb 30)", async () => {
  const app = makeApp();
  const res = await request(app).get("/rounds/round-1/planner/occurrences?from=2026-02-30");
  expect(res.status).toBe(400);
});

it("GET /rounds/:id/planner/occurrences returns 400 for day-of-month 00", async () => {
  const app = makeApp();
  const res = await request(app).get("/rounds/round-1/planner/occurrences?to=2026-01-00");
  expect(res.status).toBe(400);
});
