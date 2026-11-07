import { it, expect, vi, afterEach } from "vitest";
import { createTodayService } from "../today.service";
import { Prisma } from "../../generated/tenant-client";

vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());
import { notifyVisitTechnicians } from "../notify";
const broadcast = vi.fn();
vi.mock("../message.service", () => ({ createMessageService: vi.fn(() => ({ broadcast })) }));

// close day: push_to_tomorrow delegates to the carryover service (ACT-02..04).

afterEach(() => vi.useRealTimers());

function harness(opts: { settings?: Record<string, unknown>; unfinished?: string[] } = {}) {
  const start = new Date("2026-11-06T00:00:00.000Z"); // Friday
  const unfinished = opts.unfinished ?? ["v1"];
  const tx = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ lastClosedDate: null }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    visit: {
      // 1st call: the day's visits; 2nd: the carryover service's own lookup
      findMany: vi
        .fn()
        .mockResolvedValueOnce(unfinished.map((id) => ({ id, status: "SCHEDULED", paymentHold: false, price: new Prisma.Decimal(10), _count: { issues: 0 } })))
        .mockResolvedValueOnce(
          unfinished.map((id) => ({
            id, date: start, status: "SCHEDULED", technicianId: "t1", roundId: "r1", propertyId: "p1",
            technician: { active: true }, property: { addressLine: "1 High St", customer: { id: "c1", name: "A B" } },
          }))
        ),
      updateMany: vi.fn().mockResolvedValue({ count: unfinished.length }),
    },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue([]) },
    integrationOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    businessSettings: {
      findFirst: vi.fn().mockResolvedValue(opts.settings ?? { lastClosedDate: null, timezone: "UTC", defaultWorkingDays: [] }),
      updateMany: vi.fn(),
    },
    visit: { findMany: vi.fn() },
    $transaction: vi.fn((cb: (t: unknown) => unknown) => cb(tx)),
  };
  return { prisma: prisma as never, tx };
}

function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

it("push_to_tomorrow carries unfinished visits to the default target (Monday on a Friday) and tells the technician", async () => {
  at("2026-11-06T10:00:00Z");
  const { prisma, tx } = harness();
  const res = await createTodayService(prisma).closeDay("push_to_tomorrow", null, undefined, { id: "u1", role: "ADMIN" });
  expect(res).toMatchObject({ outstanding: 1, carriedToDate: "2026-11-09" });
  expect(tx.visit.updateMany).toHaveBeenCalledWith({
    where: { id: { in: ["v1"] } },
    data: expect.objectContaining({ date: new Date("2026-11-09T00:00:00.000Z"), status: "SCHEDULED", startedAt: null, arrivedAt: null, carryoverCount: { increment: 1 } }),
  });
  expect(tx.activityLog.create.mock.calls[0][0].data).toMatchObject({ actorId: "u1", details: expect.objectContaining({ via: "close-day" }) });
  expect(notifyVisitTechnicians).toHaveBeenCalledTimes(1);
});

it("push_to_tomorrow honours an explicit Saturday target and rejects one that is not offered", async () => {
  at("2026-11-06T10:00:00Z");
  const sat = harness();
  const res = await createTodayService(sat.prisma).closeDay("push_to_tomorrow", null, "SATURDAY");
  expect(res.carriedToDate).toBe("2026-11-07");
  const bad = harness();
  await expect(createTodayService(bad.prisma).closeDay("push_to_tomorrow", null, "NEXT_WORKING_DAY")).rejects.toMatchObject({ code: "INVALID_CARRYOVER_TARGET" });
});

it("push_to_tomorrow on a Wednesday uses the next working day; mark_as_skipped carries nothing", async () => {
  at("2026-11-04T10:00:00Z");
  const h = harness({ settings: { lastClosedDate: null } });
  const res = await createTodayService(h.prisma).closeDay("push_to_tomorrow");
  expect(res.carriedToDate).toBe("2026-11-05");

  const skip = harness();
  const out = await createTodayService(skip.prisma).closeDay("mark_as_skipped", "Rain");
  expect(out).toMatchObject({ outstanding: 0, carriedToDate: null, skippedJobs: 1 });
});

it("d: push_to_tomorrow with notifyCustomers messages each customer through the carryover service", async () => {
  at("2026-11-06T10:00:00Z");
  broadcast.mockResolvedValue({ sent: 1, scheduled: 0 });
  const { prisma } = harness();
  const res = await createTodayService(prisma).closeDay("push_to_tomorrow", null, undefined, undefined, { notifyCustomers: true });
  expect(broadcast).toHaveBeenCalledTimes(1);
  expect(res).toMatchObject({ outstanding: 1, notifiedCustomers: 1 });
  expect(res.customerNotificationError).toBeUndefined();
});

it("d: a customer-messaging failure never fails the close and is reported", async () => {
  at("2026-11-06T10:00:00Z");
  vi.spyOn(console, "error").mockImplementation(() => {});
  broadcast.mockRejectedValue(new Error("no channel"));
  const { prisma } = harness();
  const res = await createTodayService(prisma).closeDay("push_to_tomorrow", null, undefined, undefined, { notifyCustomers: true });
  expect(res).toMatchObject({ notifiedCustomers: 0, customerNotificationError: "no channel" });
});

it("d: without notifyCustomers (or with mark_as_skipped) nobody is messaged", async () => {
  at("2026-11-06T10:00:00Z");
  broadcast.mockClear();
  await createTodayService(harness().prisma).closeDay("push_to_tomorrow");
  await createTodayService(harness().prisma).closeDay("mark_as_skipped", null, undefined, undefined, { notifyCustomers: true });
  expect(broadcast).not.toHaveBeenCalled();
});
