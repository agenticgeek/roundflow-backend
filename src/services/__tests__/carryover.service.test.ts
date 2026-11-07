import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantToday = vi.fn();
vi.mock("../business-time", () => ({ tenantToday: (...a: unknown[]) => tenantToday(...a) }));
const getCachedBusinessSettings = vi.fn();
vi.mock("../settings.service", () => ({ getCachedBusinessSettings: (...a: unknown[]) => getCachedBusinessSettings(...a) }));
vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());
const broadcast = vi.fn();
vi.mock("../message.service", () => ({ createMessageService: vi.fn(() => ({ broadcast })) }));

import { createCarryoverService, carryOverVisits, notifyCarryoverCustomers, pickTarget, ACTIVITY_VISITS_CARRIED_OVER } from "../carryover.service";
import { notifyVisitTechnicians } from "../notify";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const FRI = d("2026-11-06");
const MON = d("2026-11-09");

const cust = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Jane ${id}`, phone: "07", email: null, ghlContactId: null, messagesOptOut: false, ...over,
});
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  date: FRI,
  status: "SCHEDULED",
  technicianId: "t1",
  roundId: "r1",
  propertyId: `p-${id}`,
  technician: { active: true },
  property: { addressLine: `${id} High St`, customer: cust("c1") },
  ...over,
});

function makeDb(rows: unknown[], unavailable: string[] = []) {
  const tx = {
    visit: { findMany: vi.fn().mockResolvedValue(rows), updateMany: vi.fn().mockResolvedValue({ count: rows.length }) },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue(unavailable.map((technicianId) => ({ technicianId }))) },
    integrationOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)) };
  return { tx, prisma: prisma as never, raw: prisma };
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantToday.mockResolvedValue(FRI);
  getCachedBusinessSettings.mockResolvedValue({ defaultWorkingDays: [], timezone: null, lastClosedDate: null, businessName: "Shine" });
  broadcast.mockResolvedValue({ sent: 1, scheduled: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("options", () => {
  it("Friday offers Saturday and Monday, honouring the business settings", async () => {
    const { prisma } = makeDb([]);
    const res = await createCarryoverService(prisma).options(FRI);
    expect(res.date).toBe("2026-11-06");
    expect(res.options.map((o) => [o.key, o.date, o.default])).toEqual([
      ["SATURDAY", "2026-11-07", false],
      ["MONDAY", "2026-11-09", true],
    ]);
  });
  it("Mon-Thu offers the next working day; missing settings default to Mon-Fri", async () => {
    getCachedBusinessSettings.mockResolvedValue(null);
    const { prisma } = makeDb([]);
    const res = await createCarryoverService(prisma).options(d("2026-11-05"));
    expect(res.options).toEqual([{ key: "NEXT_WORKING_DAY", date: "2026-11-06", label: "Friday 6 Nov", default: true }]);
  });
  it("uses the stored working days and timezone", async () => {
    getCachedBusinessSettings.mockResolvedValue({ defaultWorkingDays: ["TUE", "WED", "THU", "FRI", "SAT"], timezone: "Europe/London" });
    const { prisma } = makeDb([]);
    const res = await createCarryoverService(prisma).options(d("2026-11-03"));
    expect(res.options[0].date).toBe("2026-11-04");
    const fri = await createCarryoverService(prisma).options(FRI);
    expect(fri.options.find((o) => o.default)!.key).toBe("SATURDAY");
  });
});

describe("pickTarget", () => {
  it("returns the default option when no key is given", () => {
    expect(pickTarget(FRI, undefined, { workingDays: [] })).toEqual(MON);
    expect(pickTarget(d("2026-11-03"), undefined, { workingDays: [] })).toEqual(d("2026-11-04"));
  });
  it("rejects a key that is not offered for the day", () => {
    expect(() => pickTarget(FRI, "NEXT_WORKING_DAY", { workingDays: [] })).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "INVALID_CARRYOVER_TARGET" })
    );
  });
});

describe("carryover", () => {
  it("rejects a target that is not offered, in the past, or already closed", async () => {
    const { prisma, tx } = makeDb([row("v1")]);
    const svc = createCarryoverService(prisma);
    await expect(svc.carryover({ date: FRI, target: "NEXT_WORKING_DAY" })).rejects.toMatchObject({ statusCode: 400, code: "INVALID_CARRYOVER_TARGET" });

    tenantToday.mockResolvedValue(d("2026-11-10"));
    await expect(svc.carryover({ date: FRI, target: "MONDAY" })).rejects.toMatchObject({ statusCode: 400, code: "CARRYOVER_TARGET_IN_PAST" });

    tenantToday.mockResolvedValue(FRI);
    getCachedBusinessSettings.mockResolvedValue({ defaultWorkingDays: [], lastClosedDate: "2026-11-09" });
    await expect(svc.carryover({ date: FRI, target: "MONDAY" })).rejects.toMatchObject({ statusCode: 409, code: "CARRYOVER_TARGET_CLOSED" });
    expect(tx.visit.updateMany).not.toHaveBeenCalled();
  });

  it("moves every unfinished visit of the date back to SCHEDULED on the target day and resets markers", async () => {
    const { prisma, tx } = makeDb([row("v1"), row("v2", { status: "IN_PROGRESS", technicianId: "t2", property: { addressLine: "x", customer: cust("c2") } })]);
    const res = await createCarryoverService(prisma).carryover({ date: FRI, target: "MONDAY", actor: { id: "u1", role: "MANAGER" } });

    expect(tx.visit.findMany.mock.calls[0][0].where).toEqual({
      date: { gte: FRI, lt: d("2026-11-07") },
      status: { in: ["SCHEDULED", "IN_PROGRESS"] },
    });
    expect(tx.visit.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["v1", "v2"] } },
      data: {
        date: MON, status: "SCHEDULED", startedAt: null, arrivedAt: null,
        reminderSentAt: null, reminderSentTypes: [], carriedOverFromDate: FRI, carryoverCount: { increment: 1 },
      },
    });
    expect(tx.integrationOutbox.updateMany.mock.calls[0][0]).toMatchObject({
      where: { status: "pending", eventType: "message.send" },
      data: { status: "cancelled", lastError: "Carried over" },
    });
    expect(tx.activityLog.create.mock.calls[0][0].data).toMatchObject({
      type: ACTIVITY_VISITS_CARRIED_OVER,
      message: "2 visits carried over from 2026-11-06 to 2026-11-09",
      actorId: "u1",
      actorRole: "MANAGER",
      details: { from: "2026-11-06", to: "2026-11-09", via: "carryover", visitIds: ["v1", "v2"], cancelledReminders: 2 },
    });
    expect(notifyVisitTechnicians).toHaveBeenCalledTimes(1);
    const [, refs, msg] = vi.mocked(notifyVisitTechnicians).mock.calls[0];
    expect(refs).toEqual([
      { id: "v1", technicianId: "t1", roundId: "r1", propertyId: "p-v1", date: MON },
      { id: "v2", technicianId: "t2", roundId: "r1", propertyId: "p-v2", date: MON },
    ]);
    expect(msg({ count: 1, first: "2026-11-09" })).toMatchObject({ type: "SCHEDULE", title: "1 visit carried over" });
    expect(res).toEqual({
      moved: 2, targetDate: "2026-11-09", conflicts: [], notifiedTechnicians: 2, notifiedCustomers: 0, skipped: [], dryRun: false,
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("records a null actor when none is given", async () => {
    const { prisma, tx } = makeDb([row("v1", { technicianId: null })]);
    const res = await createCarryoverService(prisma).carryover({ date: FRI, target: "SATURDAY" });
    expect(res.targetDate).toBe("2026-11-07");
    expect(res.notifiedTechnicians).toBe(0);
    expect(tx.activityLog.create.mock.calls[0][0].data).toMatchObject({ actorId: null, actorRole: null });
  });

  it("only moves the requested visits and reports why others were skipped", async () => {
    const { prisma, tx } = makeDb([
      row("v1"),
      row("v2", { date: d("2026-11-05") }),
      row("v3", { status: "COMPLETED" }),
    ]);
    const res = await createCarryoverService(prisma).carryover({ date: FRI, target: "MONDAY", visitIds: ["v1", "v2", "v3", "gone"] });
    expect(tx.visit.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["v1", "v2", "v3", "gone"] } });
    expect(tx.visit.updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["v1"] } });
    expect(res.moved).toBe(1);
    expect(res.skipped).toEqual([
      { visitId: "v2", reason: "NOT_ON_DATE" },
      { visitId: "v3", reason: "NOT_UNFINISHED" },
      { visitId: "gone", reason: "NOT_FOUND" },
    ]);
  });

  it("flags unavailable and deactivated technicians on the target day (still moves the visit)", async () => {
    const { prisma } = makeDb(
      [
        row("v1", { technicianId: "busy" }),
        row("v2", { technicianId: "gone", technician: { active: false } }),
        row("v3", { technicianId: "ok" }),
        row("v4", { technicianId: null, technician: null }),
        row("v5", { technicianId: "legacy", technician: null }),
      ],
      ["busy"]
    );
    const res = await createCarryoverService(prisma).carryover({ date: FRI, target: "MONDAY" });
    expect(res.moved).toBe(5);
    expect(res.conflicts).toEqual([
      { visitId: "v1", technicianId: "busy", reason: "TECHNICIAN_UNAVAILABLE" },
      { visitId: "v2", technicianId: "gone", reason: "TECHNICIAN_INACTIVE" },
    ]);
  });

  it("dryRun previews moved visits and conflicts without writing or notifying", async () => {
    const { prisma, tx } = makeDb([row("v1", { technicianId: "busy" })], ["busy"]);
    const res = await createCarryoverService(prisma).carryover({ date: FRI, target: "MONDAY", dryRun: true, notifyCustomers: true });
    expect(res).toMatchObject({ moved: 1, dryRun: true, notifiedTechnicians: 0, notifiedCustomers: 0 });
    expect(res.conflicts).toHaveLength(1);
    expect(tx.visit.updateMany).not.toHaveBeenCalled();
    expect(tx.activityLog.create).not.toHaveBeenCalled();
    expect(notifyVisitTechnicians).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("does nothing (and skips the availability lookup) when no visit is eligible", async () => {
    const { prisma, tx } = makeDb([]);
    const res = await createCarryoverService(prisma).carryover({ date: FRI, target: "MONDAY", notifyCustomers: true });
    expect(res).toMatchObject({ moved: 0, notifiedTechnicians: 0, notifiedCustomers: 0 });
    expect(tx.technicianAvailability.findMany).not.toHaveBeenCalled();
    expect(tx.visit.updateMany).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("messages each customer once when notifyCustomers is set (opt-outs are skipped by the message service)", async () => {
    const { prisma } = makeDb([
      row("v1"),
      row("v2"),
      row("v3", { property: { addressLine: "3 Low Rd", customer: cust("c2", { messagesOptOut: true }) } }),
    ]);
    const res = await createCarryoverService(prisma).carryover({ date: FRI, target: "MONDAY", notifyCustomers: true });
    const [targets, opts] = broadcast.mock.calls[0];
    expect(targets).toHaveLength(2);
    expect(targets[0].vars).toMatchObject({ firstName: "Jane", address: "v1 High St", newDate: expect.stringContaining("9"), businessName: "Shine" });
    expect(opts).toMatchObject({ reason: ACTIVITY_VISITS_CARRIED_OVER, body: expect.stringContaining("{{newDate}}") });
    expect(res.notifiedCustomers).toBe(2);
  });

  it("never fails the carryover when customer messaging breaks", async () => {
    broadcast.mockRejectedValue(new Error("GoHighLevel is not connected"));
    const { prisma } = makeDb([row("v1")]);
    const res = await createCarryoverService(prisma).carryover({ date: FRI, target: "MONDAY", notifyCustomers: true });
    expect(res).toMatchObject({ moved: 1, notifiedCustomers: 0, customerNotificationError: "GoHighLevel is not connected" });
  });
});

describe("carryOverVisits (close-day entry)", () => {
  it("records via=close-day", async () => {
    const { tx } = makeDb([row("v1")]);
    const core = await carryOverVisits(tx as never, { fromDate: FRI, targetDate: MON, visitIds: ["v1"], via: "close-day" });
    expect(core.moved).toHaveLength(1);
    expect(tx.activityLog.create.mock.calls[0][0].data.details).toMatchObject({ via: "close-day" });
  });
});

describe("notifyCarryoverCustomers (shared with close day)", () => {
  const moved = [{ id: "v1", customer: cust("c1"), addressLine: "1 High St" }] as never;
  it("reports the number messaged", async () => {
    expect(await notifyCarryoverCustomers({} as never, moved, FRI, MON)).toEqual({ notified: 2 });
  });
  it("returns the error instead of throwing", async () => {
    broadcast.mockRejectedValue(new Error("boom"));
    expect(await notifyCarryoverCustomers({} as never, moved, FRI, MON)).toEqual({ notified: 0, error: "boom" });
  });
});
