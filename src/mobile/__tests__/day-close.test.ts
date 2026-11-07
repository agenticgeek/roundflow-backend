import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { Prisma } from "../../generated/tenant-client";

// POST /mobile/day/close + GET /mobile/day: the real router, idempotency and
// day-close service against a fake tenant client (today = 2026-11-03).

let role = "TECHNICIAN";
let tp: ReturnType<typeof makeTp>;

vi.mock("../../lib/prisma", () => ({ prisma: { profile: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { supabaseUserId: "sb-user-1", email: "sam@x.co" };
    next();
  },
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: "profile-1", tenantId: "tenant-1", name: "Sam", role };
    req.tenantPrisma = tp;
    next();
  },
}));
vi.mock("../../services/business-time", () => ({
  tenantTodayRange: async () => ({ start: new Date("2026-11-03T00:00:00.000Z"), end: new Date("2026-11-04T00:00:00.000Z") }),
}));

vi.mock("../../services/notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());

import { mobileRouter } from "../routes";
import { AppError } from "../../lib/app-error";
import { notifyAdmins } from "../../services/notify";

const visit = (id: string, status: string) => ({
  id,
  status,
  round: { name: "North" },
  property: { addressLine: `${id} High St`, customer: { name: `Cust ${id}` } },
});

function makeTp() {
  return {
    technician: { findUnique: vi.fn().mockResolvedValue({ id: "tech-1", active: true, name: "Sam Taylor" }) },
    visit: { findMany: vi.fn().mockResolvedValue([]) },
    technicianDayClose: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ closedAt: new Date("2026-11-03T17:00:00.000Z") }),
    },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/mobile", mobileRouter);
  app.use((err: unknown, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  role = "TECHNICIAN";
  tp = makeTp();
});

describe("GET /mobile/day", () => {
  it("reports open visits and live counts when not closed", async () => {
    tp.visit.findMany.mockResolvedValue([visit("a", "COMPLETED"), visit("b", "SKIPPED"), visit("c", "SCHEDULED"), visit("d", "IN_PROGRESS")]);
    const res = await request(makeApp()).get("/mobile/day");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: "2026-11-03", closed: false, closedAt: null, completedCount: 1, skippedCount: 1 });
    expect(res.body.remaining).toEqual([
      { visitId: "c", status: "SCHEDULED", customerName: "Cust c", addressLine: "c High St", roundName: "North" },
      { visitId: "d", status: "IN_PROGRESS", customerName: "Cust d", addressLine: "d High St", roundName: "North" },
    ]);
    expect(tp.visit.findMany.mock.calls[0][0].where.technicianId).toBe("tech-1");
  });

  it("returns the stored sign-off once closed, for another day by ?date", async () => {
    tp.technicianDayClose.findUnique.mockResolvedValue({ closedAt: new Date("2026-11-02T17:00:00.000Z"), completedCount: 4, skippedCount: 1 });
    const res = await request(makeApp()).get("/mobile/day?date=2026-11-02");
    expect(res.body).toMatchObject({ date: "2026-11-02", closed: true, completedCount: 4, skippedCount: 1, remaining: [] });
    expect(tp.technicianDayClose.findUnique.mock.calls[0][0].where.technicianId_date).toEqual({ technicianId: "tech-1", date: "2026-11-02" });
  });

  it.each(["2026-13-40", "yesterday", "2026-02-30"])("400 INVALID_DATE for %s", async (d) => {
    const res = await request(makeApp()).get(`/mobile/day?date=${d}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE");
  });

  it("400 FUTURE_DATE for a day that has not started", async () => {
    const res = await request(makeApp()).get("/mobile/day?date=2026-11-04");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("FUTURE_DATE");
  });

  it("403 TECHNICIAN_ONLY for office roles", async () => {
    role = "ADMIN";
    expect((await request(makeApp()).get("/mobile/day")).status).toBe(403);
  });
});

describe("POST /mobile/day/close", () => {
  it("409 UNFINISHED_VISITS lists what remains and records nothing", async () => {
    tp.visit.findMany.mockResolvedValue([visit("a", "COMPLETED"), visit("c", "SCHEDULED")]);
    const res = await request(makeApp()).post("/mobile/day/close").send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UNFINISHED_VISITS");
    expect(res.body.remaining).toHaveLength(1);
    expect(res.body.remaining[0].visitId).toBe("c");
    expect(tp.technicianDayClose.create).not.toHaveBeenCalled();
  });

  it("closes when everything is completed or skipped, and logs it for the office", async () => {
    tp.visit.findMany.mockResolvedValue([visit("a", "COMPLETED"), visit("b", "SKIPPED"), visit("e", "COMPLETED")]);
    const res = await request(makeApp()).post("/mobile/day/close").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyClosed: false, closed: true, completedCount: 2, skippedCount: 1, remaining: [] });
    expect(tp.technicianDayClose.create).toHaveBeenCalledWith({
      data: { technicianId: "tech-1", date: "2026-11-03", completedCount: 2, skippedCount: 1 },
    });
    await vi.waitFor(() => expect(tp.activityLog.create).toHaveBeenCalled());
    expect(tp.activityLog.create.mock.calls[0][0].data).toMatchObject({ type: "TECHNICIAN_DAY_CLOSED", actorId: "profile-1" });
  });

  it("NOTIF-03: tells the office on the first close only, naming the technician and the counts", async () => {
    tp.visit.findMany.mockResolvedValue([visit("a", "COMPLETED"), visit("b", "SKIPPED"), visit("e", "COMPLETED")]);
    await request(makeApp()).post("/mobile/day/close").send({});
    expect(notifyAdmins).toHaveBeenCalledWith(tp, {
      type: "DAY_CLOSED",
      title: "Sam Taylor finished the day",
      body: "2 completed, 1 skipped.",
      data: { date: "2026-11-03" },
    });
    expect(tp.technician.findUnique).toHaveBeenCalledWith({ where: { id: "tech-1" }, select: { name: true } });
  });

  it("NOTIF-03: falls back to 'A technician' when the name is unknown", async () => {
    tp.technician.findUnique.mockResolvedValueOnce({ id: "tech-1", active: true }); // ownership check
    tp.technician.findUnique.mockResolvedValueOnce(null); // name lookup
    await request(makeApp()).post("/mobile/day/close").send({});
    expect(notifyAdmins).toHaveBeenCalledWith(tp, expect.objectContaining({ title: "A technician finished the day" }));
  });

  it("NOTIF-03: sends nothing for an already-closed day or when visits remain", async () => {
    tp.technicianDayClose.findUnique.mockResolvedValue({ closedAt: new Date(), completedCount: 1, skippedCount: 0 });
    await request(makeApp()).post("/mobile/day/close").send({});
    tp.technicianDayClose.findUnique.mockResolvedValue(null);
    tp.visit.findMany.mockResolvedValue([visit("c", "SCHEDULED")]);
    await request(makeApp()).post("/mobile/day/close").send({});
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it("closes a day with no visits at all", async () => {
    const res = await request(makeApp()).post("/mobile/day/close").send({ date: "2026-11-03" });
    expect(res.status).toBe(200);
    expect(res.body.completedCount).toBe(0);
  });

  it("is idempotent: an already-closed day returns the stored sign-off without a second row or log", async () => {
    tp.technicianDayClose.findUnique.mockResolvedValue({ closedAt: new Date("2026-11-03T17:00:00.000Z"), completedCount: 3, skippedCount: 0 });
    const res = await request(makeApp()).post("/mobile/day/close").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyClosed: true, closed: true, completedCount: 3 });
    expect(tp.technicianDayClose.create).not.toHaveBeenCalled();
    expect(tp.activityLog.create).not.toHaveBeenCalled();
  });

  it("resolves a concurrent-close unique violation to the winning row", async () => {
    tp.technicianDayClose.create.mockRejectedValue({ code: "P2002" });
    tp.technicianDayClose.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ closedAt: new Date("2026-11-03T17:00:00.000Z"), completedCount: 0, skippedCount: 0 });
    const res = await request(makeApp()).post("/mobile/day/close").send({});
    expect(res.status).toBe(200);
    expect(res.body.alreadyClosed).toBe(true);
  });

  it("surfaces unexpected create errors as 500", async () => {
    tp.technicianDayClose.create.mockRejectedValue(new Error("db down"));
    expect((await request(makeApp()).post("/mobile/day/close").send({})).status).toBe(500);
  });

  it("replays a stored response for a repeated X-Idempotency-Key", async () => {
    tp.idempotencyRecord.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    tp.idempotencyRecord.findUnique.mockResolvedValue({
      technicianId: "tech-1", state: "DONE", route: "POST /mobile/day/close", responseStatus: 200, responseBody: { alreadyClosed: false, closed: true },
    });
    const res = await request(makeApp()).post("/mobile/day/close").set("X-Idempotency-Key", "k1").send({});
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replay"]).toBe("true");
    expect(tp.visit.findMany).not.toHaveBeenCalled();
  });

  it("403 for office roles", async () => {
    role = "MANAGER";
    expect((await request(makeApp()).post("/mobile/day/close").send({})).status).toBe(403);
  });
});
