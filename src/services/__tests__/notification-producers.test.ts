import { describe, it, expect, vi, beforeEach } from "vitest";

// NOTIF-01 / FLOW-03 producers: technician-facing events. notifyVisitTechnicians
// is mocked, so these tests pin WHEN a producer fires and with WHICH visits
// and wording; recipient resolution is covered in notify.test.ts.

vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());
const tenantToday = vi.fn();
const tenantTodayRange = vi.fn();
vi.mock("../business-time", () => ({
  tenantToday: (...a: unknown[]) => tenantToday(...a),
  tenantTodayRange: (...a: unknown[]) => tenantTodayRange(...a),
}));
const getCachedBusinessSettings = vi.fn();
vi.mock("../settings.service", () => ({ getCachedBusinessSettings: (...a: unknown[]) => getCachedBusinessSettings(...a) }));

import { notifyVisitTechnicians } from "../notify";
import { createVisitService } from "../visit.service";
import { createVisitRescheduleService } from "../visit-reschedule";
import { pausePlan, updatePlan } from "../service-plan-lifecycle";
import { holdNextVisits, releaseHeldVisits } from "../payment-hold";

const notifyVisits = vi.mocked(notifyVisitTechnicians);
const TODAY = new Date("2026-11-03T00:00:00.000Z");
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

// Runs the wording callback the producer passed, as notifyVisitTechnicians would.
function wording(call = notifyVisits.mock.calls.at(-1)!, info = { count: 2, first: "2026-11-09" }) {
  return call[2](info);
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantToday.mockResolvedValue(TODAY);
  tenantTodayRange.mockResolvedValue({ start: TODAY, end: new Date(TODAY.getTime() + 86_400_000) });
  getCachedBusinessSettings.mockResolvedValue({ lastClosedDate: null });
});

describe("PATCH /visits/:id/assign", () => {
  const visit = (technicianId: string | null) => ({
    id: "v1", status: "SCHEDULED", technicianId, date: d("2026-11-09"), roundId: "r1", propertyId: "p1",
  });
  function prisma(current: ReturnType<typeof visit>) {
    return {
      visit: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn().mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ id: "v1", status: "SCHEDULED", technician: { name: "T" }, ...data })),
      },
      technician: { findUnique: vi.fn().mockResolvedValue({ id: "t2", active: true, profileId: "prof" }) },
    } as never;
  }

  it("assigning notifies the new technician and the one who lost the visit", async () => {
    const p = prisma(visit("t1"));
    await createVisitService(p).assignVisit("v1", "t2");

    expect(notifyVisits).toHaveBeenCalledTimes(2);
    expect(notifyVisits.mock.calls[0][1]).toEqual([{ ...visit("t1"), technicianId: "t2" }]);
    expect(wording(notifyVisits.mock.calls[0], { count: 1, first: "2026-11-09" })).toEqual({
      type: "SCHEDULE", title: "1 visit assigned to you", body: "Visit on 2026-11-09.",
    });
    expect(notifyVisits.mock.calls[1][1]).toEqual([visit("t1")]);
    expect(wording(notifyVisits.mock.calls[1], { count: 1, first: "2026-11-09" })).toEqual({
      type: "SCHEDULE", title: "1 visit moved off your schedule", body: "Visit on 2026-11-09 was reassigned.",
    });
  });

  it("assigning an unassigned visit only notifies the new technician; unassigning only the old one", async () => {
    await createVisitService(prisma(visit(null))).assignVisit("v1", "t2");
    expect(notifyVisits).toHaveBeenCalledTimes(1);

    notifyVisits.mockClear();
    await createVisitService(prisma(visit("t1"))).assignVisit("v1", null);
    expect(notifyVisits).toHaveBeenCalledTimes(1);
    expect(notifyVisits.mock.calls[0][1]).toEqual([visit("t1")]);
  });

  it("re-assigning the same technician sends nothing", async () => {
    await createVisitService(prisma(visit("t2"))).assignVisit("v1", "t2");
    expect(notifyVisits).not.toHaveBeenCalled();
  });
});

describe("PATCH /visits/:id/reschedule", () => {
  it("tells the assigned technician the old and new date", async () => {
    const tx = { visit: { update: vi.fn() }, activityLog: { create: vi.fn() }, integrationOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } };
    const prisma = {
      visit: {
        findUnique: vi.fn().mockResolvedValue({
          id: "v1", status: "SCHEDULED", date: d("2026-11-05"), technicianId: "t1", roundId: "r1", propertyId: "p1",
        }),
      },
      $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    } as never;

    await createVisitRescheduleService(prisma).reschedule("v1", { date: d("2026-11-10") });

    expect(notifyVisits.mock.calls[0][1]).toEqual([
      { id: "v1", status: "SCHEDULED", technicianId: "t1", roundId: "r1", propertyId: "p1", date: d("2026-11-10") },
    ]);
    expect(wording(notifyVisits.mock.calls[0])).toEqual({
      type: "SCHEDULE", title: "A visit was rescheduled", body: "Moved from 2026-11-05 to 2026-11-10.",
    });
  });
});

describe("pausePlan / updatePlan: visits cancelled", () => {
  const affected = [
    { id: "v1", technicianId: "t1", date: d("2026-11-09"), roundId: "r1", propertyId: "p1" },
    { id: "v2", technicianId: "t1", date: d("2026-12-07"), roundId: "r1", propertyId: "p1" },
  ];

  it("pausePlan reads the cancelled visits inside the transaction and notifies their technicians after commit", async () => {
    const order: string[] = [];
    const tx = {
      visit: {
        findMany: vi.fn().mockImplementation(async () => { order.push("read"); return affected; }),
        updateMany: vi.fn().mockImplementation(async () => { order.push("cancel"); return { count: 2 }; }),
      },
      servicePlan: { update: vi.fn().mockResolvedValue({ id: "sp1" }) },
    };
    const tp = { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => { const r = await cb(tx); order.push("commit"); return r; }) } as never;
    notifyVisits.mockImplementation(async () => { order.push("notify"); });

    await pausePlan(tp, { id: "sp1" }, { pauseStartDate: d("2026-11-03") }, TODAY);

    expect(order).toEqual(["read", "cancel", "commit", "notify"]);
    expect(notifyVisits.mock.calls[0][1]).toBe(affected);
    expect(wording()).toEqual({
      type: "SCHEDULE", title: "2 visits cancelled", body: "The customer's service was paused. First affected visit: 2026-11-09.",
    });
    expect(tx.visit.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: tx.visit.updateMany.mock.calls[0][0].where }));
  });

  it("updatePlan (frequency change) notifies technicians of the old round's cancelled visits", async () => {
    const tx = {
      visit: {
        findMany: vi.fn().mockResolvedValue(affected.slice(0, 1)),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      servicePlan: { update: vi.fn().mockResolvedValue({ id: "sp1" }) },
      property: { update: vi.fn().mockResolvedValue({}) },
    };
    const tp = {
      servicePlan: {
        findUnique: vi.fn().mockResolvedValue({
          id: "sp1", propertyId: "p1", lastCompleted: null,
          property: { serviceAreaId: "sa1", serviceArea: { name: "Alnwick" }, round: { id: "r1", name: "R1", frequency: "FOUR_WEEKLY", defaultDay: "FRI", serviceAreaId: "sa1", serviceArea: { name: "Alnwick" }, roundTechnicians: [] } },
        }),
      },
      round: { findMany: vi.fn().mockResolvedValue([{ id: "r2", name: "R2", defaultDay: "FRI" }]) },
      $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    } as never;

    await updatePlan(tp, "sp1", { cleaningFrequency: "SIX_WEEKLY" as never }, TODAY);

    expect(notifyVisits.mock.calls[0][1]).toEqual(affected.slice(0, 1));
    expect(wording(notifyVisits.mock.calls[0], { count: 1, first: "2026-11-09" })).toEqual({
      type: "SCHEDULE", title: "1 visit cancelled", body: "The cleaning frequency changed. First affected visit: 2026-11-09.",
    });
  });
});

describe("payment hold placed / released (NOTIF-01)", () => {
  const next = { id: "v1", technicianId: "t1", date: d("2026-11-09"), roundId: "r1", propertyId: "p1" };

  it("holdNextVisits notifies the technicians of the visits it put on hold", async () => {
    const tp = {
      property: { findMany: vi.fn().mockResolvedValue([{ id: "p1" }]) },
      visit: { findFirst: vi.fn().mockResolvedValue(next), update: vi.fn() },
    } as never;
    await holdNextVisits(tp, "c1", TODAY);

    expect(notifyVisits.mock.calls[0][1]).toEqual([next]);
    expect(notifyVisits.mock.calls[0][3]).toEqual({ customerId: "c1" });
    expect(wording()).toEqual({
      type: "PAYMENT",
      title: "Payment hold: 2 visits on hold",
      body: "The customer has unpaid invoices. Do not start the visit on 2026-11-09 until the office releases the hold.",
    });
  });

  it("releaseHeldVisits notifies after clearing the hold", async () => {
    const tp = {
      visit: { findMany: vi.fn().mockResolvedValue([next]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    } as never;
    expect(await releaseHeldVisits(tp, "c1", TODAY)).toBe(1);

    expect(notifyVisits.mock.calls[0][1]).toEqual([next]);
    expect(wording()).toEqual({
      type: "PAYMENT",
      title: "Payment hold released: 2 visits",
      body: "The hold is lifted. You can start the visit on 2026-11-09.",
    });
  });
});
