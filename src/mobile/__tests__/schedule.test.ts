import { it, expect, vi } from "vitest";
import { createScheduleService } from "../services/schedule.service";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

function visitRow(id: string, date: string, extra: Record<string, unknown> = {}) {
  return {
    id, date: d(date), status: "SCHEDULED", price: { toNumber: () => 20 }, paymentMethod: null, paymentHold: false, notes: null,
    roundId: "r1", round: { id: "r1", name: "Mon" }, service: null, servicePlan: null, startedAt: null, arrivedAt: null, completedAt: null,
    _count: { issues: 0 },
    property: { id: "p", addressLine: "1 High St", postcode: "X1", latitude: null, longitude: null, customer: { id: "c", name: "Jo", badDebt: false, paymentMethod: null }, notes: [] },
    ...extra,
  };
}

function makePrisma(light: any[], settings: any = { vatInInvoices: true, vatRate: 20, timezone: "Europe/London" }) {
  const full = new Map(light.map((l) => [l.id, visitRow(l.id, l.date.toISOString().slice(0, 10), { roundId: l.roundId })]));
  return {
    businessSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
    visit: {
      findMany: vi.fn(async (args: any) => (args.select ? light : args.where.id.in.map((id: string) => full.get(id)).filter(Boolean))),
    },
  } as any;
}

const NOW = new Date("2026-11-03T10:00:00Z");

it("defaults to today..today+13, scopes to the technician and excludes CANCELLED", async () => {
  const p = makePrisma([]);
  const out = await createScheduleService(p).getSchedule("t1", { page: 1, pageSize: 100 }, NOW);
  expect(out).toMatchObject({ from: "2026-11-03", to: "2026-11-16", timeZone: "Europe/London", rows: [], summary: [] });
  const where = p.visit.findMany.mock.calls[0][0].where;
  expect(where).toMatchObject({ technicianId: "t1", status: { not: "CANCELLED" }, date: { gte: d("2026-11-03"), lt: d("2026-11-17") } });
  expect(out.pagination).toEqual({ page: 1, pageSize: 100, total: 0, totalPages: 0 });
});

it("orders by date/round, numbers positions per day+round, summarises the whole range and adds gross totals", async () => {
  const light = [
    { id: "a", date: d("2026-11-04"), roundId: "r1", status: "COMPLETED" },
    { id: "b", date: d("2026-11-04"), roundId: "r1", status: "SCHEDULED" },
    { id: "c", date: d("2026-11-04"), roundId: null, status: "SCHEDULED" },
    { id: "e", date: d("2026-11-05"), roundId: "r1", status: "SKIPPED" },
  ];
  const p = makePrisma(light);
  const out = await createScheduleService(p).getSchedule("t1", { from: "2026-11-04", to: "2026-11-05", page: 1, pageSize: 100 }, NOW);
  expect(out.rows.map((r) => [r.visitId, r.date, r.position])).toEqual([["a", "2026-11-04", 1], ["b", "2026-11-04", 2], ["c", "2026-11-04", null], ["e", "2026-11-05", 1]]);
  expect(out.rows[0]).toMatchObject({ price: 20, vatAmount: 4, grossTotal: 24, paymentHold: false, roundName: "Mon", addressLine: "1 High St" });
  expect(out.summary).toEqual([{ date: "2026-11-04", count: 3, completedCount: 1 }, { date: "2026-11-05", count: 1, completedCount: 0 }]);
  expect(p.visit.findMany.mock.calls[1][0].where.technicianId).toBe("t1");
});

it("paginates rows but keeps the summary and total for the whole range; vanished rows are skipped", async () => {
  const light = [1, 2, 3].map((i) => ({ id: `v${i}`, date: d("2026-11-04"), roundId: "r1", status: "SCHEDULED" }));
  const p = makePrisma(light, null);
  const page2 = await createScheduleService(p).getSchedule("t1", { from: "2026-11-04", to: "2026-11-04", page: 2, pageSize: 2 }, NOW);
  expect(page2.rows.map((r) => r.visitId)).toEqual(["v3"]);
  expect(page2.rows[0]).toMatchObject({ vatAmount: 0, grossTotal: 20 });
  expect(page2.summary[0].count).toBe(3);
  expect(page2.pagination).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
  p.visit.findMany.mockImplementation(async (args: any) => (args.select ? light : []));
  expect((await createScheduleService(p).getSchedule("t1", { from: "2026-11-04", to: "2026-11-04", page: 1, pageSize: 2 }, NOW)).rows).toEqual([]);
});

it("uses the tenant time zone for 'today' and rejects bad ranges with clear codes", async () => {
  const nz = makePrisma([], { timezone: "Pacific/Auckland" });
  const out = await createScheduleService(nz).getSchedule("t1", { page: 1, pageSize: 10 }, new Date("2026-07-31T23:30:00Z"));
  expect(out.from).toBe("2026-08-01");

  const svc = createScheduleService(makePrisma([]));
  const code = async (q: any) => svc.getSchedule("t1", { page: 1, pageSize: 10, ...q }, NOW).catch((e) => [e.statusCode, e.code]);
  expect(await code({ from: "2026-11-10", to: "2026-11-09" })).toEqual([400, "INVALID_DATE_RANGE"]);
  expect(await code({ from: "03/11/2026" })).toEqual([400, "INVALID_DATE_RANGE"]);
  expect(await code({ to: "2026-02-30" })).toEqual([400, "INVALID_DATE_RANGE"]);
  expect(await code({ from: 5 })).toEqual([400, "INVALID_DATE_RANGE"]);
  expect(await code({ from: "2026-11-01", to: "2027-01-02" })).toEqual([400, "RANGE_TOO_LARGE"]); // 63 days
  const ok = await svc.getSchedule("t1", { from: "2026-11-01", to: "2027-01-01", page: 1, pageSize: 10 }, NOW); // 62 days
  expect(ok.to).toBe("2027-01-01");
  expect((await svc.getSchedule("t1", { from: "", to: "", page: 1, pageSize: 10 }, NOW)).from).toBe("2026-11-03");
});
