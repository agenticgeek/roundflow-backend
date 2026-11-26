import { describe, it, expect, vi, beforeEach } from "vitest";

// Move a round date (POST /rounds/:id/move-occurrence and its preview). An in-memory tenant: rounds, properties,
// plans, visits and closures live in arrays and the Prisma calls of the service, the planner projection and the
// nightly generator are answered from them, so a forecast move can be followed by real generation runs.

const h = vi.hoisted(() => ({
  today: new Date("2026-11-25T00:00:00.000Z"),
  lastClosedDate: null as string | null,
  noSettings: false,
  workingDays: ["MON", "TUE", "WED", "THU", "FRI"],
  send: vi.fn(),
  ghl: vi.fn(),
  notifyTech: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: vi.fn() } } }));
vi.mock("../../lib/tenant-prisma-manager", () => ({ getTenantPrismaForSchema: vi.fn() }));
vi.mock("../business-time", () => ({
  tenantToday: async () => h.today,
  tenantTodayRange: async () => ({ start: h.today, end: new Date(h.today.getTime() + 86_400_000) }),
  tenantWorkingDays: async () => ["MON", "TUE", "WED", "THU", "FRI"],
}));
vi.mock("../settings.service", () => ({
  getCachedBusinessSettings: async () =>
    h.noSettings ? null : { defaultWorkingDays: h.workingDays, lastClosedDate: h.lastClosedDate },
}));
vi.mock("../message.service", () => ({ createMessageService: () => ({ send: h.send }) }));
vi.mock("../../integrations/ghl/sync", () => ({ queueGhlEvent: (...a: unknown[]) => h.ghl(...a) }));
vi.mock("../notify", () => ({
  notifyVisitTechnicians: (...a: unknown[]) => h.notifyTech(...a),
  notifyEvent: vi.fn(),
  visitCount: (n: number) => `${n} ${n === 1 ? "visit" : "visits"}`,
}));
vi.mock("../service-plan-lifecycle", () => ({ pausePlan: vi.fn(), resumePlan: vi.fn() }));

import { createRoundMoveService, ACTIVITY_VISITS_MOVED } from "../round-move.service";
import { generateForRound } from "../../jobs/visitGeneration";
import { AppError } from "../../lib/app-error";
import { projectOccurrences } from "../round-projection";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;
const MON_FRI = ["MON", "TUE", "WED", "THU", "FRI"];

// ---- a tiny Prisma stand-in -----------------------------------------------------------------------------------------

type Row = Record<string, any>;
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
const isCond = (c: unknown) => c !== null && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c);

function fieldMatches(v: any, cond: any): boolean {
  if (!isCond(cond)) return same(v, cond);
  if ("in" in cond && !cond.in.some((x: unknown) => same(v, x))) return false;
  if ("notIn" in cond && cond.notIn.some((x: unknown) => same(v, x))) return false;
  if ("not" in cond && same(v, cond.not)) return false;
  if ("gte" in cond && !(v !== null && v >= cond.gte)) return false;
  if ("gt" in cond && !(v !== null && v > cond.gt)) return false;
  if ("lte" in cond && !(v !== null && v <= cond.lte)) return false;
  if ("lt" in cond && !(v !== null && v < cond.lt)) return false;
  return true;
}

function makeTable(rows: Row[], relations: Record<string, (r: Row) => Row | undefined> = {}) {
  const matches = (r: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, c]) => {
      if (c === undefined) return true;
      if (relations[k]) return matches(relations[k](r) ?? {}, c);
      return fieldMatches(r[k], c);
    });
  const withRelations = (r: Row) => {
    const out: Row = { ...r };
    for (const [k, get] of Object.entries(relations)) out[k] = get(r);
    return out;
  };
  const sorted = (list: Row[], orderBy?: Row) => {
    if (!orderBy) return list;
    const [[key, dir]] = Object.entries(orderBy);
    return [...list].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (dir === "desc" ? -1 : 1));
  };
  return {
    rows,
    matches,
    findMany: vi.fn(async (args: Row = {}) => sorted(rows.filter((r) => matches(r, args.where)), args.orderBy).map(withRelations)),
    findFirst: vi.fn(async (args: Row = {}) => {
      const hit = sorted(rows.filter((r) => matches(r, args.where)), args.orderBy)[0];
      return hit ? withRelations(hit) : null;
    }),
    findUnique: vi.fn(async (args: Row) => {
      const hit = rows.find((r) => matches(r, args.where));
      return hit ? withRelations(hit) : null;
    }),
    count: vi.fn(async (args: Row = {}) => rows.filter((r) => matches(r, args.where)).length),
    groupBy: vi.fn(async (args: Row) => {
      const groups = new Map<string, Row[]>();
      for (const r of rows.filter((x) => matches(x, args.where))) {
        const key = args.by.map((k: string) => String(r[k] instanceof Date ? r[k].getTime() : r[k])).join("|");
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      return [...groups.values()].map((g) => {
        const out: Row = {};
        for (const k of args.by) out[k] = g[0][k];
        if (args._max) {
          out._max = {};
          for (const k of Object.keys(args._max)) out._max[k] = g.reduce((m: any, r) => (m === null || r[k] > m ? r[k] : m), null);
        }
        return out;
      });
    }),
    create: vi.fn(async (args: Row) => {
      const row = { id: `${args.data.servicePlanId ?? "row"}-new-${rows.length}`, skipReason: null, reminderSentAt: null, reminderSentTypes: [], ...args.data };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async (args: Row) => {
      const row = rows.find((r) => matches(r, args.where))!;
      Object.assign(row, args.data);
      return row;
    }),
    updateMany: vi.fn(async (args: Row) => {
      const hit = rows.filter((r) => matches(r, args.where));
      for (const r of hit) Object.assign(r, args.data);
      return { count: hit.length };
    }),
  };
}

interface WorldOpts {
  round?: Partial<Row>;
  plans?: Row[];
  visits?: Row[];
  closures?: Row[];
}

const dec = (n: number) => ({ toNumber: () => n, valueOf: () => n });

function makeWorld(opts: WorldOpts = {}) {
  const rounds = [{ id: "r1", name: "North", frequency: "FOUR_WEEKLY", defaultDay: "MON", status: "ACTIVE", ...opts.round }];
  const properties: Row[] = ["A", "B", "C"].map((p) => ({
    id: `prop${p}`, roundId: "r1", status: "ACTIVE", customerId: `cust${p}`, assignedTechnicianId: null, addressLine1: `${p} Street`,
  }));
  const plan = (id: string, propertyId: string, nextDueDate: string, cleaningFrequency: string | null) => ({
    id, propertyId, status: "ACTIVE", nextDueDate: d(nextDueDate), cleaningFrequency, price: dec(20), serviceId: null,
    pauseStartDate: null, pauseEndDate: null,
  });
  const plans: Row[] = opts.plans ?? [
    plan("pA", "propA", "2026-12-28", "FOUR_WEEKLY"),
    plan("pB", "propB", "2026-12-28", null),
    plan("pC1", "propC", "2026-12-28", "FOUR_WEEKLY"),
    // Property C also has a plan on its own (six-weekly) frequency.
    plan("pC2", "propC", "2027-01-11", "SIX_WEEKLY"),
  ];
  let seq = 0;
  const visit = (planId: string, propertyId: string, date: string, status: string, extra: Row = {}) => ({
    id: `v${++seq}`, propertyId, roundId: "r1", servicePlanId: planId, date: d(date), status, isOneOff: false,
    skipReason: null, technicianId: "t1", reminderSentAt: null, reminderSentTypes: [], price: dec(20), ...extra,
  });
  const visits: Row[] = opts.visits ?? [
    // The previous round date: done.
    visit("pA", "propA", "2026-11-02", "COMPLETED"),
    visit("pB", "propB", "2026-11-02", "COMPLETED"),
    visit("pC1", "propC", "2026-11-02", "COMPLETED"),
    // The next real round date: Mon 30 Nov.
    visit("pA", "propA", "2026-11-30", "SCHEDULED", { reminderSentAt: new Date("2026-11-28T09:00:00Z"), reminderSentTypes: ["SMS"] }),
    visit("pB", "propB", "2026-11-30", "SKIPPED", { skipReason: "Gate locked" }),
    visit("pC1", "propC", "2026-11-30", "SCHEDULED"),
    visit("pC2", "propC", "2026-11-30", "SCHEDULED"),
  ];
  const closures = opts.closures ?? [
    { id: "k1", label: "Xmas party", startDate: d("2026-12-07"), endDate: d("2026-12-11"), mode: "MOVE", roundIds: [] },
  ];

  const propertyOf = (r: Row) => properties.find((p) => p.id === r.propertyId);
  const visitTable = makeTable(visits, { property: propertyOf });
  const planTable = makeTable(plans, { property: propertyOf });
  const propertyTable = makeTable(properties);
  // Generation reads each property with its due plans nested.
  const propertyFindMany = propertyTable.findMany;
  propertyTable.findMany = vi.fn(async (args: Row = {}) => {
    const list = await propertyFindMany(args);
    const nested = args.select?.servicePlans?.where;
    return nested ? list.map((p: Row) => ({ ...p, servicePlans: plans.filter((x) => x.propertyId === p.id && planTable.matches(x, nested)) })) : list;
  });
  const activity: Row[] = [];
  const tp: any = {
    round: makeTable(rounds),
    property: propertyTable,
    servicePlan: planTable,
    visit: visitTable,
    businessClosure: makeTable(closures),
    roundTechnician: { findMany: vi.fn(async () => []) },
    technicianAvailability: { findMany: vi.fn(async () => []) },
    integrationOutbox: { updateMany: vi.fn(async () => ({ count: 0 })) },
    activityLog: { create: vi.fn(async ({ data }: Row) => { activity.push(data); return data; }) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tp)),
  };
  return { tp, rounds, plans, visits, activity, svc: createRoundMoveService(tp) };
}

/** The nightly generator for round r1 on every day in [from, to]. */
async function simulate(world: ReturnType<typeof makeWorld>, from: string, to: string): Promise<void> {
  for (let t = d(from).getTime(); t <= d(to).getTime(); t += DAY_MS) {
    await generateForRound(world.tp, world.rounds[0] as any, new Date(t), MON_FRI);
  }
}

const planVisits = (world: ReturnType<typeof makeWorld>, planId: string) =>
  world.visits.filter((v) => v.servicePlanId === planId && v.status !== "CANCELLED").map((v) => iso(v.date)).sort();

async function moveError(world: ReturnType<typeof makeWorld>, fromDate: string, toDate: string): Promise<AppError> {
  try {
    await world.svc.move("r1", { fromDate: d(fromDate), toDate: d(toDate), notifyCustomers: true });
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected the move to be rejected");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.today = d("2026-11-25");
  h.lastClosedDate = null;
  h.noSettings = false;
  h.workingDays = ["MON", "TUE", "WED", "THU", "FRI"];
  h.send.mockResolvedValue({ id: "m1" });
  h.ghl.mockResolvedValue(undefined);
  h.notifyTech.mockResolvedValue(undefined);
});

// ---- a real date --------------------------------------------------------------------------------------------------

describe("moving a real round date", () => {
  it("moves later: every SCHEDULED/SKIPPED visit on the date, as the per-visit reschedule does", async () => {
    const world = makeWorld();
    const result = await world.svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-12-02"), notifyCustomers: true, actor: { id: "u1", role: "ADMIN" } });

    expect(result).toEqual({
      fromDate: "2026-11-30", toDate: "2026-12-02", kind: "REAL", movedVisits: 4, createdVisits: 0,
      notifiedCustomers: 3, customerNotificationError: null, warning: null,
    });
    const moved = world.visits.filter((v) => iso(v.date) === "2026-12-02");
    expect(moved).toHaveLength(4);
    for (const v of moved) {
      expect(v.status).toBe("SCHEDULED");
      expect(v.skipReason).toBeNull();
      expect(v.reminderSentAt).toBeNull();
      expect(v.reminderSentTypes).toEqual([]);
    }
    // Pending pre-clean messages for the old date are cancelled.
    expect(world.tp.integrationOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "pending", eventType: "message.send" }) })
    );
    // Completed history is untouched; the plans keep their cycle.
    expect(world.visits.filter((v) => iso(v.date) === "2026-11-02")).toHaveLength(3);
    expect(world.plans.map((p) => iso(p.nextDueDate))).toEqual(["2026-12-28", "2026-12-28", "2026-12-28", "2027-01-11"]);
    // One activity row, GHL "visit.scheduled" once per customer, technicians told.
    expect(world.activity).toEqual([
      expect.objectContaining({ type: ACTIVITY_VISITS_MOVED, actorId: "u1", actorRole: "ADMIN", entityId: "r1" }),
    ]);
    expect(world.activity[0].details).toEqual(expect.objectContaining({ fromDate: "2026-11-30", toDate: "2026-12-02", kind: "REAL", propertyCount: 3 }));
    expect(h.ghl).toHaveBeenCalledTimes(3);
    expect(h.ghl).toHaveBeenCalledWith(world.tp, "visit.scheduled", "custA", { nextCleanDate: "2026-12-02" });
    expect(h.notifyTech).toHaveBeenCalledTimes(1);
  });

  it("aborts the whole move when a visit changed meanwhile", async () => {
    const world = makeWorld();
    world.tp.visit.updateMany = vi.fn(async () => ({ count: 3 }));
    const err = await moveError(world, "2026-11-30", "2026-12-02");
    expect(err.code).toBe("OCCURRENCE_CHANGED");
    expect(world.activity).toEqual([]);
  });

  it("tells the moved visits' technicians the new date", async () => {
    await makeWorld().svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-12-02"), notifyCustomers: false });
    const [, refs, message] = h.notifyTech.mock.calls[0];
    expect(refs).toHaveLength(4);
    expect(message({ count: 4, first: "2026-12-02" })).toEqual({ type: "SCHEDULE", title: "A round date was moved", body: "Moved from 2026-11-30 to 2026-12-02." });
  });

  it("moves earlier, today included", async () => {
    const world = makeWorld();
    const result = await world.svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-11-25"), notifyCustomers: false });
    expect(result.movedVisits).toBe(4);
    expect(world.visits.filter((v) => iso(v.date) === "2026-11-25")).toHaveLength(4);
  });

  it("moves today's date onto a later day", async () => {
    const world = makeWorld();
    for (const v of world.visits) if (iso(v.date) === "2026-11-30") v.date = d("2026-11-25");
    const result = await world.svc.move("r1", { fromDate: d("2026-11-25"), toDate: d("2026-11-27"), notifyCustomers: false });
    expect(result).toEqual(expect.objectContaining({ kind: "REAL", movedVisits: 4 }));
  });

  it("rejects a target in the past", async () => {
    const err = await moveError(makeWorld(), "2026-11-30", "2026-11-24");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("DATE_IN_PAST");
  });

  it("rejects the same date", async () => {
    const err = await moveError(makeWorld(), "2026-11-30", "2026-11-30");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("SAME_DATE");
  });

  it("rejects today once the operational day is closed", async () => {
    h.lastClosedDate = "2026-11-25";
    const err = await moveError(makeWorld(), "2026-11-30", "2026-11-25");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("DAY_CLOSED");
  });

  it("rejects a date inside a closure and names it", async () => {
    const err = await moveError(makeWorld(), "2026-11-30", "2026-12-08");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("DATE_IN_CLOSURE");
    expect(err.message).toContain("Xmas party");
  });

  it("ignores a closure for another round", async () => {
    const world = makeWorld({
      closures: [{ id: "k2", label: "Other", startDate: d("2026-12-07"), endDate: d("2026-12-11"), mode: "MOVE", roundIds: ["r9"] }],
    });
    const result = await world.svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-12-08"), notifyCustomers: false });
    expect(result.movedVisits).toBe(4);
  });

  it("rejects pushing past the following (forecast) date", async () => {
    const world = makeWorld();
    const err = await moveError(world, "2026-11-30", "2026-12-28");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("OUTSIDE_MOVE_WINDOW");
    expect(err.message).toContain("2026-12-27");
    expect(world.visits.filter((v) => iso(v.date) === "2026-11-30")).toHaveLength(4);
  });

  it("rejects pushing past the following real date", async () => {
    const world = makeWorld();
    world.visits.push({ ...world.visits[3], id: "vX", date: d("2026-12-14"), status: "SCHEDULED" });
    const err = await moveError(world, "2026-11-30", "2026-12-14");
    expect(err.code).toBe("OUTSIDE_MOVE_WINDOW");
  });

  it("with no next date in the projection, allows up to one round cycle less a day", async () => {
    const world = makeWorld({ round: { frequency: "SIX_WEEKLY" }, plans: [] });
    const preview = await world.svc.preview("r1", d("2026-11-30"));
    expect(preview.latestDate).toBe("2027-01-10");
    expect((await moveError(world, "2026-11-30", "2027-01-11")).code).toBe("OUTSIDE_MOVE_WINDOW");
    const ok = await world.svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2027-01-08"), notifyCustomers: false });
    expect(ok.movedVisits).toBe(4);
  });

  it("falls back to the plans' frequency, then four weeks, when the round has none", async () => {
    // An archived round has no forecast; the shortest frequency among the moved visits' plans is six-weekly.
    const world = makeWorld({ round: { frequency: null, status: "ARCHIVED" } });
    for (const p of world.plans) p.cleaningFrequency = p.id === "pB" ? null : p.id === "pC2" ? "SIX_WEEKLY" : "EIGHT_WEEKLY";
    expect((await world.svc.preview("r1", d("2026-11-30"))).latestDate).toBe("2027-01-10");
    const bare = makeWorld({ round: { frequency: null, status: "ARCHIVED" }, plans: [] });
    bare.visits.push({ ...bare.visits[3], id: "vOneOff", servicePlanId: null, isOneOff: true });
    expect((await bare.svc.preview("r1", d("2026-11-30"))).latestDate).toBe("2026-12-27");
  });

  it("rejects a property whose own visit elsewhere would clash", async () => {
    // Property A has an unfinished visit off the round on 4 Dec: the round's date cannot be pushed onto or past it.
    const world = makeWorld();
    world.visits.push({ ...world.visits[3], id: "vOff", roundId: null, date: d("2026-12-04"), status: "SCHEDULED" });
    const err = await moveError(world, "2026-11-30", "2026-12-04");
    expect(err.code).toBe("PROPERTY_CLEAN_CLASH");
    expect(err.message).toBe("1 property would get two cleans too close together");
  });

  it("404s for an unknown round", async () => {
    const err = await makeWorld().svc.move("nope", { fromDate: d("2026-11-30"), toDate: d("2026-12-02"), notifyCustomers: false }).catch((e) => e);
    expect(err.statusCode).toBe(404);
  });

  it("rejects a date with nothing on it, a finished date and a past date", async () => {
    const world = makeWorld();
    expect((await moveError(world, "2026-12-02", "2026-12-03")).code).toBe("OCCURRENCE_NOT_MOVABLE");
    for (const v of world.visits) if (iso(v.date) === "2026-11-30") v.status = "COMPLETED";
    expect((await moveError(world, "2026-11-30", "2026-12-03")).code).toBe("OCCURRENCE_NOT_MOVABLE");
    const past = makeWorld();
    past.visits.push({ ...past.visits[3], id: "vOld", date: d("2026-11-23"), status: "SCHEDULED" });
    const err = await moveError(past, "2026-11-23", "2026-11-26");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("OCCURRENCE_NOT_MOVABLE");
  });
});

// ---- the next forecast date ---------------------------------------------------------------------------------------

describe("moving the next forecast date", () => {
  it("creates each due plan's visit on the new date once, advances nextDueDate from the ORIGINAL date, and generation never recreates it", async () => {
    const world = makeWorld();
    const result = await world.svc.move("r1", { fromDate: d("2026-12-28"), toDate: d("2026-12-22"), notifyCustomers: true });

    expect(result).toEqual({
      fromDate: "2026-12-28", toDate: "2026-12-22", kind: "FORECAST", movedVisits: 0, createdVisits: 3,
      notifiedCustomers: 3, customerNotificationError: null, warning: null,
    });
    const created = world.visits.filter((v) => iso(v.date) === "2026-12-22");
    expect(created.map((v) => v.servicePlanId).sort()).toEqual(["pA", "pB", "pC1"]);
    for (const v of created) {
      expect(v).toEqual(expect.objectContaining({ roundId: "r1", status: "SCHEDULED", isOneOff: false, paymentHold: false }));
    }
    // One cycle from the original 28 Dec, not from 22 Dec; the six-weekly plan is untouched.
    expect(Object.fromEntries(world.plans.map((p) => [p.id, iso(p.nextDueDate)]))).toEqual({
      pA: "2027-01-25", pB: "2027-01-25", pC1: "2027-01-25", pC2: "2027-01-11",
    });
    expect(h.ghl).toHaveBeenCalledWith(world.tp, "visit.scheduled", "custC", { nextCleanDate: "2026-12-22" });
    expect(world.activity[0]).toEqual(expect.objectContaining({ type: ACTIVITY_VISITS_MOVED }));

    // The nightly job, day by day: nothing new for the moved cycle; the next cycle lands on the original phase.
    await simulate(world, "2026-11-25", "2027-01-25");
    expect(planVisits(world, "pA")).toEqual(["2026-11-02", "2026-11-30", "2026-12-22", "2027-01-25"]);
    expect(planVisits(world, "pB")).toEqual(["2026-11-02", "2026-11-30", "2026-12-22", "2027-01-25"]);
    expect(planVisits(world, "pC2")).toEqual(["2026-11-30", "2027-01-11"]);

    // The date is no longer a forecast: moving it again is refused (visits are created exactly once).
    expect((await moveError(world, "2026-12-28", "2026-12-23")).code).toBe("OCCURRENCE_NOT_MOVABLE");
  });

  it("moves later inside the window, staffing the new visits like generation", async () => {
    const world = makeWorld();
    world.tp.roundTechnician.findMany = vi.fn(async () => [{ technicianId: "t1" }]);
    const result = await world.svc.move("r1", { fromDate: d("2026-12-28"), toDate: d("2027-01-08"), notifyCustomers: false });
    expect(result.createdVisits).toBe(3);
    expect(world.plans.find((p) => p.id === "pA")!.nextDueDate).toEqual(d("2027-01-25"));
    expect(world.visits.filter((v) => iso(v.date) === "2027-01-08").map((v) => v.technicianId)).toEqual(["t1", "t1", "t1"]);
  });

  it("rejects pulling it in front of the unfinished earlier date", async () => {
    const world = makeWorld();
    const err = await moveError(world, "2026-12-28", "2026-11-27");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("OUTSIDE_MOVE_WINDOW");
    expect(world.visits).toHaveLength(7);
  });

  it("rejects pushing it onto the following forecast date", async () => {
    expect((await moveError(makeWorld(), "2026-12-28", "2027-01-25")).code).toBe("OUTSIDE_MOVE_WINDOW");
  });

  it("rejects a property whose plan on its own frequency would clash", async () => {
    const world = makeWorld();
    // Property C's six-weekly plan is due 11 Jan: its four-weekly clean cannot land on or after it.
    const err = await moveError(world, "2026-12-28", "2027-01-12");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("PROPERTY_CLEAN_CLASH");
    expect(err.message).toBe("1 property would get two cleans too close together");
    expect(world.plans.find((p) => p.id === "pA")!.nextDueDate).toEqual(d("2026-12-28"));
    expect(world.visits).toHaveLength(7);
  });

  it("counts every clashing property", async () => {
    const world = makeWorld();
    for (const p of ["propA", "propB"]) {
      world.visits.push({ ...world.visits[3], id: `off-${p}`, propertyId: p, roundId: null, date: d("2026-12-17"), status: "SKIPPED" });
    }
    const err = await moveError(world, "2026-12-28", "2026-12-16");
    expect(err.message).toBe("2 properties would get two cleans too close together");
  });

  it("moves an overdue forecast (shown today) with no earlier round date", async () => {
    h.noSettings = true;
    const world = makeWorld({ plans: [], visits: [] });
    world.plans.push({ ...makeWorld().plans[0], nextDueDate: d("2026-11-16") });
    // Another plan on the same property, never visited, due in the new year.
    world.plans.push({ ...makeWorld().plans[0], id: "pX", nextDueDate: d("2027-01-11") });
    const preview = await world.svc.preview("r1", d("2026-11-25"));
    expect(preview).toEqual(expect.objectContaining({ kind: "FORECAST", propertyCount: 1, earliestDate: "2026-11-25" }));
    await world.svc.move("r1", { fromDate: d("2026-11-25"), toDate: d("2026-11-26"), notifyCustomers: false });
    expect(world.activity[0].message).toBe("Round North: 2026-11-25 moved to 2026-11-26 (1 property)");
    expect(world.plans[0].nextDueDate).toEqual(d("2026-12-14"));
  });

  it("leaves out a plan whose cycles a long SKIP closure swallows", async () => {
    const world = makeWorld({
      visits: [],
      closures: [{ id: "k9", label: "Gone", startDate: d("2026-12-01"), endDate: d("2037-12-31"), mode: "SKIP", roundIds: [] }],
    });
    world.plans.splice(1); // pA: four-weekly, its 120 cycles all fall inside the closure
    world.plans.push({ ...world.plans[0], id: "pT", propertyId: "propB", cleaningFrequency: "TWELVE_WEEKLY" });
    const first = (await projectOccurrences(world.tp, ["r1"], h.today)).get("r1")![0].date;
    const preview = await world.svc.preview("r1", d(first));
    expect(preview).toEqual(expect.objectContaining({ kind: "FORECAST", propertyCount: 1 }));
  });

  it("leaves out a plan with no frequency when the round has none", async () => {
    const world = makeWorld({ round: { frequency: null } });
    const preview = await world.svc.preview("r1", d("2026-12-28"));
    expect(preview).toEqual(expect.objectContaining({ kind: "FORECAST", propertyCount: 2 }));
  });

  it("rejects a forecast date that is not the round's next one", async () => {
    const err = await moveError(makeWorld(), "2027-01-25", "2027-01-27");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("OCCURRENCE_NOT_MOVABLE");
  });

  it("rejects the next forecast date when no plan is actually due on it", async () => {
    // A plan in a future pause window is not generated on its due day, so it is not moved either.
    const world = makeWorld();
    for (const p of world.plans) {
      p.pauseStartDate = d("2026-12-20");
      p.pauseEndDate = d("2027-01-05");
    }
    expect((await moveError(world, "2026-12-28", "2026-12-15")).code).toBe("OCCURRENCE_NOT_MOVABLE");
  });

  it("follows a closure-moved forecast date and still advances from the original date", async () => {
    // 28 Dec is inside a MOVE closure: the forecast shows the visit on Mon 4 Jan.
    const world = makeWorld({
      closures: [{ id: "k3", label: "Xmas", startDate: d("2026-12-24"), endDate: d("2027-01-03"), mode: "MOVE", roundIds: [] }],
    });
    const preview = await world.svc.preview("r1", d("2027-01-04"));
    expect(preview.kind).toBe("FORECAST");
    expect(preview.propertyCount).toBe(3);
    const result = await world.svc.move("r1", { fromDate: d("2027-01-04"), toDate: d("2027-01-05"), notifyCustomers: false });
    expect(result.createdVisits).toBe(3);
    expect(world.plans.find((p) => p.id === "pA")!.nextDueDate).toEqual(d("2027-01-25"));
  });
});

// ---- customers ----------------------------------------------------------------------------------------------------

describe("customer notifications", () => {
  it("are sent once per customer when notify is on (the default wording names the new date)", async () => {
    const world = makeWorld();
    await world.svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-12-02"), notifyCustomers: true });
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.send).toHaveBeenCalledWith({ customerId: "custA", channel: "sms", body: expect.stringContaining("Wednesday 2 December") });
  });

  it("use the custom message when given", async () => {
    const world = makeWorld();
    await world.svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-12-02"), notifyCustomers: true, message: "  See you Wednesday!  " });
    expect(h.send).toHaveBeenCalledWith({ customerId: "custB", channel: "sms", body: "See you Wednesday!" });
  });

  it("are not sent when notify is off", async () => {
    const world = makeWorld();
    const result = await world.svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-12-02"), notifyCustomers: false, message: "ignored" });
    expect(h.send).not.toHaveBeenCalled();
    expect(result.notifiedCustomers).toBe(0);
    expect(result.customerNotificationError).toBeNull();
    // GHL still learns the new date.
    expect(h.ghl).toHaveBeenCalledTimes(3);
  });

  it("report a failed send without undoing the move", async () => {
    h.send.mockResolvedValueOnce({ id: "m1" }).mockRejectedValueOnce(new Error("No phone number")).mockResolvedValueOnce({ id: "m3" });
    h.ghl.mockRejectedValue(new Error("GHL down"));
    const world = makeWorld();
    const result = await world.svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-12-02"), notifyCustomers: true });
    expect(result.notifiedCustomers).toBe(2);
    expect(result.customerNotificationError).toBe("1 customer could not be notified: No phone number");
    expect(result.movedVisits).toBe(4);
  });

  it("report every failed send", async () => {
    h.send.mockRejectedValue("boom");
    const result = await makeWorld().svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-12-02"), notifyCustomers: true });
    expect(result.notifiedCustomers).toBe(0);
    expect(result.customerNotificationError).toBe("3 customers could not be notified: boom");
  });
});

// ---- preview ------------------------------------------------------------------------------------------------------

describe("preview", () => {
  const closureDays = ["2026-12-07", "2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11"].map((date) => ({ date, reason: "CLOSURE", label: "Xmas party" }));

  it("a real date: window, property count and blocked dates", async () => {
    const preview = await makeWorld().svc.preview("r1", d("2026-11-30"));
    expect(preview).toEqual({
      fromDate: "2026-11-30", kind: "REAL", propertyCount: 3, earliestDate: "2026-11-25", latestDate: "2026-12-27",
      blockedDates: closureDays, check: null,
      nonWorkingDates: ["2026-11-28", "2026-11-29", "2026-12-05", "2026-12-06", "2026-12-12", "2026-12-13", "2026-12-19", "2026-12-20", "2026-12-26", "2026-12-27"],
    });
  });

  it("the next forecast date: window starts after the previous real date", async () => {
    const preview = await makeWorld().svc.preview("r1", d("2026-12-28"));
    expect(preview).toEqual(expect.objectContaining({
      fromDate: "2026-12-28", kind: "FORECAST", propertyCount: 3, earliestDate: "2026-12-01", latestDate: "2027-01-24", blockedDates: closureDays,
    }));
  });

  it("lists today as closed once Close Day has run", async () => {
    h.lastClosedDate = "2026-11-25";
    const preview = await makeWorld().svc.preview("r1", d("2026-11-30"));
    expect(preview.blockedDates[0]).toEqual({ date: "2026-11-25", reason: "CLOSED_DAY", label: "Day already closed" });
  });

  it("a one-day window between neighbouring dates", async () => {
    // The previous round date is the day before and the next one the day after: only the date itself fits.
    const world = makeWorld();
    for (const v of world.visits) if (iso(v.date) === "2026-11-02") v.date = d("2026-11-29");
    world.visits.push({ ...world.visits[3], id: "vNext", date: d("2026-12-01"), status: "SCHEDULED" });
    const preview = await world.svc.preview("r1", d("2026-11-30"), d("2026-11-30"));
    expect(preview.earliestDate).toBe("2026-11-30");
    expect(preview.latestDate).toBe("2026-11-30");
    expect(preview.blockedDates).toEqual([]);
  });

  it("throws the same errors as the move for the occurrence itself", async () => {
    await expect(makeWorld().svc.preview("r1", d("2027-01-25"))).rejects.toMatchObject({ statusCode: 409, code: "OCCURRENCE_NOT_MOVABLE" });
    await expect(makeWorld().svc.preview("nope", d("2026-11-30"))).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([
    ["2026-11-30", "2026-12-02", null],
    ["2026-11-30", "2026-11-24", "DATE_IN_PAST"],
    ["2026-11-30", "2026-11-30", "SAME_DATE"],
    ["2026-11-30", "2026-12-09", "DATE_IN_CLOSURE"],
    ["2026-11-30", "2026-12-28", "OUTSIDE_MOVE_WINDOW"],
    ["2026-12-28", "2026-11-27", "OUTSIDE_MOVE_WINDOW"],
    ["2026-12-28", "2027-01-12", "PROPERTY_CLEAN_CLASH"],
    ["2026-12-28", "2026-12-22", null],
  ])("check for %s -> %s matches the move (%s)", async (from, to, code) => {
    const preview = await makeWorld().svc.preview("r1", d(from), d(to));
    const world = makeWorld();
    const outcome = await world.svc.move("r1", { fromDate: d(from), toDate: d(to), notifyCustomers: false }).then(
      () => null,
      (e: AppError) => e
    );
    expect(preview.check).toEqual({
      toDate: to,
      ok: code === null,
      code,
      message: outcome ? outcome.message : null,
      clashCount: code === "PROPERTY_CLEAN_CLASH" ? 1 : 0,
      warning: null,
    });
    expect(outcome?.code ?? null).toBe(code);
  });

  it("a non-working day is allowed with a warning, in the check and the move result", async () => {
    const preview = await makeWorld().svc.preview("r1", d("2026-11-30"), d("2026-12-05"));
    const warning = "Saturday 5 Dec is not a working day.";
    expect(preview.check).toEqual({ toDate: "2026-12-05", ok: true, code: null, message: null, clashCount: 0, warning });
    const result = await makeWorld().svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-12-05"), notifyCustomers: false });
    expect(result).toEqual(expect.objectContaining({ movedVisits: 4, warning }));
  });

  it("warns alongside a failure without changing ok", async () => {
    const preview = await makeWorld().svc.preview("r1", d("2026-11-30"), d("2027-01-02"));
    expect(preview.check).toEqual(expect.objectContaining({ ok: false, code: "OUTSIDE_MOVE_WINDOW", warning: "Saturday 2 Jan is not a working day." }));
  });

  it("uses the tenant's own working days (Tue-Sat: Saturday is fine, Monday warns)", async () => {
    h.workingDays = ["TUE", "WED", "THU", "FRI", "SAT"];
    const world = makeWorld();
    const preview = await world.svc.preview("r1", d("2026-11-30"), d("2026-12-05"));
    expect(preview.check!.warning).toBeNull();
    expect(preview.nonWorkingDates.slice(0, 3)).toEqual(["2026-11-29", "2026-11-30", "2026-12-06"]);
    const result = await world.svc.move("r1", { fromDate: d("2026-11-30"), toDate: d("2026-12-14"), notifyCustomers: false });
    expect(result.warning).toBe("Monday 14 Dec is not a working day.");
  });

  it("check reports a closed day like the move", async () => {
    h.lastClosedDate = "2026-11-25";
    const preview = await makeWorld().svc.preview("r1", d("2026-11-30"), d("2026-11-25"));
    expect(preview.check).toEqual(expect.objectContaining({ ok: false, code: "DAY_CLOSED" }));
  });
});
