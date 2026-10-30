import { it, expect, vi } from "vitest";

import { createDashboardService } from "../dashboard.service";

function makePrisma() {
  return {
    visit: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn(),
    },
    complaint: {
      groupBy: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    payment: { count: vi.fn() },
    technician: { findMany: vi.fn() },
    issue: { findMany: vi.fn() },
    technicianIncident: { groupBy: vi.fn().mockResolvedValue([]) },
    kpiAlert: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as Parameters<typeof createDashboardService>[0];
}

function decimal(n: number) {
  return { toNumber: () => n };
}

// ── getKpis ──────────────────────────────────────────────────────────────────

it("createDashboardService returns an object", () => {
  expect(createDashboardService(makePrisma())).toBeDefined();
});

it("getKpis is a function", () => {
  expect(typeof createDashboardService(makePrisma()).getKpis).toBe("function");
});

it("getKpis severity bucketing: 0 complaints in every bucket", async () => {
  const prisma = makePrisma();
  (prisma.visit.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (prisma.complaint.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({ _sum: { price: null } });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDashboardService(prisma).getKpis();
  expect(result.openComplaintsByPriority).toEqual({ high: 0, medium: 0, low: 0 });
  expect(result.openComplaints).toBe(0);
});

it("getKpis severity bucketing: one complaint per known severity", async () => {
  const prisma = makePrisma();
  (prisma.visit.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (prisma.complaint.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { severity: "HIGH", _count: 1 },
    { severity: "MEDIUM", _count: 1 },
  ]);
  (prisma.visit.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({ _sum: { price: null } });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDashboardService(prisma).getKpis();
  expect(result.openComplaintsByPriority).toEqual({ high: 1, medium: 1, low: 0 });
  expect(result.openComplaints).toBe(2);
});

it("getKpis severity bucketing: multiple complaints per severity, including an unexpected severity value bucketed to low", async () => {
  const prisma = makePrisma();
  (prisma.visit.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (prisma.complaint.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { severity: "HIGH", _count: 3 },
    { severity: "MEDIUM", _count: 2 },
    { severity: "LOW", _count: 4 },
    { severity: "UNKNOWN", _count: 1 },
  ]);
  (prisma.visit.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({ _sum: { price: null } });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDashboardService(prisma).getKpis();
  expect(result.openComplaintsByPriority).toEqual({ high: 3, medium: 2, low: 5 });
  expect(result.openComplaints).toBe(10);
});

it("getKpis unpaid amount/count: empty state (zero matching visits)", async () => {
  const prisma = makePrisma();
  (prisma.visit.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (prisma.complaint.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({ _sum: { price: null } });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDashboardService(prisma).getKpis();
  expect(result.cleanUnpaidAmount).toBe(0);
  expect(result.cleanUnpaidCount).toBe(0);
});

it("getKpis unpaid amount/count: one customer with multiple unpaid visits dedupes the count but sums via aggregate", async () => {
  const prisma = makePrisma();
  (prisma.visit.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (prisma.complaint.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.aggregate as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ _sum: { price: decimal(260) } }) // unpaid aggregate
    .mockResolvedValueOnce({ _sum: { price: decimal(0) } }); // monthly revenue aggregate
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { property: { customerId: "c1" } },
    { property: { customerId: "c1" } },
    { property: { customerId: "c2" } },
  ]);
  const result = await createDashboardService(prisma).getKpis();
  expect(result.cleanUnpaidAmount).toBe(260);
  expect(result.cleanUnpaidCount).toBe(2);
});

it("getKpis monthly revenue: visit exactly at a UTC month-boundary timestamp is summed via the aggregate mock", async () => {
  const prisma = makePrisma();
  (prisma.visit.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);
  (prisma.complaint.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.aggregate as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ _sum: { price: null } }) // unpaid aggregate
    .mockResolvedValueOnce({ _sum: { price: decimal(1999.5) } }); // monthly revenue aggregate
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDashboardService(prisma).getKpis();
  expect(result.monthlyRevenue).toBe(1999.5);
  expect(result.jobsScheduledToday).toBe(5);
});

// ── getChartData ─────────────────────────────────────────────────────────────

it("getChartData is a function", () => {
  expect(typeof createDashboardService(makePrisma()).getChartData).toBe("function");
});

it("getChartData: a visit with 2 linked issues is NOT double-counted in that month's revenue", async () => {
  // Regression test for the LEFT JOIN Visit->Issue fan-out bug: summing
  // v.price through a one-to-many join to Issue counted a visit's price
  // once per linked issue (a £100 visit with 2 issues summed as £200).
  // getChartData() now runs two independent queries instead of one join —
  // this test asserts the ACTUAL aggregation result, not that a query ran.
  const prisma = makePrisma();
  const now = new Date();
  const visitDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15));
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { date: visitDate, _sum: { price: decimal(100) } },
  ]);
  (prisma.issue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { visit: { date: visitDate } },
    { visit: { date: visitDate } },
  ]);

  const result = await createDashboardService(prisma).getChartData("6m");

  const idx = result.valueCompleted.findIndex((v) => v > 0);
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(result.valueCompleted[idx]).toBe(100); // not 200
  expect(result.issueCount[idx]).toBe(2); // issue count is unaffected, correctly 2
});

it("getChartData: a month with zero visits still appears as a zero entry, not skipped", async () => {
  const prisma = makePrisma();
  // Only one month out of the 6 has data; the other 5 must still appear as zeros.
  const now = new Date();
  const dataDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 10));
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { date: dataDate, _sum: { price: decimal(500) } },
  ]);
  (prisma.issue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { visit: { date: dataDate } },
    { visit: { date: dataDate } },
  ]);
  const result = await createDashboardService(prisma).getChartData("6m");
  expect(result.months).toHaveLength(6);
  expect(result.valueCompleted).toHaveLength(6);
  expect(result.issueCount).toHaveLength(6);
  const zeroCount = result.valueCompleted.filter((v) => v === 0).length;
  expect(zeroCount).toBe(5);
  expect(result.valueCompleted).toContain(500);
  expect(result.issueCount).toContain(2);
});

it("getChartData: sums multiple distinct visit-dates within the same month", async () => {
  const prisma = makePrisma();
  const now = new Date();
  const d1 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 3));
  const d2 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 20));
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { date: d1, _sum: { price: decimal(1234.56) } },
    { date: d2, _sum: { price: decimal(65.44) } },
  ]);
  (prisma.issue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { visit: { date: d1 } },
  ]);
  const result = await createDashboardService(prisma).getChartData("6m");
  const idx = result.valueCompleted.findIndex((v) => v === 1300);
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(result.issueCount[idx]).toBe(1);
  expect(result.revenuePerHour).toBeNull();
});

it("getChartData: a visit-date group with a null price sum (defensive) contributes 0", async () => {
  const prisma = makePrisma();
  const now = new Date();
  const d1 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 3));
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { date: d1, _sum: { price: null } },
  ]);
  (prisma.issue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDashboardService(prisma).getChartData("6m");
  expect(result.valueCompleted.every((v) => v === 0)).toBe(true);
});

it("getChartData: month labels align correctly across a year boundary (Nov-Apr window)", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.issue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  vi.setSystemTime(new Date(Date.UTC(2026, 3, 15))); // April 2026, local-independent via UTC
  const result = await createDashboardService(prisma).getChartData("6m");
  expect(result.months).toEqual(["Nov", "Dec", "Jan", "Feb", "Mar", "Apr"]);
  vi.useRealTimers();
});

it("getChartData: no technicianIds omits the technicianId filter from both queries", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.issue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createDashboardService(prisma).getChartData("6m");
  const groupByCall = (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mock.calls[0][0];
  const findManyCall = (prisma.issue.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(groupByCall.where.technicianId).toBeUndefined();
  expect(findManyCall.where.visit.technicianId).toBeUndefined();
});

it("getChartData: an empty technicianIds array omits the technicianId filter", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.issue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createDashboardService(prisma).getChartData("6m", []);
  const groupByCall = (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(groupByCall.where.technicianId).toBeUndefined();
});

it("getChartData: technicianIds filters both the revenue groupBy and the issue findMany", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.issue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createDashboardService(prisma).getChartData("6m", ["t1", "t2"]);
  const groupByCall = (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mock.calls[0][0];
  const findManyCall = (prisma.issue.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(groupByCall.where.technicianId).toEqual({ in: ["t1", "t2"] });
  expect(findManyCall.where.visit.technicianId).toEqual({ in: ["t1", "t2"] });
});

it("getChartData: 12m range returns 12 months", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.issue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDashboardService(prisma).getChartData("12m");
  expect(result.months).toHaveLength(12);
});

// ── getTechnicianKpis ────────────────────────────────────────────────────────

it("getTechnicianKpis is a function", () => {
  expect(typeof createDashboardService(makePrisma()).getTechnicianKpis).toBe("function");
});

it("getTechnicianKpis: every active technician appears, zeroed (timing null) when they have no data", async () => {
  const prisma = makePrisma();
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", name: "Sam" },
    { id: "t2", name: "Alex" },
  ]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      technicianId: "t1",
      price: 30,
      startedAt: new Date("2026-10-01T09:00:00Z"),
      completedAt: new Date("2026-10-01T09:30:00Z"),
      _count: { issues: 1 },
    },
  ]);

  const result = await createDashboardService(prisma).getTechnicianKpis("monthly");

  expect(result).toEqual([
    {
      technicianId: "t1", technicianName: "Sam", jobsCompleted: 1, valueCompleted: 30, issueCount: 1,
      openComplaints: 0, timeOnJobMinutes: 30, revenuePerHour: 60, strikes: 0, damages: 0, upsells: 0, upsellValue: 0,
    },
    {
      technicianId: "t2", technicianName: "Alex", jobsCompleted: 0, valueCompleted: 0, issueCount: 0,
      openComplaints: 0, timeOnJobMinutes: null, revenuePerHour: null, strikes: 0, damages: 0, upsells: 0, upsellValue: 0,
    },
  ]);
});

it("getTechnicianKpis: yearly period uses Jan 1 - Jan 1 next year boundaries", async () => {
  const prisma = makePrisma();
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createDashboardService(prisma).getTechnicianKpis("yearly");
  const where = (prisma.visit.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
  const y = new Date().getUTCFullYear();
  expect(where.date).toEqual({ gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) });
});

// ── getAlerts ────────────────────────────────────────────────────────────────

it("getAlerts returns the counts plus this month's KPI_THRESHOLD alerts", async () => {
  const prisma = makePrisma();
  (prisma.visit.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);
  (prisma.payment.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  (prisma.complaint.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
  const createdAt = new Date();
  (prisma.kpiAlert.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "a1", technicianId: "t1", technician: { name: "Sam" }, metric: "strikes",
      value: 4, threshold: 3, operator: "GT", periodKey: "2026-10", createdAt,
    },
  ]);

  const result = await createDashboardService(prisma).getAlerts();

  expect(result).toEqual({
    skippedNeedingReview: 2,
    failedPayments: 1,
    complaintRevisitsDue: 3,
    kpiAlerts: [
      {
        type: "KPI_THRESHOLD", id: "a1", technicianId: "t1", technicianName: "Sam", metric: "strikes",
        value: 4, threshold: 3, operator: "GT", periodKey: "2026-10", createdAt,
      },
    ],
  });
  const now = new Date();
  const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  expect((prisma.kpiAlert.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toEqual({ periodKey: key });
});
