import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _s: any, n: any) => {
    req.profile = { tenantId: "t1", role: "ADMIN" };
    n();
  },
}));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

const sendReminder = vi.fn();
const flagHold = vi.fn();
const flagBadDebt = vi.fn();
vi.mock("../../services/debt.service", () => ({
  createDebtService: vi.fn(() => ({ sendReminder, flagHold, flagBadDebt })),
}));
const queueGhlEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({ queueGhlEvent: (...a: unknown[]) => queueGhlEvent(...a) }));

import { debtRouter } from "../debt";
import { AppError } from "../../lib/app-error";
import { errorHandler } from "../../lib/error-handler";
import { parseBulkDebtRequest, runBulkDebtAction } from "../../services/debt-bulk";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = {};
    next();
  });
  app.use("/debt", debtRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => vi.clearAllMocks());

it("POST /debt/bulk remind: runs the per-debt reminder for each id, reports failures per id, queues GHL events", async () => {
  sendReminder
    .mockResolvedValueOnce({ customerId: "c1" })
    .mockRejectedValueOnce(new AppError(400, "No mobile number", "NO_CONTACT_FOR_CHANNEL"))
    .mockRejectedValueOnce(new Error("boom"))
    .mockRejectedValueOnce("string failure");
  const res = await request(makeApp()).post("/debt/bulk").send({ ids: ["i1", "i2", "i3", "i4", "i1"], action: "remind", channel: "SMS", message: "  hi " });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ action: "remind", total: 4, succeeded: 1, failed: 3 });
  expect(res.body.results).toEqual([
    { id: "i1", ok: true },
    { id: "i2", ok: false, error: "No mobile number", code: "NO_CONTACT_FOR_CHANNEL", skipped: true, reason: "NO_AVAILABLE_CHANNEL" },
    { id: "i3", ok: false, error: "boom" },
    { id: "i4", ok: false, error: "string failure" },
  ]);
  expect(sendReminder).toHaveBeenCalledWith("i1", { channel: "SMS", message: "  hi " });
  expect(queueGhlEvent).toHaveBeenCalledTimes(1);
  expect(queueGhlEvent.mock.calls[0].slice(1)).toEqual(["debt.overdue", "c1"]);
});

it("POST /debt/bulk hold and bad-debt reuse flagHold / flagBadDebt", async () => {
  flagHold.mockResolvedValue({});
  const hold = await request(makeApp()).post("/debt/bulk").send({ ids: ["i1"], action: "hold", reason: "Unpaid", notify: true, message: "m" });
  expect(hold.body).toMatchObject({ succeeded: 1, failed: 0 });
  expect(flagHold).toHaveBeenCalledWith("i1", true, { reason: "Unpaid", notify: true, message: "m" });

  flagBadDebt.mockResolvedValue({});
  const bad = await request(makeApp()).post("/debt/bulk").send({ ids: ["i1", "i2"], action: "bad-debt" });
  expect(bad.body).toMatchObject({ action: "bad-debt", succeeded: 2 });
  expect(flagBadDebt).toHaveBeenCalledWith("i2", true);
});

it("POST /debt/bulk validates the request", async () => {
  const app = makeApp();
  for (const body of [
    {},
    { ids: ["i1"], action: "delete" },
    { ids: [], action: "hold" },
    { ids: "i1", action: "hold" },
    { ids: [1], action: "hold" },
    { ids: Array.from({ length: 101 }, (_, i) => `i${i}`), action: "hold" },
    { ids: ["i1"], action: "hold", reason: 5 },
    { ids: ["i1"], action: "hold", notify: "yes" },
  ]) {
    expect((await request(app).post("/debt/bulk").send(body)).status).toBe(400);
  }
  expect(flagHold).not.toHaveBeenCalled();
});

it("parseBulkDebtRequest dedupes ids; runBulkDebtAction works without options", async () => {
  expect(parseBulkDebtRequest({ ids: ["a", "a", "b"], action: "hold" })).toEqual({ ids: ["a", "b"], action: "hold" });
  sendReminder.mockResolvedValue({ customerId: "c9" });
  const out = await runBulkDebtAction({ sendReminder } as never, ["a"], "remind");
  expect(out.succeeded).toBe(1);
});
