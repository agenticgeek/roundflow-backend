import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: vi.fn() } } }));
vi.mock("../../lib/tenant-prisma-manager", () => ({ getTenantPrismaForSchema: vi.fn() }));

const queueGhlEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({ queueGhlEvent: (...args: unknown[]) => queueGhlEvent(...args) }));
vi.mock("../../services/service-plan-lifecycle", () => ({
  pausePlan: vi.fn().mockResolvedValue({}),
  resumePlan: vi.fn().mockResolvedValue({}),
}));

import { generateForRound, generateForTenant, CLOSURE_CYCLES_SKIPPED_ACTIVITY } from "../visitGeneration";

// Business closures in generation (rules docs/handoff/backend/2026-11-16-closure-rules.md s4, examples A, B, C).
// An in-memory tenant: plans, visits and closures live in arrays and the nightly job is run once per simulated day.

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;
const MON_FRI = ["MON", "TUE", "WED", "THU", "FRI"];
const MON_SAT = [...MON_FRI, "SAT"];
const TUE_SAT = ["TUE", "WED", "THU", "FRI", "SAT"];

interface FakePlan { id: string; propertyId: string; nextDueDate: Date; cleaningFrequency: string; pauseStartDate?: Date | null; pauseEndDate?: Date | null }
interface FakeVisit { servicePlanId: string; date: Date; status: string; isOneOff: boolean }
interface FakeClosure { id: string; label: string; startDate: Date; endDate: Date; mode: "MOVE" | "SKIP"; roundIds: string[] }
interface FakeRound { id: string; frequency: string | null; defaultDay: string | null }

let cseq = 0;
const closure = (start: string, end: string, mode: "MOVE" | "SKIP" = "MOVE", roundIds: string[] = [], label = "XMAS"): FakeClosure => ({
  id: `c${++cseq}`, label, startDate: d(start), endDate: d(end), mode, roundIds,
});
const XMAS = () => closure("2026-12-24", "2027-01-03");

function makeWorld(opts: {
  rounds?: FakeRound[];
  plans: Array<FakePlan & { roundId?: string }>;
  closures?: FakeClosure[];
  visits?: FakeVisit[];
  unavailable?: (date: Date) => string[];
  roundTechs?: string[];
}) {
  const rounds = opts.rounds ?? [{ id: "r1", frequency: null, defaultDay: "MON" }];
  const plans = opts.plans;
  const visits: FakeVisit[] = opts.visits ?? [];
  const closures = opts.closures ?? [];
  const tp: any = {
    round: { findMany: vi.fn().mockResolvedValue(rounds) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ autoCreateNextVisit: true, defaultWorkingDays: MON_FRI }) },
    businessClosure: {
      findMany: vi.fn(async ({ where }: any) => closures.filter((c) => c.endDate >= where.endDate.gte)),
    },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    roundTechnician: { findMany: vi.fn().mockResolvedValue((opts.roundTechs ?? []).map((technicianId) => ({ technicianId }))) },
    technicianAvailability: {
      findMany: vi.fn(async ({ where }: any) => (opts.unavailable?.(where.from.lte) ?? []).map((technicianId) => ({ technicianId }))),
    },
    servicePlan: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn(async ({ where, data }: any) => { plans.find((p) => p.id === where.id)!.nextDueDate = data.nextDueDate; }) },
    property: {
      findMany: vi.fn(async ({ where }: any) => {
        const mine = plans.filter((p) => (p.roundId ?? "r1") === where.roundId);
        return mine.map((p) => ({
          id: p.propertyId, customerId: `cust-${p.propertyId}`, assignedTechnicianId: null,
          servicePlans: p.nextDueDate <= where._today ? [] : [],
        }));
      }),
    },
    visit: {
      findFirst: vi.fn(async ({ where }: any) => {
        const mine = visits.filter((v) => v.servicePlanId === where.servicePlanId);
        if (where.status?.in) {
          return mine.find((v) => where.status.in.includes(v.status) && v.date >= where.date.gte) ? { id: "x" } : null;
        }
        const live = mine.filter((v) => v.status !== "CANCELLED" && v.isOneOff === false).sort((a, b) => b.date.getTime() - a.date.getTime());
        return live[0] ? { date: live[0].date } : null;
      }),
      create: vi.fn(async ({ data }: any) => { visits.push({ servicePlanId: data.servicePlanId, date: data.date, status: data.status, isOneOff: data.isOneOff }); return {}; }),
    },
  };
  // property.findMany must apply the per-day "nextDueDate <= today" filter of the real query.
  tp.property.findMany = vi.fn(async ({ where, select }: any) => {
    const lte: Date = select.servicePlans.where.nextDueDate.lte;
    const mine = plans.filter((p) => (p.roundId ?? "r1") === where.roundId);
    return mine.map((p) => ({
      id: p.propertyId, customerId: `cust-${p.propertyId}`, assignedTechnicianId: null,
      servicePlans: p.nextDueDate <= lte
        ? [{ id: p.id, price: 10, nextDueDate: p.nextDueDate, cleaningFrequency: p.cleaningFrequency, serviceId: null, pauseStartDate: p.pauseStartDate ?? null, pauseEndDate: p.pauseEndDate ?? null }]
        : [],
    }));
  });
  return { tp, plans, visits, closures, rounds };
}

/** Run the nightly job (per round, as the cron does through generateForTenant) on every day in [from, to]. */
async function simulate(world: ReturnType<typeof makeWorld>, from: string, to: string, via: "tenant" | "round" = "tenant"): Promise<void> {
  for (let t = d(from).getTime(); t <= d(to).getTime(); t += DAY_MS) {
    const today = new Date(t);
    if (via === "tenant") await generateForTenant(world.tp, today);
    else for (const r of world.rounds) await generateForRound(world.tp, r as any, today, MON_FRI);
  }
}

const visitDates = (world: ReturnType<typeof makeWorld>, planId = "p1") =>
  world.visits.filter((v) => v.servicePlanId === planId).map((v) => iso(v.date));

interface Case {
  id: string; freq: string; day: string | null; due: string; wd?: string[]; closures?: () => FakeClosure[]; visits: string[];
}

function runCase(c: Case) {
  it(`${c.id}: ${c.visits.join(", ")}`, async () => {
    const world = makeWorld({
      rounds: [{ id: "r1", frequency: c.freq, defaultDay: c.day }],
      plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d(c.due), cleaningFrequency: c.freq }],
      closures: c.closures?.() ?? [],
    });
    world.tp.businessSettings.findFirst.mockResolvedValue({ autoCreateNextVisit: true, defaultWorkingDays: c.wd ?? MON_FRI });
    await simulate(world, c.due, c.visits[c.visits.length - 1]);
    expect(visitDates(world)).toEqual(c.visits);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cseq = 0;
});

describe("A1-A5 baselines (no closures, behaviour identical to before)", () => {
  const A: Case[] = [
    { id: "A1", freq: "FOUR_WEEKLY", day: "MON", due: "2026-11-16", visits: ["2026-11-16", "2026-12-14", "2027-01-11", "2027-02-08", "2027-03-08", "2027-04-05"] },
    { id: "A2", freq: "SIX_WEEKLY", day: "MON", due: "2026-11-16", visits: ["2026-11-16", "2026-12-28", "2027-02-08", "2027-03-22"] },
    { id: "A3", freq: "EIGHT_WEEKLY", day: "TUE", due: "2026-11-17", visits: ["2026-11-17", "2027-01-12", "2027-03-09"] },
    { id: "A4", freq: "TWELVE_WEEKLY", day: "FRI", due: "2026-11-20", visits: ["2026-11-20", "2027-02-12"] },
    { id: "A5", freq: "FOUR_WEEKLY", day: null, due: "2026-11-21", visits: ["2026-11-23", "2026-12-21", "2027-01-18", "2027-02-15", "2027-03-15", "2027-04-12"] },
  ];
  A.forEach(runCase);
});

describe("B1-B19 closures in generation", () => {
  const M4 = "FOUR_WEEKLY";
  const B: Case[] = [
    { id: "B1", freq: M4, day: "MON", due: "2026-11-30", closures: () => [XMAS()], visits: ["2026-11-30", "2027-01-04", "2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"] },
    { id: "B2", freq: M4, day: "THU", due: "2026-12-03", closures: () => [XMAS()], visits: ["2026-12-03", "2027-01-07", "2027-01-28", "2027-02-25", "2027-03-25", "2027-04-22"] },
    { id: "B3", freq: M4, day: "MON", due: "2026-11-30", closures: () => [closure("2026-12-24", "2027-01-03", "SKIP")], visits: ["2026-11-30", "2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"] },
    { id: "B4", freq: M4, day: null, due: "2026-11-30", closures: () => [XMAS()], visits: ["2026-11-30", "2027-01-04", "2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"] },
    { id: "B5", freq: M4, day: null, due: "2026-12-26", wd: MON_SAT, closures: () => [XMAS()], visits: ["2027-01-04", "2027-01-23", "2027-02-20", "2027-03-20", "2027-04-17"] },
    { id: "B6", freq: M4, day: null, due: "2026-12-26", wd: TUE_SAT, closures: () => [XMAS()], visits: ["2027-01-05", "2027-01-23", "2027-02-20", "2027-03-20", "2027-04-17"] },
    { id: "B7", freq: M4, day: "MON", due: "2026-12-28", closures: () => [XMAS()], visits: ["2027-01-04", "2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"] },
    { id: "B8", freq: M4, day: "MON", due: "2026-12-28", closures: () => [closure("2026-12-24", "2027-01-04")], visits: ["2027-01-11", "2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"] },
    { id: "B9", freq: M4, day: "MON", due: "2026-12-14", closures: () => [closure("2026-12-14", "2027-01-18")], visits: ["2027-01-25", "2027-02-08", "2027-03-08", "2027-04-05"] },
    { id: "B10", freq: M4, day: "MON", due: "2026-12-14", closures: () => [closure("2026-12-14", "2027-01-18", "SKIP")], visits: ["2027-02-08", "2027-03-08", "2027-04-05"] },
    { id: "B11", freq: M4, day: "MON", due: "2026-12-28", closures: () => [XMAS(), closure("2027-01-02", "2027-01-10", "SKIP")], visits: ["2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"] },
    { id: "B12", freq: M4, day: "MON", due: "2026-12-28", closures: () => [XMAS(), closure("2027-01-04", "2027-01-10")], visits: ["2027-01-11", "2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"] },
    { id: "B13", freq: M4, day: "MON", due: "2026-12-28", closures: () => [closure("2026-12-28", "2026-12-28")], visits: ["2027-01-04", "2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"] },
    { id: "B14", freq: M4, day: null, due: "2026-12-28", closures: () => [closure("2026-12-28", "2026-12-28")], visits: ["2026-12-29", "2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"] },
    { id: "B15", freq: M4, day: "MON", due: "2026-12-28", closures: () => [closure("2026-12-29", "2026-12-29")], visits: ["2026-12-28", "2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"] },
    { id: "B16", freq: M4, day: "MON", due: "2026-12-14", closures: () => [closure("2026-12-14", "2026-12-21")], visits: ["2026-12-28", "2027-01-11", "2027-02-08", "2027-03-08", "2027-04-05"] },
    { id: "B17", freq: "SIX_WEEKLY", day: "MON", due: "2026-12-28", closures: () => [XMAS()], visits: ["2027-01-04", "2027-02-08", "2027-03-22"] },
    { id: "B18", freq: "TWELVE_WEEKLY", day: "MON", due: "2026-12-21", closures: () => [XMAS()], visits: ["2026-12-21", "2027-03-15", "2027-06-07"] },
    { id: "B19", freq: M4, day: "MON", due: "2027-01-11", closures: () => [XMAS()], visits: ["2027-01-11", "2027-02-08", "2027-03-08", "2027-04-05"] },
  ];
  B.forEach(runCase);

  it("B1 also holds when the nightly job runs round by round through generateForRound with the closures passed in", async () => {
    const world = makeWorld({
      rounds: [{ id: "r1", frequency: M4, defaultDay: "MON" }],
      plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-11-30"), cleaningFrequency: M4 }],
      closures: [XMAS()],
    });
    const windows = [{ id: "c1", label: "XMAS", startDate: d("2026-12-24"), endDate: d("2027-01-03"), mode: "MOVE" as const, roundIds: [] }];
    for (let t = d("2026-11-30").getTime(); t <= d("2027-01-04").getTime(); t += DAY_MS) {
      await generateForRound(world.tp, world.rounds[0] as any, new Date(t), MON_FRI, windows);
    }
    expect(visitDates(world)).toEqual(["2026-11-30", "2027-01-04"]);
    expect(world.tp.businessClosure.findMany).not.toHaveBeenCalled();
  });
});

describe("C1-C2 carryover and the served-cycle guard (no closures)", () => {
  it("C1: a visit carried over to Wed 11-18 does not move the cycle: next visits 12-14 and 2027-01-11", async () => {
    const world = makeWorld({ plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-11-16"), cleaningFrequency: "FOUR_WEEKLY" }] });
    await simulate(world, "2026-11-16", "2026-11-16");
    world.visits[0].date = d("2026-11-18"); // carryover
    await simulate(world, "2026-11-17", "2027-01-11");
    expect(visitDates(world)).toEqual(["2026-11-18", "2026-12-14", "2027-01-11"]);
  });

  it("C2: a visit pushed to Wed 12-16 serves the 12-14 cycle: no catch-up visit, next visits 2027-01-11 and 02-08", async () => {
    const world = makeWorld({
      plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-14"), cleaningFrequency: "FOUR_WEEKLY" }],
      visits: [{ servicePlanId: "p1", date: d("2026-12-16"), status: "SCHEDULED", isOneOff: false }],
    });
    await simulate(world, "2026-12-14", "2027-02-08");
    expect(visitDates(world)).toEqual(["2026-12-16", "2027-01-11", "2027-02-08"]);
    // the guard advanced nextDueDate by a whole cycle (12-14 -> 01-11), never re-anchored
    expect(world.plans[0].nextDueDate).toEqual(d("2027-03-08"));
  });

  it("C2 night of 12-17: the served cycle creates nothing but nextDueDate is written as 2027-01-11, then the visit is created on its day", async () => {
    const world = makeWorld({
      plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-14"), cleaningFrequency: "FOUR_WEEKLY" }],
      visits: [{ servicePlanId: "p1", date: d("2026-12-16"), status: "SCHEDULED", isOneOff: false }],
    });
    await generateForTenant(world.tp, d("2026-12-17"));
    expect(world.visits).toHaveLength(1);
    expect(world.tp.visit.create).not.toHaveBeenCalled();
    expect(world.tp.servicePlan.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { nextDueDate: d("2027-01-11") } });
    await generateForTenant(world.tp, d("2027-01-11"));
    expect(visitDates(world)).toEqual(["2026-12-16", "2027-01-11"]);
  });

  it("a served cycle is skipped and the next due cycle in the same run is created (latest visit looked up once)", async () => {
    const world = makeWorld({
      plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-14"), cleaningFrequency: "FOUR_WEEKLY" }],
      visits: [{ servicePlanId: "p1", date: d("2026-12-16"), status: "COMPLETED", isOneOff: false }],
    });
    await generateForTenant(world.tp, d("2027-01-12"));
    expect(visitDates(world)).toEqual(["2026-12-16", "2027-01-11"]);
    expect(iso(world.plans[0].nextDueDate)).toBe("2027-02-08");
    expect(world.tp.visit.findFirst).toHaveBeenCalledTimes(2); // open-visit check + one guard lookup
  });

  it("the guard ignores one-off visits and cancelled visits", async () => {
    const world = makeWorld({
      plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-14"), cleaningFrequency: "FOUR_WEEKLY" }],
      visits: [
        { servicePlanId: "p1", date: d("2026-12-16"), status: "COMPLETED", isOneOff: true },
        { servicePlanId: "p1", date: d("2026-12-17"), status: "CANCELLED", isOneOff: false },
      ],
    });
    await simulate(world, "2026-12-14", "2026-12-14");
    expect(visitDates(world)).toEqual(["2026-12-16", "2026-12-17", "2026-12-14"]);
  });
});

describe("closure loading and bookkeeping", () => {
  const plansN = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, propertyId: `prop${i + 1}`, nextDueDate: d("2026-11-30"), cleaningFrequency: "FOUR_WEEKLY" }));

  it("loads the closures ONCE per tenant run for many plans and rounds, with endDate >= today - 366 days", async () => {
    const world = makeWorld({
      rounds: [{ id: "r1", frequency: null, defaultDay: "MON" }, { id: "r2", frequency: null, defaultDay: "TUE" }],
      plans: [...plansN(5), ...plansN(5).map((p) => ({ ...p, id: `q${p.id}`, propertyId: `q${p.propertyId}`, roundId: "r2" }))],
      closures: [XMAS()],
    });
    await generateForTenant(world.tp, d("2026-11-30"));
    expect(world.tp.businessClosure.findMany).toHaveBeenCalledTimes(1);
    expect(world.tp.businessClosure.findMany).toHaveBeenCalledWith({ where: { endDate: { gte: d("2025-11-29") } } });
    expect(world.visits).toHaveLength(10);
  });

  it("generateForRound called on its own loads the closures itself, once, for all its plans", async () => {
    const world = makeWorld({ plans: plansN(4), closures: [XMAS()] });
    const created = await generateForRound(world.tp, { id: "r1", frequency: null, defaultDay: "MON" }, d("2026-11-30"), MON_FRI);
    expect(created).toBe(4);
    expect(world.tp.businessClosure.findMany).toHaveBeenCalledTimes(1);
  });

  it("a closure that ended BEFORE the cycle's own date does not affect it (B19), even if the loader returns it", async () => {
    const world = makeWorld({ plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2027-01-11"), cleaningFrequency: "FOUR_WEEKLY" }], closures: [XMAS()] });
    await generateForTenant(world.tp, d("2027-01-11"));
    expect(visitDates(world)).toEqual(["2027-01-11"]);
  });

  it("closures that ended more than 366 days ago are dropped client side too", async () => {
    const world = makeWorld({ plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2027-01-11"), cleaningFrequency: "FOUR_WEEKLY" }] });
    world.tp.businessClosure.findMany.mockResolvedValue([{ id: "old", label: "old", startDate: d("2026-01-05"), endDate: d("2026-01-12"), mode: "SKIP", roundIds: [] }]);
    await generateForTenant(world.tp, d("2027-01-11"));
    expect(visitDates(world)).toEqual(["2027-01-11"]);
  });

  it("B20: the job first runs on 2027-01-10, after XMAS ended: one catch-up visit dated 2027-01-04, nextDueDate 2027-01-25", async () => {
    const world = makeWorld({ plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-28"), cleaningFrequency: "FOUR_WEEKLY" }], closures: [XMAS()] });
    await generateForTenant(world.tp, d("2027-01-10"));
    expect(visitDates(world)).toEqual(["2027-01-04"]);
    expect(iso(world.plans[0].nextDueDate)).toBe("2027-01-25");
  });

  it("round-scoped closures only affect their round (two rounds, same dates)", async () => {
    const world = makeWorld({
      rounds: [{ id: "r1", frequency: null, defaultDay: "MON" }, { id: "r2", frequency: null, defaultDay: "MON" }],
      plans: [
        { id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-28"), cleaningFrequency: "FOUR_WEEKLY" },
        { id: "p2", propertyId: "prop2", nextDueDate: d("2026-12-28"), cleaningFrequency: "FOUR_WEEKLY", roundId: "r2" },
      ],
      closures: [closure("2026-12-24", "2027-01-03", "MOVE", ["r2"])],
    });
    await simulate(world, "2026-12-28", "2027-01-04");
    expect(visitDates(world, "p1")).toEqual(["2026-12-28"]);
    expect(visitDates(world, "p2")).toEqual(["2027-01-04"]);
  });

  it("two plans of one round resolve independently (one moved, one served-cycle skipped)", async () => {
    const world = makeWorld({
      plans: [
        { id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-28"), cleaningFrequency: "FOUR_WEEKLY" },
        { id: "p2", propertyId: "prop2", nextDueDate: d("2026-12-28"), cleaningFrequency: "FOUR_WEEKLY" },
      ],
      visits: [{ servicePlanId: "p2", date: d("2027-01-04"), status: "COMPLETED", isOneOff: false }],
      closures: [XMAS()],
    });
    await simulate(world, "2026-12-28", "2027-01-04");
    expect(visitDates(world, "p1")).toEqual(["2027-01-04"]);
    expect(visitDates(world, "p2")).toEqual(["2027-01-04"]); // only the pre-existing one: the cycle is served
    expect(world.plans.map((p) => iso(p.nextDueDate))).toEqual(["2027-01-25", "2027-01-25"]);
  });

  it("SKIP: no visit, no GHL event, nextDueDate advanced from the raw date; one activity row per closure per run", async () => {
    const skip = closure("2026-12-14", "2027-01-18", "SKIP", [], "Refit");
    const world = makeWorld({
      plans: [
        { id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-14"), cleaningFrequency: "FOUR_WEEKLY" },
        { id: "p2", propertyId: "prop2", nextDueDate: d("2026-12-14"), cleaningFrequency: "FOUR_WEEKLY" },
      ],
      closures: [skip],
    });
    await generateForTenant(world.tp, d("2026-12-14"));
    expect(world.visits).toHaveLength(0);
    expect(queueGhlEvent).not.toHaveBeenCalled();
    expect(world.plans.map((p) => iso(p.nextDueDate))).toEqual(["2027-01-11", "2027-01-11"]);
    expect(world.tp.activityLog.create).toHaveBeenCalledTimes(1);
    expect(world.tp.activityLog.create).toHaveBeenCalledWith({
      data: {
        type: CLOSURE_CYCLES_SKIPPED_ACTIVITY,
        message: 'Closure "Refit" skipped 2 visit cycles',
        details: { closureId: skip.id, count: 2, skippedDates: ["2026-12-14", "2026-12-14"] },
      },
    });
  });

  it("SKIP keeps evaluating while the next cycle is also due: two cycles skipped in one night, nextDueDate 02-08", async () => {
    const skip = closure("2026-12-14", "2027-01-18", "SKIP", [], "Refit");
    const world = makeWorld({ plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-14"), cleaningFrequency: "FOUR_WEEKLY" }], closures: [skip] });
    await generateForTenant(world.tp, d("2027-01-12"));
    expect(world.visits).toHaveLength(0);
    expect(iso(world.plans[0].nextDueDate)).toBe("2027-02-08");
    expect(world.tp.activityLog.create.mock.calls[0][0].data.details).toEqual({ closureId: skip.id, count: 2, skippedDates: ["2026-12-14", "2027-01-11"] });
  });

  it("a single skipped cycle says 'cycle' and a direct generateForRound writes its own log row", async () => {
    const skip = closure("2026-12-24", "2027-01-03", "SKIP", [], "XMAS");
    const world = makeWorld({ plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-28"), cleaningFrequency: "FOUR_WEEKLY" }], closures: [skip] });
    await generateForRound(world.tp, world.rounds[0] as any, d("2026-12-28"), MON_FRI);
    expect(world.tp.activityLog.create.mock.calls[0][0].data.message).toBe('Closure "XMAS" skipped 1 visit cycle');
    expect(world.tp.activityLog.create).toHaveBeenCalledTimes(1);
  });

  it("writes no activity row when nothing was skipped", async () => {
    const world = makeWorld({ plans: plansN(1), closures: [XMAS()] });
    await generateForTenant(world.tp, d("2026-11-30"));
    expect(world.tp.activityLog.create).not.toHaveBeenCalled();
  });

  it("MOVE: the visit is on the moved date, the GHL event carries it, nextDueDate is advanced from the original date", async () => {
    const world = makeWorld({ plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-28"), cleaningFrequency: "FOUR_WEEKLY" }], closures: [XMAS()] });
    await generateForTenant(world.tp, d("2026-12-28"));
    expect(iso(world.visits[0].date)).toBe("2027-01-04");
    expect(queueGhlEvent).toHaveBeenCalledWith(world.tp, "visit.scheduled", "cust-prop1", { nextCleanDate: "2027-01-04" });
    expect(iso(world.plans[0].nextDueDate)).toBe("2027-01-25");
  });

  it("technician availability is looked up on the MOVED date", async () => {
    const world = makeWorld({
      plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-28"), cleaningFrequency: "FOUR_WEEKLY" }],
      closures: [XMAS()],
      roundTechs: ["t1"],
      unavailable: (date) => (iso(date) === "2026-12-28" ? ["t1"] : []),
    });
    await generateForTenant(world.tp, d("2026-12-28"));
    // t1 is only off on the original (closed) day, so the moved visit keeps the technician
    expect(world.tp.visit.create.mock.calls[0][0].data.technicianId).toBe("t1");
    expect(world.tp.technicianAvailability.findMany.mock.calls.map((c: any) => iso(c[0].where.from.lte))).toEqual(["2027-01-04"]);
  });

  it("a pause window is checked against the RESOLVED date: a moved visit inside the pause creates nothing and leaves nextDueDate alone", async () => {
    const world = makeWorld({
      plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-28"), cleaningFrequency: "FOUR_WEEKLY", pauseStartDate: d("2027-01-04"), pauseEndDate: d("2027-01-10") }],
      closures: [XMAS()],
    });
    await generateForTenant(world.tp, d("2026-12-28"));
    expect(world.visits).toHaveLength(0);
    expect(world.tp.servicePlan.update).not.toHaveBeenCalled();
  });

  it("a pause that covers only the original day does not block the moved visit", async () => {
    const world = makeWorld({
      plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-28"), cleaningFrequency: "FOUR_WEEKLY", pauseStartDate: d("2026-12-27"), pauseEndDate: d("2026-12-30") }],
      closures: [XMAS()],
    });
    await generateForTenant(world.tp, d("2026-12-28"));
    expect(visitDates(world)).toEqual(["2027-01-04"]);
  });

  it("a skipped cycle followed by a pause still saves the advanced nextDueDate", async () => {
    const world = makeWorld({
      plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-12-14"), cleaningFrequency: "FOUR_WEEKLY", pauseStartDate: d("2027-01-25"), pauseEndDate: null }],
      closures: [closure("2026-12-14", "2026-12-20", "SKIP")],
    });
    await generateForTenant(world.tp, d("2026-12-14"));
    expect(world.visits).toHaveLength(0);
    expect(iso(world.plans[0].nextDueDate)).toBe("2027-01-11");
  });
});

describe("C-style multi-night loops across SKIP closures", () => {
  it("never creates a visit on a closed day over a full year, for every round-day", async () => {
    for (const day of ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN", null]) {
      const world = makeWorld({
        rounds: [{ id: "r1", frequency: "FOUR_WEEKLY", defaultDay: day }],
        plans: [{ id: "p1", propertyId: "prop1", nextDueDate: d("2026-11-16"), cleaningFrequency: "FOUR_WEEKLY" }],
        closures: [XMAS(), closure("2027-03-01", "2027-03-14", "SKIP")],
      });
      await simulate(world, "2026-11-16", "2027-06-30");
      for (const v of world.visits) {
        expect(v.date >= d("2026-12-24") && v.date <= d("2027-01-03")).toBe(false);
        expect(v.date >= d("2027-03-01") && v.date <= d("2027-03-14")).toBe(false);
      }
      const dates = world.visits.map((v) => v.date.getTime());
      expect(new Set(dates).size).toBe(dates.length);
    }
  });
});
