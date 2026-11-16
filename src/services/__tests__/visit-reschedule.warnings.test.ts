import { it, expect, vi, describe, beforeEach } from "vitest";

const tenantToday = vi.fn();
const tenantTodayRange = vi.fn();
vi.mock("../business-time", () => ({
  tenantToday: (...a: unknown[]) => tenantToday(...a),
  tenantTodayRange: (...a: unknown[]) => tenantTodayRange(...a),
}));
const getCachedBusinessSettings = vi.fn();
vi.mock("../settings.service", () => ({ getCachedBusinessSettings: (...a: unknown[]) => getCachedBusinessSettings(...a) }));
vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());

import { createVisitRescheduleService } from "../visit-reschedule";
import { notifyVisitTechnicians } from "../notify";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const TODAY = d("2026-11-16");
const XMAS = { id: "xmas", label: "Christmas", startDate: d("2026-12-24"), endDate: d("2027-01-03"), mode: "MOVE", roundIds: [] as string[] };
const EXTRA = { id: "extra", label: "Boiler", startDate: d("2026-12-28"), endDate: d("2027-01-10"), mode: "SKIP", roundIds: [] as string[] };

function setup(closures: unknown[], visit: Record<string, unknown> = {}) {
  const tx = {
    visit: { update: vi.fn().mockResolvedValue({}) },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    integrationOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const businessClosure = { findMany: vi.fn().mockResolvedValue(closures) };
  const prisma = {
    visit: { findUnique: vi.fn().mockResolvedValue({ id: "v1", status: "SCHEDULED", date: d("2026-11-23"), technicianId: null, roundId: "r1", propertyId: "p1", ...visit }) },
    businessClosure,
    $transaction: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { svc: createVisitRescheduleService(prisma as never), businessClosure, tx };
}

beforeEach(() => {
  vi.clearAllMocks();
  getCachedBusinessSettings.mockResolvedValue({ lastClosedDate: null });
  tenantToday.mockResolvedValue(TODAY);
  tenantTodayRange.mockResolvedValue({ start: TODAY, end: new Date(TODAY.getTime() + 86_400_000) });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("reschedule: DATE_IN_CLOSURE warnings", () => {
  it("W1: a target inside a closure still moves the visit and returns the warning", async () => {
    const { svc, tx } = setup([XMAS]);
    const res = await svc.reschedule("v1", { date: d("2026-12-30") });
    expect(res).toEqual({
      id: "v1", status: "SCHEDULED", date: "2026-12-30",
      warnings: [{ code: "DATE_IN_CLOSURE", closureId: "xmas", label: "Christmas", startDate: "2026-12-24", endDate: "2027-01-03" }],
    });
    expect(tx.visit.update).toHaveBeenCalledTimes(1);
  });

  it("W2: a target outside every closure has no warnings field at all", async () => {
    const { svc } = setup([XMAS]);
    const res = await svc.reschedule("v1", { date: d("2027-01-05") });
    expect(res).toEqual({ id: "v1", status: "SCHEDULED", date: "2027-01-05" });
    expect("warnings" in res).toBe(false);
  });

  it("no closures at all: no warnings field", async () => {
    const res = await setup([]).svc.reschedule("v1", { date: d("2026-12-30") });
    expect("warnings" in res).toBe(false);
  });

  it("W4: a round-scoped closure of another round does not warn; its own round does", async () => {
    const scoped = { ...XMAS, id: "scoped", roundIds: ["r2"] };
    expect("warnings" in (await setup([scoped], { roundId: "r1" }).svc.reschedule("v1", { date: d("2026-12-30") }))).toBe(false);
    const own = await setup([scoped], { roundId: "r2" }).svc.reschedule("v1", { date: d("2026-12-30") });
    expect(own.warnings?.map((w) => w.closureId)).toEqual(["scoped"]);
  });

  it("a one-off visit (no round) warns for all-rounds closures and is not blocked", async () => {
    const scoped = { ...EXTRA, id: "scoped", roundIds: ["r2"] };
    const { svc, tx } = setup([scoped, XMAS], { roundId: null });
    const res = await svc.reschedule("v1", { date: d("2026-12-30") });
    expect(res.warnings?.map((w) => w.closureId)).toEqual(["xmas"]);
    expect(tx.visit.update).toHaveBeenCalledTimes(1);
  });

  it("overlapping closures give several warnings sorted by startDate", async () => {
    const res = await setup([EXTRA, XMAS]).svc.reschedule("v1", { date: d("2026-12-30") });
    expect(res.warnings?.map((w) => w.closureId)).toEqual(["xmas", "extra"]);
  });

  it("a closure that has ended is ignored", async () => {
    const ended = { ...XMAS, id: "ended", startDate: d("2026-10-01"), endDate: d("2026-11-10") };
    const res = await setup([ended]).svc.reschedule("v1", { date: d("2026-11-20") });
    expect("warnings" in res).toBe(false);
  });

  it("loads the closures with ONE query filtered on endDate >= today", async () => {
    const { svc, businessClosure } = setup([XMAS]);
    await svc.reschedule("v1", { date: d("2026-12-30") });
    expect(businessClosure.findMany).toHaveBeenCalledTimes(1);
    expect(businessClosure.findMany.mock.calls[0][0].where).toEqual({ endDate: { gte: TODAY } });
  });

  it("a failing closure lookup never fails the (already committed) move", async () => {
    const { svc, businessClosure } = setup([]);
    businessClosure.findMany.mockRejectedValue(new Error("db"));
    const res = await svc.reschedule("v1", { date: d("2026-12-30") });
    expect(res).toEqual({ id: "v1", status: "SCHEDULED", date: "2026-12-30" });
  });
});

it("tells the technician with the old and new date (the notification text builder)", async () => {
  await setup([]).svc.reschedule("v1", { date: d("2026-11-24") });
  const build = vi.mocked(notifyVisitTechnicians).mock.calls[0][2] as (a: unknown) => unknown;
  expect(build({ count: 1 })).toEqual({ type: "SCHEDULE", title: "A visit was rescheduled", body: "Moved from 2026-11-23 to 2026-11-24." });
});

it("moving a visit onto today works when no business settings exist yet", async () => {
  getCachedBusinessSettings.mockResolvedValue(null);
  const res = await setup([]).svc.reschedule("v1", { date: TODAY });
  expect(res).toEqual({ id: "v1", status: "SCHEDULED", date: "2026-11-16" });
});
