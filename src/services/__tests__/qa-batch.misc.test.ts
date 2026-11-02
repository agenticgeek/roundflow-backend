import { it, expect, vi, beforeEach } from "vitest";
import { createVisitService } from "../visit.service";
import { releaseTechnicianWork, resolveTechnicianForVisit } from "../visit-assignment";
import { createTechnicianService } from "../technician.service";
import { createSettingsService } from "../settings.service";
import { createTodayService, DEFAULT_CLOSE_DAY_SKIP_REASON } from "../today.service";
import { createRoundService } from "../round.service";
import { localDay, todayRange, resolveTimeZone, localDateTime } from "../../lib/dates";
import { tenantTimeZone, tenantTodayRange, tenantToday } from "../business-time";
import { moveFutureVisitsToRound, pausePlan } from "../service-plan-lifecycle";

beforeEach(() => vi.clearAllMocks());

// ---- B2 ---------------------------------------------------------------------

function visitPrisma(over: Record<string, any> = {}) {
  return {
    visit: {
      findUnique: vi.fn().mockResolvedValue({ id: "v1", status: "SCHEDULED" }),
      update: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "v1", status: "SCHEDULED", technician: { name: "Sam" }, ...data })),
    },
    technician: { findUnique: vi.fn().mockResolvedValue({ id: "t1", active: true, profileId: "pr1" }) },
    ...over,
  } as any;
}

it("B2: assigns and unassigns a single SCHEDULED visit, as a manual override", async () => {
  const p = visitPrisma();
  const svc = createVisitService(p);
  expect(await svc.assignVisit("v1", "t1")).toEqual({ id: "v1", status: "SCHEDULED", technicianId: "t1", technicianName: "Sam", technicianOverride: true });
  expect(p.visit.update.mock.calls[0][0].data).toEqual({ technicianId: "t1", technicianOverride: true });
  p.visit.update.mockResolvedValueOnce({ id: "v1", status: "SCHEDULED", technicianId: null, technician: null, technicianOverride: true });
  expect(await svc.assignVisit("v1", null)).toMatchObject({ technicianId: null, technicianName: null });
  expect(p.technician.findUnique).toHaveBeenCalledTimes(1); // null skips the technician lookup
});

it("B2: rejects unknown visit / technician, non-SCHEDULED visits, inactive and uninvited technicians", async () => {
  const svc = (over: Record<string, any>) => createVisitService(visitPrisma(over));
  await expect(svc({ visit: { findUnique: vi.fn().mockResolvedValue(null) } }).assignVisit("v1", "t1")).rejects.toMatchObject({ statusCode: 404 });
  await expect(svc({ visit: { findUnique: vi.fn().mockResolvedValue({ id: "v1", status: "COMPLETED" }) } }).assignVisit("v1", null)).rejects.toMatchObject({ statusCode: 409, code: "VISIT_NOT_SCHEDULED" });
  await expect(svc({ technician: { findUnique: vi.fn().mockResolvedValue(null) } }).assignVisit("v1", "t1")).rejects.toMatchObject({ statusCode: 404 });
  await expect(svc({ technician: { findUnique: vi.fn().mockResolvedValue({ id: "t1", active: true, profileId: null }) } }).assignVisit("v1", "t1")).rejects.toMatchObject({ statusCode: 400 });
  await expect(svc({ technician: { findUnique: vi.fn().mockResolvedValue({ id: "t1", active: false, profileId: "p" }) } }).assignVisit("v1", "t1")).rejects.toMatchObject({ statusCode: 400, code: "TECHNICIAN_INACTIVE" });
});

// ---- C1 ---------------------------------------------------------------------

it("C1: releaseTechnicianWork frees future SCHEDULED visits and clears property allocations", async () => {
  const tp: any = {
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
    property: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  const out = await releaseTechnicianWork(tp, "t1", new Date("2026-11-03T15:00:00Z"));
  expect(out).toEqual({ visits: 3, properties: 2 });
  expect(tp.visit.updateMany).toHaveBeenCalledWith({
    where: { technicianId: "t1", status: "SCHEDULED", date: { gte: new Date("2026-11-03T00:00:00Z") } },
    data: { technicianId: null, technicianOverride: false },
  });
  expect(tp.property.updateMany).toHaveBeenCalledWith({ where: { assignedTechnicianId: "t1" }, data: { assignedTechnicianId: null } });
});

it("C1: resolveTechnicianForVisit ignores inactive technicians", () => {
  expect(resolveTechnicianForVisit({ assignedTechnicianId: "t1", roundTechnicianIds: ["t1", "t2"], inactiveTechnicianIds: ["t1"] })).toBe("t2");
  expect(resolveTechnicianForVisit({ assignedTechnicianId: "t1", roundTechnicianIds: ["t1"], inactiveTechnicianIds: ["t1"] })).toBeNull();
});

it("C1: deactivating a technician (TechnicianService) releases their upcoming work; other edits and re-activation do not", async () => {
  const tx: any = {
    technician: {
      findUnique: vi.fn().mockResolvedValue({ id: "t1", active: true }),
      update: vi.fn().mockResolvedValue({ id: "t1", name: "Sam", active: false, profileId: "p", serviceAreas: [] }),
    },
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    property: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma: any = { $transaction: vi.fn((cb: any) => cb(tx)), businessSettings: { findFirst: vi.fn().mockResolvedValue(null) } };
  const svc = createTechnicianService(prisma);
  await svc.updateTechnician("t1", { active: false });
  expect(tx.visit.updateMany).toHaveBeenCalledTimes(1);
  expect(tx.property.updateMany).toHaveBeenCalledTimes(1);
  await svc.updateTechnician("t1", { name: "Sam L" });
  tx.technician.findUnique.mockResolvedValue({ id: "t1", active: false });
  await svc.updateTechnician("t1", { active: false });
  expect(tx.visit.updateMany).toHaveBeenCalledTimes(1);
});

it("C1: deactivating via Settings releases work after the update succeeds", async () => {
  const prisma: any = {
    technician: {
      findUnique: vi.fn().mockResolvedValue({ id: "t1", active: true }),
      update: vi.fn().mockResolvedValue({ id: "t1", name: "Sam", active: false, profileId: "p", serviceAreas: [] }),
    },
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    property: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ timezone: "Europe/London" }) },
  };
  const svc = createSettingsService(prisma, "t_x");
  await svc.updateTechnician("t1", { active: false } as never);
  expect(prisma.visit.updateMany).toHaveBeenCalledTimes(1);
  prisma.technician.update.mockRejectedValueOnce(new Error("db"));
  prisma.visit.updateMany.mockClear();
  await expect(svc.updateTechnician("t1", { active: false } as never)).rejects.toThrow("db");
  expect(prisma.visit.updateMany).not.toHaveBeenCalled();
});

// ---- EMU-6 ------------------------------------------------------------------

it("EMU-6: 'today' is the business-local calendar day (BST midnight edge)", () => {
  // 23:30 UTC on 2 Nov 2026 is still 2 Nov in London (GMT), but 23:30 UTC on 31 Jul is already 1 Aug in BST
  expect(localDay("Europe/London", new Date("2026-11-02T23:30:00Z"))).toEqual(new Date("2026-11-02T00:00:00Z"));
  expect(localDay("Europe/London", new Date("2026-07-31T23:30:00Z"))).toEqual(new Date("2026-08-01T00:00:00Z"));
  expect(localDay("Pacific/Auckland", new Date("2026-07-31T23:30:00Z"))).toEqual(new Date("2026-08-01T00:00:00Z"));
  expect(todayRange("Europe/London", new Date("2026-07-31T23:30:00Z"))).toEqual({
    start: new Date("2026-08-01T00:00:00Z"),
    end: new Date("2026-08-02T00:00:00Z"),
  });
  expect(resolveTimeZone("Not/AZone")).toBe("Europe/London");
  expect(resolveTimeZone(null)).toBe("Europe/London");
  expect(localDateTime(new Date("2026-07-31T23:30:00Z"), "Europe/London")).toEqual({ date: "2026-08-01", time: "00:30" });
  expect(localDay("Bogus/Zone", new Date("2026-07-31T23:30:00Z"))).toEqual(new Date("2026-08-01T00:00:00Z"));
  expect(todayRange().end.getTime() - todayRange().start.getTime()).toBe(86_400_000);
});

it("EMU-6: tenant time zone comes from settings, falls back to London on missing settings or a read failure", async () => {
  const ok: any = { businessSettings: { findFirst: vi.fn().mockResolvedValue({ timezone: "Pacific/Auckland" }) } };
  expect(await tenantTimeZone(ok)).toBe("Pacific/Auckland");
  const now = new Date("2026-07-31T23:30:00Z");
  expect((await tenantTodayRange(ok, now)).start).toEqual(new Date("2026-08-01T00:00:00Z"));
  const none: any = { businessSettings: { findFirst: vi.fn().mockResolvedValue(null) } };
  expect(await tenantTimeZone(none)).toBe("Europe/London");
  const broken: any = { businessSettings: { findFirst: vi.fn().mockRejectedValue(new Error("db")) } };
  expect(await tenantTimeZone(broken)).toBe("Europe/London");
  expect(await tenantToday(broken, now)).toEqual(new Date("2026-08-01T00:00:00Z"));
});

// ---- B6 ---------------------------------------------------------------------

function todayPrisma() {
  const tx: any = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ lastClosedDate: null }), updateMany: vi.fn() },
    visit: {
      findMany: vi.fn().mockResolvedValue([{ id: "v1", status: "SCHEDULED", paymentHold: false, price: 10, _count: { issues: 0 } }]),
      updateMany: vi.fn(),
    },
  };
  return { tx, prisma: { $transaction: vi.fn((cb: any) => cb(tx)), businessSettings: { findFirst: vi.fn().mockResolvedValue(null) } } as any };
}

it("B6: closing the day with mark_as_skipped stores a skip reason (given or default)", async () => {
  const a = todayPrisma();
  await createTodayService(a.prisma).closeDay("mark_as_skipped", "  Rain stopped play ");
  expect(a.tx.visit.updateMany.mock.calls[0][0].data).toEqual({ status: "SKIPPED", skipReason: "Rain stopped play" });
  const b = todayPrisma();
  await createTodayService(b.prisma).closeDay("mark_as_skipped");
  expect(b.tx.visit.updateMany.mock.calls[0][0].data.skipReason).toBe(DEFAULT_CLOSE_DAY_SKIP_REASON);
  const c = todayPrisma();
  await createTodayService(c.prisma).closeDay("mark_as_skipped", "   ");
  expect(c.tx.visit.updateMany.mock.calls[0][0].data.skipReason).toBe(DEFAULT_CLOSE_DAY_SKIP_REASON);
});

// ---- pause / move helpers ----------------------------------------------------

it("pausePlan rejects an end date on or before the start and stores date-only values", async () => {
  const tx: any = {
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    servicePlan: { update: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "sp1", ...data })) },
  };
  const tp: any = { $transaction: vi.fn((cb: any) => cb(tx)) };
  const now = new Date("2026-11-03T10:00:00Z");
  await expect(
    pausePlan(tp, { id: "sp1" }, { pauseStartDate: new Date("2026-11-10T09:00:00Z"), pauseEndDate: new Date("2026-11-10T18:00:00Z") }, now)
  ).rejects.toMatchObject({ statusCode: 400, message: "pauseEndDate must be after pauseStartDate" });
  await pausePlan(tp, { id: "sp1" }, { pauseStartDate: new Date("2026-11-10T15:30:00Z"), pauseEndDate: new Date("2026-11-12T08:00:00Z") }, now);
  expect(tx.servicePlan.update.mock.calls[0][0].data).toEqual({
    pauseStartDate: new Date("2026-11-10T00:00:00Z"),
    pauseEndDate: new Date("2026-11-12T00:00:00Z"),
  });
});

it("moveFutureVisitsToRound uses the plan's own frequency, else the round's, else leaves nextDueDate alone", async () => {
  const tx: any = {
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 4 }) },
    servicePlan: {
      findMany: vi.fn().mockResolvedValue([
        { id: "a", lastCompleted: new Date("2026-10-01T00:00:00Z"), cleaningFrequency: "FOUR_WEEKLY" },
        { id: "b", lastCompleted: null, cleaningFrequency: null },
      ]),
      update: vi.fn(),
    },
  };
  const out = await moveFutureVisitsToRound(tx, { propertyId: "p1", target: { id: "r2", defaultDay: "MON", frequency: "SIX_WEEKLY" }, now: new Date("2026-11-03T10:00:00Z") });
  expect(out).toEqual({ movedVisits: 4 });
  expect(tx.servicePlan.update).toHaveBeenCalledTimes(2);
  const none = await moveFutureVisitsToRound(tx, { propertyId: "p1", target: { id: "r2", defaultDay: null, frequency: null }, now: new Date("2026-11-03T10:00:00Z") });
  expect(none.movedVisits).toBe(4);
  expect(tx.servicePlan.update).toHaveBeenCalledTimes(3); // plan "a" has its own frequency; "b" has neither
});

// ---- round property listing ---------------------------------------------------

it("round property listing pages beyond 100 and returns total", async () => {
  const prisma: any = {
    round: { findUnique: vi.fn().mockResolvedValue({ id: "r1" }) },
    property: {
      count: vi.fn().mockResolvedValue(250),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "p1", addressLine: "1 High St", postcode: "X1", status: "ACTIVE", assignedTechnicianId: null,
          customer: { id: "c1", name: "Jo" }, servicePlans: [{ id: "sp1", price: 20, status: "ACTIVE", service: { name: "Windows" } }, { id: "sp2", price: 5, status: "ACTIVE", service: null }],
        },
      ]),
    },
    businessSettings: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const svc = createRoundService(prisma);
  const out = await svc.listProperties("r1", 3, 100);
  expect(prisma.property.findMany.mock.calls[0][0]).toMatchObject({ skip: 200, take: 100 });
  expect(out.pagination).toEqual({ page: 3, pageSize: 100, total: 250, totalPages: 3 });
  expect(out.rows[0]).toMatchObject({ propertyId: "p1", customerName: "Jo" });
  expect(out.rows[0].servicePlans).toEqual([
    { servicePlanId: "sp1", serviceName: "Windows", price: 20, status: "ACTIVE" },
    { servicePlanId: "sp2", serviceName: null, price: 5, status: "ACTIVE" },
  ]);
  prisma.round.findUnique.mockResolvedValue(null);
  await expect(svc.listProperties("nope", 1, 10)).rejects.toMatchObject({ statusCode: 404 });
});
