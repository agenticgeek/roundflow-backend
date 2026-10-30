import { it, expect, vi, describe } from "vitest";
import request from "supertest";
import express from "express";

const mockBatchResult = [
  { roundId: "r1", occurrences: [{ date: "2026-01-01", stopCount: 2, totalValue: 150, completedCount: 1, completionPct: 50, holdCount: 1, issueCount: 2 }] },
  { roundId: "r2", occurrences: [] },
];

const listOccurrencesForRounds = vi.fn().mockResolvedValue(mockBatchResult);
const pushMissedJobs = vi.fn();
const listDayStopsForRounds = vi.fn();
const generateVisitsNow = vi.fn();
const getOccurrence = vi.fn();
const setTechnicians = vi.fn();
const getAllocation = vi.fn();
const reassignTechnician = vi.fn();
const logActivity = vi.fn();

vi.mock("../../services/round.service", async () => {
  // Real-shaped AllocationError without loading the real service module.
  const { AppError } = (await vi.importActual("../../lib/app-error")) as { AppError: typeof import("../../lib/app-error").AppError };
  class AllocationError extends AppError {
    constructor(public readonly fields: Record<string, string>) {
      super(400, "Invalid technician allocation", "INVALID_ALLOCATION");
    }
  }
  return {
  AllocationError,
  createRoundService: vi.fn(() => ({
    listOccurrencesForRounds,
    listRounds: vi.fn(),
    createRound: vi.fn(),
    getRound: vi.fn(),
    updateRound: vi.fn(),
    setTechnicians,
    getAllocation,
    listOccurrences: vi.fn(),
    getOccurrence,
    getTodayPanel: vi.fn(),
    reassignTechnician,
    pushMissedJobs,
    listDayStopsForRounds,
    generateVisitsNow,
  })),
  };
});

vi.mock("../../services/reports.service", () => ({
  createReportsService: vi.fn(() => ({ logActivity })),
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
import { errorHandler } from "../../lib/error-handler";
import { AllocationError } from "../../services/round.service";

// Uses the real centralised error handler (extra AppError fields forwarded).
function makeRealApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.tenantPrisma = {}; next(); });
  app.use("/rounds", roundsRouter);
  app.use(errorHandler);
  return app;
}

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

// ---------------------------------------------------------------------------
// GET /rounds/:id/planner/occurrences/:date — single-round day detail
// ---------------------------------------------------------------------------

describe("GET /rounds/:id/planner/occurrences/:date", () => {
  it("returns 200 with the occurrence detail (happy path)", async () => {
    const detail = { roundId: "round-1", roundName: "Alnwick Monday", date: "2026-01-01", stops: [], summary: {} };
    getOccurrence.mockResolvedValueOnce(detail);
    const res = await request(makeApp()).get("/rounds/round-1/planner/occurrences/2026-01-01");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(detail);
    expect(getOccurrence).toHaveBeenCalledWith("round-1", "2026-01-01");
  });

  it("400s for a nonexistent calendar date (Feb 30) — regression: a regex-only shape check would have let this through", async () => {
    getOccurrence.mockClear();
    const res = await request(makeApp()).get("/rounds/round-1/planner/occurrences/2026-02-30");
    expect(res.status).toBe(400);
    expect(getOccurrence).not.toHaveBeenCalled();
  });

  it("400s for day-of-month 00", async () => {
    const res = await request(makeApp()).get("/rounds/round-1/planner/occurrences/2026-01-00");
    expect(res.status).toBe(400);
  });

  it("400s for a malformed date string", async () => {
    const res = await request(makeApp()).get("/rounds/round-1/planner/occurrences/not-a-date");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /rounds/:id/push-missed
// ---------------------------------------------------------------------------

describe("POST /rounds/:id/push-missed", () => {
  it("passes the optional message field through to the service", async () => {
    pushMissedJobs.mockResolvedValueOnce({ pushedCount: 2 });
    const app = makeApp();
    const res = await request(app)
      .post("/rounds/r1/push-missed")
      .send({ newDate: "2099-01-01", reason: "Weather", notifyCustomers: true, message: "Sorry!" });
    expect(res.status).toBe(200);
    expect(pushMissedJobs).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ reason: "Weather", notifyCustomers: true, message: "Sorry!" })
    );
  });

  it("defaults message to undefined when omitted", async () => {
    pushMissedJobs.mockResolvedValueOnce({ pushedCount: 0 });
    const app = makeApp();
    const res = await request(app)
      .post("/rounds/r1/push-missed")
      .send({ newDate: "2099-01-01", reason: "Weather" });
    expect(res.status).toBe(200);
    expect(pushMissedJobs).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ message: undefined })
    );
  });

  it("400s when newDate is not a YYYY-MM-DD string", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/rounds/r1/push-missed")
      .send({ newDate: "01/01/2099", reason: "Weather" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /rounds/planner/occurrences/:date — batched day stops
// ---------------------------------------------------------------------------

describe("GET /rounds/planner/occurrences/:date", () => {
  it("returns 200 with per-round stops (happy path)", async () => {
    const mockDayStops = [{ roundId: "r1", stops: [{ visitId: "v1" }] }, { roundId: "r2", stops: [] }];
    listDayStopsForRounds.mockResolvedValueOnce(mockDayStops);
    const app = makeApp();
    const res = await request(app).get("/rounds/planner/occurrences/2026-01-01?roundIds=r1,r2");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockDayStops);
    expect(listDayStopsForRounds).toHaveBeenCalledWith(["r1", "r2"], "2026-01-01");
  });

  it("trims whitespace and drops empty entries in roundIds", async () => {
    listDayStopsForRounds.mockResolvedValueOnce([]);
    const app = makeApp();
    await request(app).get("/rounds/planner/occurrences/2026-01-01?roundIds=%20r1%20,,r2");
    expect(listDayStopsForRounds).toHaveBeenCalledWith(["r1", "r2"], "2026-01-01");
  });

  it("400s when roundIds is missing", async () => {
    const app = makeApp();
    const res = await request(app).get("/rounds/planner/occurrences/2026-01-01");
    expect(res.status).toBe(400);
  });

  it("400s when roundIds is blank", async () => {
    const app = makeApp();
    const res = await request(app).get("/rounds/planner/occurrences/2026-01-01?roundIds=%20,,");
    expect(res.status).toBe(400);
  });

  it("400s when more than 50 roundIds are given", async () => {
    const app = makeApp();
    const ids = Array.from({ length: 51 }, (_, i) => `r${i}`).join(",");
    const res = await request(app).get(`/rounds/planner/occurrences/2026-01-01?roundIds=${ids}`);
    expect(res.status).toBe(400);
  });

  it("400s for an invalid date", async () => {
    listDayStopsForRounds.mockClear();
    const app = makeApp();
    const res = await request(app).get("/rounds/planner/occurrences/not-a-date?roundIds=r1");
    expect(res.status).toBe(400);
    expect(listDayStopsForRounds).not.toHaveBeenCalled();
  });

  it("400s for a nonexistent calendar date (Feb 30)", async () => {
    const app = makeApp();
    const res = await request(app).get("/rounds/planner/occurrences/2026-02-30?roundIds=r1");
    expect(res.status).toBe(400);
  });

});

// ---------------------------------------------------------------------------
// POST /rounds/:id/generate-visits
// ---------------------------------------------------------------------------

describe("POST /rounds/:id/generate-visits", () => {
  it("returns 200 with the visitsGenerated count", async () => {
    generateVisitsNow.mockResolvedValueOnce({ visitsGenerated: 3 });
    const app = makeApp();
    const res = await request(app).post("/rounds/r1/generate-visits");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ visitsGenerated: 3 });
    expect(generateVisitsNow).toHaveBeenCalledWith("r1");
  });

  it("404s when the service rejects with AppError(404)", async () => {
    generateVisitsNow.mockRejectedValueOnce(new AppError(404, "Round not found"));
    const app = makeApp();
    const res = await request(app).post("/rounds/missing/generate-visits");
    expect(res.status).toBe(404);
  });

  it("400s when the service rejects because the round is not ACTIVE", async () => {
    generateVisitsNow.mockRejectedValueOnce(new AppError(400, "Round must be ACTIVE to generate visits"));
    const app = makeApp();
    const res = await request(app).post("/rounds/r1/generate-visits");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PUT /rounds/:id/technicians — split (A1 / GAP-012)
// ---------------------------------------------------------------------------

describe("PUT /rounds/:id/technicians", () => {
  const allocationResult = {
    roundId: "r1",
    allocation: [{ technicianId: "t1", name: "Sam", propertyIds: ["p1"], stops: 1, value: "37.00" }],
    visitsUpdated: 6,
  };

  it("passes technicianIds with no split (service picks SINGLE/AUTO) and logs the change", async () => {
    setTechnicians.mockResolvedValueOnce(allocationResult);
    logActivity.mockClear();
    const res = await request(makeApp()).put("/rounds/r1/technicians").send({ technicianIds: ["t1"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(allocationResult);
    expect(setTechnicians).toHaveBeenCalledWith("r1", ["t1"], undefined, { dryRun: false });
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  it("treats split: null as omitted", async () => {
    setTechnicians.mockResolvedValueOnce(allocationResult);
    await request(makeApp()).put("/rounds/r1/technicians").send({ technicianIds: ["t1"], split: null });
    expect(setTechnicians).toHaveBeenLastCalledWith("r1", ["t1"], undefined, { dryRun: false });
  });

  it("passes SINGLE/AUTO without allocations", async () => {
    for (const mode of ["SINGLE", "AUTO"]) {
      setTechnicians.mockResolvedValueOnce(allocationResult);
      const res = await request(makeApp())
        .put("/rounds/r1/technicians")
        .send({ technicianIds: ["t1"], split: { mode, allocations: [{ propertyId: "p1", technicianId: "t1" }] } });
      expect(res.status).toBe(200);
      expect(setTechnicians).toHaveBeenLastCalledWith("r1", ["t1"], { mode }, { dryRun: false });
    }
  });

  it("passes MANUAL allocations", async () => {
    setTechnicians.mockResolvedValueOnce(allocationResult);
    const allocations = [{ propertyId: "p1", technicianId: "t1" }];
    await request(makeApp()).put("/rounds/r1/technicians").send({ technicianIds: ["t1"], split: { mode: "MANUAL", allocations } });
    expect(setTechnicians).toHaveBeenLastCalledWith("r1", ["t1"], { mode: "MANUAL", allocations }, { dryRun: false });
  });

  it("?dryRun=true previews without logging activity", async () => {
    setTechnicians.mockResolvedValueOnce(allocationResult);
    logActivity.mockClear();
    const res = await request(makeApp()).put("/rounds/r1/technicians?dryRun=true").send({ technicianIds: ["t1", "t2"] });
    expect(res.status).toBe(200);
    expect(setTechnicians).toHaveBeenLastCalledWith("r1", ["t1", "t2"], undefined, { dryRun: true });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("400s for a bad technicianIds / split shape", async () => {
    const bodies = [
      { technicianIds: "t1" },
      { technicianIds: [1] },
      { technicianIds: ["t1"], split: "AUTO" },
      { technicianIds: ["t1"], split: { mode: "HALF" } },
      { technicianIds: ["t1"], split: { mode: "MANUAL" } },
      { technicianIds: ["t1"], split: { mode: "MANUAL", allocations: [null] } },
      { technicianIds: ["t1"], split: { mode: "MANUAL", allocations: [{ propertyId: "p1" }] } },
      { technicianIds: ["t1"], split: { mode: "MANUAL", allocations: [{ propertyId: 1, technicianId: "t1" }] } },
    ];
    setTechnicians.mockClear();
    for (const body of bodies) {
      const res = await request(makeApp()).put("/rounds/r1/technicians").send(body);
      expect(res.status).toBe(400);
    }
    expect(setTechnicians).not.toHaveBeenCalled();
  });

  it("400s with code INVALID_ALLOCATION and the fields map", async () => {
    setTechnicians.mockRejectedValueOnce(new AllocationError({ p9: "Property not in round" }));
    const res = await request(makeRealApp())
      .put("/rounds/r1/technicians")
      .send({ technicianIds: ["t1"], split: { mode: "MANUAL", allocations: [{ propertyId: "p9", technicianId: "t1" }] } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Invalid technician allocation",
      code: "INVALID_ALLOCATION",
      fields: { p9: "Property not in round" },
    });
  });

  it("forwards other service errors (pending invite 400)", async () => {
    setTechnicians.mockRejectedValueOnce(new AppError(400, "Cannot assign technician(s) with a pending invite: Sam"));
    const res = await request(makeApp()).put("/rounds/r1/technicians").send({ technicianIds: ["t1"] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Cannot assign technician(s) with a pending invite: Sam" });
  });
});

describe("GET /rounds/:id/allocation", () => {
  it("returns the service's { mode, allocation }", async () => {
    getAllocation.mockResolvedValueOnce({ mode: "AUTO", allocation: [] });
    const res = await request(makeApp()).get("/rounds/r1/allocation");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "AUTO", allocation: [] });
    expect(getAllocation).toHaveBeenCalledWith("r1");
  });
});

// ---------------------------------------------------------------------------
// POST /rounds/:id/reassign (GAP-013)
// ---------------------------------------------------------------------------

describe("POST /rounds/:id/reassign", () => {
  it("accepts fromTechnicianId null, a date, scope and permanent", async () => {
    reassignTechnician.mockResolvedValueOnce({ updated: 4 });
    const res = await request(makeApp()).post("/rounds/r1/reassign").send({
      date: "2099-11-06", fromTechnicianId: null, toTechnicianId: "t2", scope: "REMAINING", permanent: true, notify: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 4 });
    expect(reassignTechnician).toHaveBeenLastCalledWith("r1", {
      date: new Date("2099-11-06T00:00:00.000Z"),
      fromTechnicianId: null,
      toTechnicianId: "t2",
      scope: "REMAINING",
      permanent: true,
      note: undefined,
      notify: true,
    });
  });

  it("defaults date (today), fromTechnicianId (null), permanent and notify; accepts lowercase scope", async () => {
    reassignTechnician.mockResolvedValueOnce({ updated: 1 });
    const res = await request(makeApp()).post("/rounds/r1/reassign").send({ toTechnicianId: "t2", scope: "all", date: null });
    expect(res.status).toBe(200);
    expect(reassignTechnician).toHaveBeenLastCalledWith("r1", expect.objectContaining({
      date: undefined, fromTechnicianId: null, scope: "ALL", permanent: false, notify: false,
    }));
  });

  it("passes an explicit fromTechnicianId", async () => {
    reassignTechnician.mockResolvedValueOnce({ updated: 1 });
    await request(makeApp()).post("/rounds/r1/reassign").send({ fromTechnicianId: "t1", toTechnicianId: "t2", scope: "ALL" });
    expect(reassignTechnician).toHaveBeenLastCalledWith("r1", expect.objectContaining({ fromTechnicianId: "t1" }));
  });

  it("400s for a bad scope or date", async () => {
    for (const body of [
      { toTechnicianId: "t2", scope: "SOME" },
      { toTechnicianId: "t2", scope: "ALL", date: "06/11/2099" },
    ]) {
      const res = await request(makeApp()).post("/rounds/r1/reassign").send(body);
      expect(res.status).toBe(400);
    }
  });
});
