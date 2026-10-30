import { it, expect, vi } from "vitest";
import { createTodayService } from "../today.service";
import { Prisma } from "../../generated/tenant-client";

// NOTE: today.service.ts previously had no dedicated test file. Added here
// as part of the Step 6 follow-up (wiring getCachedBusinessSettings into
// getTodaysWork()) so that change has real coverage — not a full-file test
// suite for today.service.ts (closeDay/computeKpi/buildRoundRows etc. remain
// untested pre-existing gaps, out of scope for this change).

function makePrisma() {
  return {
    businessSettings: { findFirst: vi.fn(), updateMany: vi.fn() },
    visit: { findMany: vi.fn() },
    $transaction: vi.fn(),
  } as unknown as Parameters<typeof createTodayService>[0];
}

it("createTodayService returns an object", () => {
  expect(createTodayService(makePrisma())).toBeDefined();
});

it("getTodaysWork: dayClosed is true when cached settings' lastClosedDate matches today", async () => {
  const prisma = makePrisma();
  const today = new Date().toISOString().slice(0, 10);
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    lastClosedDate: today,
  });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createTodayService(prisma).getTodaysWork();

  expect(result.dayClosed).toBe(true);
  expect(result.date).toBe(today);
});

it("getTodaysWork: dayClosed is false when settings has no matching lastClosedDate", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    lastClosedDate: "2020-01-01",
  });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createTodayService(prisma).getTodaysWork();

  expect(result.dayClosed).toBe(false);
});

it("getTodaysWork: dayClosed is false when settings is null (not yet configured)", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createTodayService(prisma).getTodaysWork();

  expect(result.dayClosed).toBe(false);
});

it("getTodaysWork: repeated calls reuse the cached settings read (single findFirst call)", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    lastClosedDate: null,
  });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const svc = createTodayService(prisma);
  await svc.getTodaysWork();
  await svc.getTodaysWork();

  // getCachedBusinessSettings caches by prisma-instance identity, so two
  // calls on the same service/prisma instance should only hit Prisma once.
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(1);
});

it("getTodaysWork: builds KPI/round/technician aggregates from today's visits", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    lastClosedDate: null,
  });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "v1",
      status: "COMPLETED",
      paymentHold: false,
      price: new Prisma.Decimal(25),
      roundId: "r1",
      round: { id: "r1", name: "Round 1" },
      technicianId: "t1",
      technician: { id: "t1", name: "Tech One" },
      _count: { issues: 0 },
    },
    {
      id: "v2",
      status: "SKIPPED",
      paymentHold: true,
      price: new Prisma.Decimal(10),
      roundId: "r1",
      round: { id: "r1", name: "Round 1" },
      technicianId: "t1",
      technician: { id: "t1", name: "Tech One" },
      _count: { issues: 1 },
    },
  ]);

  const result = await createTodayService(prisma).getTodaysWork();

  expect(result.kpi.totalStops).toBe(2);
  expect(result.kpi.completed).toBe(1);
  expect(result.kpi.skipped).toBe(1);
  expect(result.rounds).toHaveLength(1);
  expect(result.rounds[0].roundId).toBe("r1");
  expect(result.technicians).toHaveLength(1);
});

it("getTodaysWork: rounds carry scheduledValue/completedValue, value = completedValue, etaMinutes null, plus generatedAt (GAP-035)", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ lastClosedDate: null });
  const base = {
    paymentHold: false, roundId: "r1", round: { id: "r1", name: "Round 1" },
    technicianId: null, technician: null, _count: { issues: 0 },
  };
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { ...base, id: "v1", status: "COMPLETED", price: new Prisma.Decimal(25) },
    { ...base, id: "v2", status: "SCHEDULED", price: new Prisma.Decimal(12.5) },
  ]);

  const before = Date.now();
  const result = await createTodayService(prisma).getTodaysWork();

  expect(result.rounds[0]).toMatchObject({ scheduledValue: 37.5, completedValue: 25, value: 25, etaMinutes: null });
  expect(Date.parse(result.generatedAt)).toBeGreaterThanOrEqual(before - 1000);
  // CANCELLED visits (A4) never reach the aggregate.
  const where = (prisma.visit.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
  expect(where.status).toEqual({ not: "CANCELLED" });
});

it("closeDay() invalidates the cache getTodaysWork() reads, so a later getTodaysWork() sees dayClosed:true immediately", async () => {
  // Regression test for: closeDay() wrote lastClosedDate via `tx.businessSettings
  // .updateMany(...)`, which never invalidated the cache getTodaysWork() reads
  // through getCachedBusinessSettings() — a GET /today right after a successful
  // POST /today/close could report dayClosed:false for up to the cache TTL.
  // This exercises the real race end-to-end through both real methods, not a
  // mock of the cache itself.
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const svc = createTodayService(prisma);

  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    lastClosedDate: null,
  });
  const before = await svc.getTodaysWork(); // warms the cache with lastClosedDate: null
  expect(before.dayClosed).toBe(false);

  const today = before.date;
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const tx = {
      businessSettings: {
        findFirst: vi.fn().mockResolvedValue({ lastClosedDate: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      visit: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    return cb(tx);
  });

  await svc.closeDay("mark_as_skipped");

  // The real DB would now return lastClosedDate: today; the point of this
  // test is that getTodaysWork() must actually RE-fetch to see it (cache
  // invalidated), not serve the stale "null" it cached above.
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    lastClosedDate: today,
  });
  const after = await svc.getTodaysWork();
  expect(after.dayClosed).toBe(true);
});
