import { it, expect, vi, afterEach } from "vitest";
import { createTodayService } from "../today.service";
import { Prisma } from "../../generated/tenant-client";

vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());
vi.mock("../message.service", () => ({ createMessageService: vi.fn(() => ({ broadcast: vi.fn() })) }));

// close day, push_to_tomorrow: non-blocking DATE_IN_CLOSURE warnings for the carried-to day.

afterEach(() => vi.useRealTimers());

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const FRI = d("2026-11-06");
const closure = (over: Record<string, unknown> = {}) => ({
  id: "c1", label: "Depot move", startDate: d("2026-11-09"), endDate: d("2026-11-13"), mode: "MOVE", roundIds: [], ...over,
});

function harness(closures: unknown[], roundId: string | null = "r1") {
  const tx = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ lastClosedDate: null }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    visit: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([{ id: "v1", status: "SCHEDULED", paymentHold: false, price: new Prisma.Decimal(10), _count: { issues: 0 } }])
        .mockResolvedValueOnce([
          {
            id: "v1", date: FRI, status: "SCHEDULED", technicianId: "t1", roundId, propertyId: "p1",
            technician: { active: true }, property: { addressLine: "1 High St", customer: { id: "c1", name: "A B" } },
          },
        ]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue([]) },
    integrationOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const businessClosure = { findMany: vi.fn().mockResolvedValue(closures) };
  const prisma = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ lastClosedDate: null, timezone: "UTC", defaultWorkingDays: [] }), updateMany: vi.fn() },
    visit: { findMany: vi.fn() },
    businessClosure,
    $transaction: vi.fn((cb: (t: unknown) => unknown) => cb(tx)),
  };
  return { prisma: prisma as never, businessClosure };
}

function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

it("push_to_tomorrow onto a closed day carries the visits and returns the warning", async () => {
  at("2026-11-06T10:00:00Z");
  const { prisma, businessClosure } = harness([closure()]);
  const res = await createTodayService(prisma).closeDay("push_to_tomorrow");
  expect(res).toMatchObject({
    outstanding: 1,
    carriedToDate: "2026-11-09",
    warnings: [{ code: "DATE_IN_CLOSURE", closureId: "c1", label: "Depot move", startDate: "2026-11-09", endDate: "2026-11-13" }],
  });
  expect(businessClosure.findMany).toHaveBeenCalledTimes(1);
  expect(businessClosure.findMany.mock.calls[0][0].where).toEqual({ endDate: { gte: FRI } });
});

it("no warnings field when the target is open, the closure is round-scoped elsewhere, or it ended", async () => {
  at("2026-11-06T10:00:00Z");
  for (const c of [closure({ startDate: d("2026-11-10") }), closure({ roundIds: ["r2"] }), closure({ startDate: d("2026-11-01"), endDate: d("2026-11-05") })]) {
    const res = await createTodayService(harness([c]).prisma).closeDay("push_to_tomorrow");
    expect(res.carriedToDate).toBe("2026-11-09");
    expect("warnings" in res).toBe(false);
  }
});

it("a visit without a round only meets all-rounds closures; mark_as_skipped never looks at closures", async () => {
  at("2026-11-06T10:00:00Z");
  expect("warnings" in (await createTodayService(harness([closure({ roundIds: ["r1"] })], null).prisma).closeDay("push_to_tomorrow"))).toBe(false);
  expect((await createTodayService(harness([closure()], null).prisma).closeDay("push_to_tomorrow")).warnings).toHaveLength(1);

  const skip = harness([closure()]);
  const res = await createTodayService(skip.prisma).closeDay("mark_as_skipped", "Rain");
  expect("warnings" in res).toBe(false);
  expect(skip.businessClosure.findMany).not.toHaveBeenCalled();
});
