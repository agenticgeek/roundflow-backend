import { it, expect, vi, describe, beforeEach } from "vitest";

const tenantToday = vi.fn();
const tenantTodayRange = vi.fn();
vi.mock("../business-time", () => ({
  tenantToday: (...a: unknown[]) => tenantToday(...a),
  tenantTodayRange: (...a: unknown[]) => tenantTodayRange(...a),
}));
const getCachedBusinessSettings = vi.fn();
vi.mock("../settings.service", () => ({ getCachedBusinessSettings: (...a: unknown[]) => getCachedBusinessSettings(...a) }));

import { cancelPendingVisitMessages, createVisitRescheduleService } from "../visit-reschedule";

const TODAY = new Date("2026-11-03T00:00:00.000Z");

function makePrisma(visit: unknown) {
  const tx = {
    visit: { update: vi.fn().mockResolvedValue({}) },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    integrationOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    visit: { findUnique: vi.fn().mockResolvedValue(visit) },
    $transaction: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma: prisma as unknown as Parameters<typeof createVisitRescheduleService>[0], tx };
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantToday.mockResolvedValue(TODAY);
  tenantTodayRange.mockResolvedValue({ start: TODAY, end: new Date(TODAY.getTime() + 86_400_000) });
  getCachedBusinessSettings.mockResolvedValue({ lastClosedDate: null });
});

describe("reschedule", () => {
  const skipped = { id: "v1", status: "SKIPPED", date: new Date("2026-11-03T00:00:00.000Z") };

  it("re-books a skipped visit: SCHEDULED again, skip reason and reminder markers cleared, queued reminders cancelled, logged", async () => {
    const { prisma, tx } = makePrisma(skipped);
    const res = await createVisitRescheduleService(prisma).reschedule("v1", {
      date: new Date("2026-11-10T00:00:00.000Z"), actor: { id: "u1", role: "ADMIN" },
    });
    expect(res).toEqual({ id: "v1", status: "SCHEDULED", date: "2026-11-10" });
    expect(tx.visit.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: { date: new Date("2026-11-10T00:00:00.000Z"), status: "SCHEDULED", skipReason: null, reminderSentAt: null, reminderSentTypes: [] },
    });
    expect(tx.integrationOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ payload: { path: ["visitId"], equals: "v1" } }] }),
    }));
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "VISIT_RESCHEDULED", entityId: "v1", actorId: "u1", actorRole: "ADMIN",
        details: { from: "2026-11-03", to: "2026-11-10", previousStatus: "SKIPPED" },
      }),
    });
  });

  it("also moves a scheduled visit, recording no actor when unknown", async () => {
    const { prisma, tx } = makePrisma({ ...skipped, status: "SCHEDULED" });
    await createVisitRescheduleService(prisma).reschedule("v1", { date: new Date("2026-11-04T10:00:00.000Z") });
    expect(tx.visit.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ date: new Date("2026-11-04T00:00:00.000Z") }) }));
    expect(tx.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: null, actorRole: null }) });
  });

  it("404s for an unknown visit and 409s for one that cannot be moved", async () => {
    await expect(createVisitRescheduleService(makePrisma(null).prisma).reschedule("x", { date: TODAY })).rejects.toMatchObject({ statusCode: 404 });
    for (const status of ["COMPLETED", "IN_PROGRESS", "CANCELLED"]) {
      await expect(createVisitRescheduleService(makePrisma({ ...skipped, status }).prisma).reschedule("v1", { date: TODAY }))
        .rejects.toMatchObject({ statusCode: 409, code: "VISIT_NOT_RESCHEDULABLE" });
    }
  });

  it("rejects a past date, and today once the day is closed", async () => {
    const { prisma, tx } = makePrisma(skipped);
    await expect(createVisitRescheduleService(prisma).reschedule("v1", { date: new Date("2026-11-02T00:00:00.000Z") }))
      .rejects.toMatchObject({ statusCode: 400 });
    getCachedBusinessSettings.mockResolvedValue({ lastClosedDate: "2026-11-03" });
    await expect(createVisitRescheduleService(prisma).reschedule("v1", { date: TODAY }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("already been closed") });
    expect(tx.visit.update).not.toHaveBeenCalled();
  });
});

describe("cancelPendingVisitMessages", () => {
  it("does nothing for no visits", async () => {
    const tx = { integrationOutbox: { updateMany: vi.fn() } };
    expect(await cancelPendingVisitMessages(tx as never, [], "x")).toBe(0);
    expect(tx.integrationOutbox.updateMany).not.toHaveBeenCalled();
  });
});
