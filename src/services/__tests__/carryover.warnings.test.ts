import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantToday = vi.fn();
vi.mock("../business-time", () => ({ tenantToday: (...a: unknown[]) => tenantToday(...a) }));
const getCachedBusinessSettings = vi.fn();
vi.mock("../settings.service", () => ({ getCachedBusinessSettings: (...a: unknown[]) => getCachedBusinessSettings(...a) }));
vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());
vi.mock("../message.service", () => ({ createMessageService: vi.fn(() => ({ broadcast: vi.fn().mockResolvedValue({ sent: 0, scheduled: 0 }) })) }));

import { createCarryoverService } from "../carryover.service";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const WED = d("2026-12-23");
const FRI = d("2026-12-18");
const XMAS = { id: "xmas", label: "Christmas", startDate: d("2026-12-24"), endDate: d("2027-01-03"), mode: "MOVE", roundIds: [] as string[] };
const BOILER = { id: "boiler", label: "Boiler", startDate: d("2026-12-24"), endDate: d("2026-12-30"), mode: "MOVE", roundIds: ["r2"] };

const row = (id: string, roundId: string | null, date = WED) => ({
  id, date, status: "SCHEDULED", technicianId: null, roundId, propertyId: `p-${id}`,
  technician: null, property: { addressLine: "1 High St", customer: { id: `c-${id}`, name: "Jane", phone: "07", email: null, ghlContactId: null, messagesOptOut: false } },
});

function makeDb(rows: unknown[], closures: unknown[]) {
  const tx = {
    visit: { findMany: vi.fn().mockResolvedValue(rows), updateMany: vi.fn().mockResolvedValue({ count: rows.length }) },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue([]) },
    integrationOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const businessClosure = { findMany: vi.fn().mockResolvedValue(closures) };
  const prisma = { businessClosure, $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)) };
  return { prisma: prisma as never, tx, businessClosure };
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantToday.mockResolvedValue(WED);
  getCachedBusinessSettings.mockResolvedValue({ defaultWorkingDays: [], timezone: null, lastClosedDate: null, businessName: "Shine" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const WARN_XMAS = { code: "DATE_IN_CLOSURE", closureId: "xmas", label: "Christmas", startDate: "2026-12-24", endDate: "2027-01-03" };

describe("carryover: DATE_IN_CLOSURE warnings", () => {
  it("W3: a target inside a closure still moves the visits and returns the warning", async () => {
    const { prisma, tx } = makeDb([row("v1", "r1")], [XMAS]);
    const res = await createCarryoverService(prisma).carryover({ date: WED, target: "NEXT_WORKING_DAY" });
    expect(res.targetDate).toBe("2026-12-24");
    expect(res.moved).toBe(1);
    expect(res.warnings).toEqual([WARN_XMAS]);
    expect(tx.visit.updateMany).toHaveBeenCalledTimes(1);
  });

  it("no warnings field when the target is outside every closure", async () => {
    tenantToday.mockResolvedValue(FRI);
    const { prisma } = makeDb([row("v1", "r1", FRI)], [XMAS]);
    const res = await createCarryoverService(prisma).carryover({ date: FRI, target: "MONDAY" });
    expect(res.targetDate).toBe("2026-12-21");
    expect("warnings" in res).toBe(false);
  });

  it("dryRun carries the warnings too, and writes nothing", async () => {
    const { prisma, tx } = makeDb([row("v1", "r1")], [XMAS]);
    const res = await createCarryoverService(prisma).carryover({ date: WED, target: "NEXT_WORKING_DAY", dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.warnings).toEqual([WARN_XMAS]);
    expect(tx.visit.updateMany).not.toHaveBeenCalled();
  });

  it("covers every round of the moved visits, de-duplicates by closure id and sorts by startDate", async () => {
    const early = { ...BOILER, id: "early", startDate: d("2026-12-20"), roundIds: ["r1", "r2"] };
    const { prisma } = makeDb([row("v1", "r1"), row("v2", "r2"), row("v3", "r2"), row("v4", null)], [XMAS, BOILER, early]);
    const res = await createCarryoverService(prisma).carryover({ date: WED, target: "NEXT_WORKING_DAY" });
    expect(res.warnings?.map((w) => w.closureId)).toEqual(["early", "boiler", "xmas"]);
  });

  it("W4: a round-scoped closure of another round gives no warning", async () => {
    const { prisma } = makeDb([row("v1", "r1")], [BOILER]);
    const res = await createCarryoverService(prisma).carryover({ date: WED, target: "NEXT_WORKING_DAY" });
    expect("warnings" in res).toBe(false);
  });

  it("a closure that has ended is ignored; nothing moved means no lookup and no warnings", async () => {
    const ended = { ...XMAS, endDate: d("2026-12-22") };
    const a = makeDb([row("v1", "r1")], [ended]);
    expect("warnings" in (await createCarryoverService(a.prisma).carryover({ date: WED, target: "NEXT_WORKING_DAY" }))).toBe(false);
    const b = makeDb([], [XMAS]);
    const res = await createCarryoverService(b.prisma).carryover({ date: WED, target: "NEXT_WORKING_DAY" });
    expect(res.moved).toBe(0);
    expect("warnings" in res).toBe(false);
    expect(b.businessClosure.findMany).not.toHaveBeenCalled();
  });

  it("loads the closures with ONE query filtered on endDate >= today", async () => {
    const { prisma, businessClosure } = makeDb([row("v1", "r1"), row("v2", "r2"), row("v3", null)], [XMAS]);
    await createCarryoverService(prisma).carryover({ date: WED, target: "NEXT_WORKING_DAY" });
    expect(businessClosure.findMany).toHaveBeenCalledTimes(1);
    expect(businessClosure.findMany.mock.calls[0][0].where).toEqual({ endDate: { gte: WED } });
  });
});

describe("carryover options: closure marker", () => {
  it("marks the options whose date is inside a closure and omits the key otherwise (Friday: Saturday + Monday)", async () => {
    const weekend = { ...XMAS, id: "wk", label: "Weekend off", startDate: d("2026-12-19"), endDate: d("2026-12-19") };
    tenantToday.mockResolvedValue(FRI);
    const { prisma, businessClosure } = makeDb([], [weekend]);
    const res = await createCarryoverService(prisma).options(FRI);
    expect(res.options.map((o) => [o.key, o.closure])).toEqual([
      ["SATURDAY", { closureId: "wk", label: "Weekend off" }],
      ["MONDAY", undefined],
    ]);
    expect("closure" in res.options[1]).toBe(false);
    expect(res.options[0]).toMatchObject({ key: "SATURDAY", date: "2026-12-19", default: false });
    expect(businessClosure.findMany).toHaveBeenCalledTimes(1);
  });

  it("marks the next working day option inside XMAS", async () => {
    const { prisma } = makeDb([], [XMAS]);
    const res = await createCarryoverService(prisma).options(WED);
    expect(res.options).toEqual([expect.objectContaining({ key: "NEXT_WORKING_DAY", date: "2026-12-24", closure: { closureId: "xmas", label: "Christmas" } })]);
  });
});
