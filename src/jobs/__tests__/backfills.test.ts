import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { findMany: (...args: unknown[]) => tenantFindMany(...args) } },
}));

const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...args: unknown[]) => getTenantPrismaForSchema(...args),
}));

const restampFutureVisits = vi.fn();
vi.mock("../../services/visit-assignment", () => ({
  restampFutureVisits: (...args: unknown[]) => restampFutureVisits(...args),
}));

import {
  backfillCompletedStepsForTenant,
  backfillNextDueDateForTenant,
  backfillVisitTechniciansForTenant,
  forEachTenant,
  runBackfillCli,
  runCompletedStepsBackfill,
  runNextDueDateBackfill,
  runVisitTechnicianBackfill,
} from "../backfills";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const TODAY = day("2026-10-30"); // Friday

type Plan = {
  id: string;
  cleaningFrequency: string | null;
  lastCompleted: Date | null;
  property: { round: { defaultDay: string | null; frequency: string | null } | null };
  visits: Array<{ date: Date }>;
};

function makeTp(opts: { rounds?: Array<{ id: string }>; plans?: Plan[] } = {}) {
  const tp = {
    round: { findMany: vi.fn().mockResolvedValue(opts.rounds ?? []) },
    servicePlan: {
      findMany: vi.fn().mockResolvedValue(opts.plans ?? []),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
  };
  // Interactive transaction: run the callback against the same mock, and
  // propagate whatever it throws (as Prisma does after rolling back).
  tp.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tp));
  return tp as typeof tp & TenantPrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("forEachTenant", () => {
  it("runs per tenant and records failures without stopping", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }, { schemaName: "t_b" }]);
    getTenantPrismaForSchema.mockImplementation((s: string) => ({ s }));
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(7);

    const results = await forEachTenant(fn);

    expect(tenantFindMany).toHaveBeenCalledWith({ select: { schemaName: true } });
    expect(fn).toHaveBeenNthCalledWith(1, { s: "t_a" }, "t_a");
    expect(results).toEqual([
      { schemaName: "t_a", error: "Error: boom" },
      { schemaName: "t_b", result: 7 },
    ]);
  });
});

describe("backfillVisitTechniciansForTenant", () => {
  it("restamps every ACTIVE round and sums the counts", async () => {
    const tp = makeTp({ rounds: [{ id: "r1" }, { id: "r2" }] });
    restampFutureVisits.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    const res = await backfillVisitTechniciansForTenant(tp, { today: TODAY, dryRun: false });

    expect(res).toEqual({ rounds: 2, visitsUpdated: 5 });
    expect(tp.round.findMany).toHaveBeenCalledWith({ where: { status: "ACTIVE" }, select: { id: true } });
    expect(restampFutureVisits).toHaveBeenCalledWith(tp, "r1", TODAY);
    expect(tp.$transaction).not.toHaveBeenCalled();
  });

  it("dry run counts inside a transaction that is rolled back", async () => {
    const tp = makeTp({ rounds: [{ id: "r1" }] });
    restampFutureVisits.mockResolvedValueOnce(4);

    const res = await backfillVisitTechniciansForTenant(tp, { today: TODAY, dryRun: true });

    expect(res).toEqual({ rounds: 1, visitsUpdated: 4 });
    expect(tp.$transaction).toHaveBeenCalledTimes(1);
    await expect(tp.$transaction.mock.results[0].value).rejects.toThrow("dry run");
  });

  it("dry run rethrows real errors", async () => {
    const tp = makeTp({ rounds: [{ id: "r1" }] });
    restampFutureVisits.mockRejectedValueOnce(new Error("db down"));
    await expect(backfillVisitTechniciansForTenant(tp, { today: TODAY, dryRun: true })).rejects.toThrow("db down");
  });
});

describe("backfillNextDueDateForTenant", () => {
  const plan = (p: Partial<Plan> & { id: string }): Plan => ({
    cleaningFrequency: "FOUR_WEEKLY",
    lastCompleted: null,
    property: { round: { defaultDay: "MON", frequency: "FOUR_WEEKLY" } },
    visits: [],
    ...p,
  });

  it("selects only ACTIVE plans with a null nextDueDate, ignoring cancelled/skipped visits", async () => {
    const tp = makeTp();
    expect(await backfillNextDueDateForTenant(tp, { today: TODAY, dryRun: false })).toEqual({ plans: 0, updated: 0, skipped: 0 });
    expect(tp.servicePlan.findMany).toHaveBeenCalledWith({
      where: { status: "ACTIVE", nextDueDate: null },
      select: {
        id: true,
        cleaningFrequency: true,
        lastCompleted: true,
        property: { select: { round: { select: { defaultDay: true, frequency: true } } } },
        visits: {
          where: { status: { notIn: ["CANCELLED", "SKIPPED"] } },
          orderBy: { date: "desc" },
          take: 1,
          select: { date: true },
        },
      },
    });
    expect(tp.servicePlan.updateMany).not.toHaveBeenCalled();
  });

  it("computes each rule and groups updates by date", async () => {
    const tp = makeTp({
      plans: [
        // latest visit Fri 2026-11-06 + 4w = 12-04 (Fri) → Mon 2026-12-07
        plan({ id: "after-visit", visits: [{ date: day("2026-11-06") }] }),
        plan({ id: "after-visit-2", visits: [{ date: day("2026-11-06") }] }),
        // latest visit long past → next round day on/after today (Mon 11-02)
        plan({ id: "stale-visit", visits: [{ date: day("2026-01-05") }], lastCompleted: day("2026-10-20") }),
        // no visits, lastCompleted Tue 10-20 + 4w = 11-17 → Mon 11-23
        plan({ id: "from-last", lastCompleted: day("2026-10-20") }),
        // plan frequency missing → round's; round has no day → today
        plan({ id: "round-freq", cleaningFrequency: null, property: { round: { defaultDay: null, frequency: "SIX_WEEKLY" } } }),
        // no frequency anywhere → skipped
        plan({ id: "no-freq", cleaningFrequency: null, property: { round: null } }),
        // property without a round but with a plan frequency → today
        plan({ id: "no-round", property: { round: null } }),
      ],
    });

    const res = await backfillNextDueDateForTenant(tp, { today: new Date("2026-10-30T18:00:00Z"), dryRun: false });

    expect(res).toEqual({ plans: 7, updated: 6, skipped: 1 });
    const calls = Object.fromEntries(
      tp.servicePlan.updateMany.mock.calls.map(([arg]) => [arg.data.nextDueDate.toISOString().slice(0, 10), arg.where])
    );
    expect(calls).toEqual({
      "2026-12-07": { id: { in: ["after-visit", "after-visit-2"] }, nextDueDate: null },
      "2026-11-02": { id: { in: ["stale-visit"] }, nextDueDate: null },
      "2026-11-23": { id: { in: ["from-last"] }, nextDueDate: null },
      "2026-10-30": { id: { in: ["round-freq", "no-round"] }, nextDueDate: null },
    });
  });

  it("dry run reports counts without writing", async () => {
    const tp = makeTp({ plans: [plan({ id: "p1" })] });
    expect(await backfillNextDueDateForTenant(tp, { today: TODAY, dryRun: true })).toEqual({ plans: 1, updated: 1, skipped: 0 });
    expect(tp.servicePlan.updateMany).not.toHaveBeenCalled();
  });
});

describe("runVisitTechnicianBackfill / runNextDueDateBackfill", () => {
  it("iterate tenants with a UTC-midnight today", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }]);
    const tp = makeTp({ rounds: [{ id: "r1" }], plans: [] });
    getTenantPrismaForSchema.mockReturnValue(tp);
    restampFutureVisits.mockResolvedValue(1);

    expect(await runVisitTechnicianBackfill({ dryRun: false, today: new Date("2026-10-30T12:00:00Z") }))
      .toEqual([{ schemaName: "t_a", result: { rounds: 1, visitsUpdated: 1 } }]);
    expect(restampFutureVisits).toHaveBeenCalledWith(tp, "r1", TODAY);

    expect(await runNextDueDateBackfill({ dryRun: true }))
      .toEqual([{ schemaName: "t_a", result: { plans: 0, updated: 0, skipped: 0 } }]);
  });

  it("default today to now", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }]);
    getTenantPrismaForSchema.mockReturnValue(makeTp({ rounds: [{ id: "r1" }] }));
    restampFutureVisits.mockResolvedValue(0);
    await runVisitTechnicianBackfill({ dryRun: false });
    const passed = restampFutureVisits.mock.calls[0][2] as Date;
    expect(passed.getUTCHours()).toBe(0);
  });
});

describe("runBackfillCli", () => {
  it("passes --dry-run through and returns 0 when all tenants succeed", async () => {
    const run = vi.fn().mockResolvedValue([{ schemaName: "t_a", result: { n: 1 } }]);
    expect(await runBackfillCli("bf", ["--dry-run"], run)).toBe(0);
    expect(run).toHaveBeenCalledWith({ dryRun: true });
    expect(console.log).toHaveBeenCalledWith("[bf] starting (dry run — no changes will be saved)");
    expect(console.log).toHaveBeenCalledWith('[bf] t_a: {"n":1}');
  });

  it("returns 1 when any tenant failed", async () => {
    const run = vi.fn().mockResolvedValue([{ schemaName: "t_a", error: "Error: x" }]);
    expect(await runBackfillCli("bf", [], run)).toBe(1);
    expect(run).toHaveBeenCalledWith({ dryRun: false });
    expect(console.log).toHaveBeenCalledWith("[bf] starting");
    expect(console.log).toHaveBeenCalledWith("[bf] t_a: FAILED — Error: x");
  });
});

describe("backfillCompletedStepsForTenant", () => {
  type Counts = { services?: number; templates?: number; technicians?: number; areas?: number; activeRounds?: number; props?: number; visits?: number };
  function stepsTp(settings: Record<string, unknown> | null, c: Counts = {}, rounds: Array<{ roundTechnicians: unknown[] }> = []) {
    return {
      businessSettings: { findFirst: vi.fn().mockResolvedValue(settings), update: vi.fn().mockResolvedValue({}) },
      service: { count: vi.fn().mockResolvedValue(c.services ?? 0) },
      messageTemplate: { count: vi.fn().mockResolvedValue(c.templates ?? 0) },
      technician: { count: vi.fn().mockResolvedValue(c.technicians ?? 0) },
      serviceArea: { count: vi.fn().mockResolvedValue(c.areas ?? 0) },
      round: { count: vi.fn().mockResolvedValue(c.activeRounds ?? 0), findMany: vi.fn().mockResolvedValue(rounds) },
      property: { count: vi.fn().mockResolvedValue(c.props ?? 0) },
      visit: { count: vi.fn().mockResolvedValue(c.visits ?? 0) },
    } as any;
  }
  const base = { id: "bs1", setupCompleted: false, completedSteps: [] as number[], businessName: null, paymentRule: null, defaultCycleLength: null };

  it("skips tenants with no settings row or a completed setup", async () => {
    expect(await backfillCompletedStepsForTenant(stepsTp(null), { dryRun: false }))
      .toEqual({ skipped: true, before: [], after: [], added: [] });
    const done = stepsTp({ ...base, setupCompleted: true, completedSteps: [1] });
    expect(await backfillCompletedStepsForTenant(done, { dryRun: false }))
      .toEqual({ skipped: true, before: [1], after: [1], added: [] });
    expect(done.service.count).not.toHaveBeenCalled();
  });

  it("unions every step the old row-count rules considered complete", async () => {
    const tp = stepsTp(
      { ...base, completedSteps: [2], businessName: "Acme", paymentRule: "UPFRONT", defaultCycleLength: 4 },
      { services: 1, templates: 1, technicians: 1, areas: 1, activeRounds: 1, props: 1, visits: 1 },
      [{ roundTechnicians: [{ technicianId: "t1" }] }]
    );
    const res = await backfillCompletedStepsForTenant(tp, { dryRun: false });
    expect(res).toEqual({ skipped: false, before: [2], after: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], added: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
    expect(tp.businessSettings.update).toHaveBeenCalledWith({ where: { id: "bs1" }, data: { completedSteps: res.after } });
    expect(tp.round.count).toHaveBeenCalledWith({ where: { status: "ACTIVE" } });
    expect(tp.property.count).toHaveBeenCalledWith({ where: { roundId: { not: null } } });
    expect(tp.visit.count).toHaveBeenCalledWith({ where: { status: "SCHEDULED" } });
  });

  it("step 10 needs every active round assigned; dry run and no-op runs don't write", async () => {
    const tp = stepsTp({ ...base }, { services: 2 }, [{ roundTechnicians: [{ technicianId: "t1" }] }, { roundTechnicians: [] }]);
    expect(await backfillCompletedStepsForTenant(tp, { dryRun: true }))
      .toEqual({ skipped: false, before: [], after: [3], added: [3] });
    expect(tp.businessSettings.update).not.toHaveBeenCalled();

    const noop = stepsTp({ ...base, completedSteps: [3] }, { services: 2 });
    expect(await backfillCompletedStepsForTenant(noop, { dryRun: false }))
      .toEqual({ skipped: false, before: [3], after: [3], added: [] });
    expect(noop.businessSettings.update).not.toHaveBeenCalled();
  });

  it("runCompletedStepsBackfill iterates tenants", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }]);
    getTenantPrismaForSchema.mockReturnValue(stepsTp(null));
    expect(await runCompletedStepsBackfill({ dryRun: true }))
      .toEqual([{ schemaName: "t_a", result: { skipped: true, before: [], after: [], added: [] } }]);
  });
});
