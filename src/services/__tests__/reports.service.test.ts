import { it, expect, vi } from "vitest";

import { createReportsService } from "../reports.service";

function makePrisma() {
  return {
    visit: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn() },
    invoice: { findMany: vi.fn(), aggregate: vi.fn() },
    round: { findMany: vi.fn() },
    technician: { findMany: vi.fn() },
    activityLog: { findMany: vi.fn(), create: vi.fn() },
    $queryRaw: vi.fn(),
  } as unknown as Parameters<typeof createReportsService>[0];
}

function decimal(n: number) {
  return { toNumber: () => n };
}

it("createReportsService returns an object", () => {
  expect(createReportsService(makePrisma())).toBeDefined();
});

it("getSummary is a function", () => {
  expect(typeof createReportsService(makePrisma()).getSummary).toBe("function");
});

function mockSummaryDeps(
  prisma: ReturnType<typeof makePrisma>,
  opts: {
    visitAgg?: { _count: number; _sum: { price: { toNumber(): number } | null } };
    roundGroups?: Array<{ roundId: string | null }>;
    invoiceAgg?: { _sum: { amount: { toNumber(): number } | null } };
  }
) {
  (prisma.visit.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
    opts.visitAgg ?? { _count: 0, _sum: { price: null } }
  );
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue(opts.roundGroups ?? []);
  (prisma.invoice.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
    opts.invoiceAgg ?? { _sum: { amount: null } }
  );
}

it("getSummary result has totalRevenue", async () => {
  const prisma = makePrisma();
  mockSummaryDeps(prisma, {});
  const result = await createReportsService(prisma).getSummary("last30");
  expect("totalRevenue" in result).toBe(true);
});

it("getSummary result has completedVisits", async () => {
  const prisma = makePrisma();
  mockSummaryDeps(prisma, {});
  const result = await createReportsService(prisma).getSummary("last30");
  expect("completedVisits" in result).toBe(true);
});

it("getSummary completedVisits comes from the COMPLETED-scoped aggregate count", async () => {
  const prisma = makePrisma();
  mockSummaryDeps(prisma, {
    visitAgg: { _count: 1, _sum: { price: decimal(35) } },
  });
  const result = await createReportsService(prisma).getSummary("last30");
  expect(result.completedVisits).toBe(1);
  const call = (prisma.visit.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.status).toBe("COMPLETED");
});

it("getSummary result has completedRounds", async () => {
  const prisma = makePrisma();
  mockSummaryDeps(prisma, {});
  const result = await createReportsService(prisma).getSummary("last30");
  expect("completedRounds" in result).toBe(true);
});

it("getSummary completedRounds is the distinct-round groupBy row count (not a sum)", async () => {
  const prisma = makePrisma();
  mockSummaryDeps(prisma, {
    visitAgg: { _count: 3, _sum: { price: decimal(105) } },
    roundGroups: [{ roundId: "r1" }, { roundId: "r2" }],
  });
  const result = await createReportsService(prisma).getSummary("last30");
  expect(result.completedRounds).toBe(2);
  const call = (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.by).toEqual(["roundId"]);
  expect(call.where.roundId).toEqual({ not: null });
  expect(call.where.status).toBe("COMPLETED");
});

it("getSummary result has undonePayments", async () => {
  const prisma = makePrisma();
  mockSummaryDeps(prisma, {});
  const result = await createReportsService(prisma).getSummary("last30");
  expect("undonePayments" in result).toBe(true);
});

it("getSummary undonePayments sums SENT invoice amounts via aggregate", async () => {
  const prisma = makePrisma();
  mockSummaryDeps(prisma, {
    invoiceAgg: { _sum: { amount: decimal(135) } },
  });
  const result = await createReportsService(prisma).getSummary("last30");
  expect(result.undonePayments).toBe(135);
  const call = (prisma.invoice.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.status).toBe("SENT");
});

it("getSummary totalRevenue/completedVisits/completedRounds/undonePayments default to 0/empty when nothing matches", async () => {
  const prisma = makePrisma();
  mockSummaryDeps(prisma, {});
  const result = await createReportsService(prisma).getSummary("last30");
  expect(result).toEqual({ totalRevenue: 0, completedVisits: 0, completedRounds: 0, undonePayments: 0 });
});

it("getRevenue is a function", () => {
  expect(typeof createReportsService(makePrisma()).getRevenue).toBe("function");
});

it("getRevenue returns an array", async () => {
  const prisma = makePrisma();
  (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getRevenue("last30");
  expect(Array.isArray(result)).toBe(true);
});

it("getRevenue items have date and amount fields, with numeric-string amount converted to a number", async () => {
  const prisma = makePrisma();
  (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
    { day: new Date("2026-08-01T00:00:00.000Z"), amount: "35" },
  ]);
  const result = await createReportsService(prisma).getRevenue("last30");
  expect(result.length).toBeGreaterThan(0);
  expect("date" in result[0]).toBe(true);
  expect("amount" in result[0]).toBe(true);
  expect(result[0].date).toBe("2026-08-01");
  expect(result[0].amount).toBe(35);
});

it("getRevenue: the SQL already groups by day, so one row per day is returned as-is (day-granularity grouping is done in SQL, not JS)", async () => {
  const prisma = makePrisma();
  (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
    { day: new Date("2026-08-01T00:00:00.000Z"), amount: "85" },
  ]);
  const result = await createReportsService(prisma).getRevenue("last30");
  expect(result).toHaveLength(1);
  expect(result[0].amount).toBe(85);
});

it("getTechnicians is a function", () => {
  expect(typeof createReportsService(makePrisma()).getTechnicians).toBe("function");
});

it("getTechnicians items have completed and skipped fields", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t1", status: "COMPLETED", _count: 1, _sum: { price: { toNumber: () => 35 } } },
    { technicianId: "t1", status: "SKIPPED", _count: 1, _sum: { price: { toNumber: () => 0 } } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", name: "James", email: "j@x.com" },
  ]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result).toHaveLength(1);
  expect(result[0].completed).toBe(1);
  expect(result[0].skipped).toBe(1);
  expect(result[0].name).toBe("James");
  expect(result[0].email).toBe("j@x.com");
});

it("getTechnicians efficiency is completed / (completed + skipped) * 100, aggregated from groupBy counts", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t1", status: "COMPLETED", _count: 2, _sum: { price: { toNumber: () => 70 } } },
    { technicianId: "t1", status: "SKIPPED", _count: 1, _sum: { price: { toNumber: () => 0 } } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", name: "James", email: null },
  ]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result[0].efficiency).toBe(67);
  expect(result[0].revenueImpact).toBe(70);
});

it("getTechnicians: a technician whose visits are all SKIPPED (zero completed) still appears with 0% efficiency", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t1", status: "SKIPPED", _count: 3, _sum: { price: { toNumber: () => 0 } } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", name: "James", email: null },
  ]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result).toHaveLength(1);
  expect(result[0].completed).toBe(0);
  expect(result[0].skipped).toBe(3);
  expect(result[0].efficiency).toBe(0);
});

it("getTechnicians: a null technicianId group (defensive, shouldn't occur given the where filter) is skipped", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: null, status: "COMPLETED", _count: 1, _sum: { price: { toNumber: () => 35 } } },
    { technicianId: "t1", status: "COMPLETED", _count: 1, _sum: { price: { toNumber: () => 35 } } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", name: "James", email: null },
  ]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result).toHaveLength(1);
  expect(result[0].technicianId).toBe("t1");
});

it("getTechnicians: a technicianId present in groups but missing from the technician lookup (e.g. deleted) falls back to null name/email", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t-gone", status: "COMPLETED", _count: 1, _sum: { price: { toNumber: () => 35 } } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result[0].name).toBeNull();
  expect(result[0].email).toBeNull();
});

it("getTechnicians: a COMPLETED group with a null price sum contributes 0 revenue", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t1", status: "COMPLETED", _count: 1, _sum: { price: null } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", name: "James", email: null },
  ]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result[0].revenueImpact).toBe(0);
});

it("getTechnicians: a technician with only a non-completed/skipped status group (e.g. SCHEDULED) gets 0% efficiency via the zero-denominator branch", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t1", status: "SCHEDULED", _count: 2, _sum: { price: { toNumber: () => 0 } } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", name: "James", email: null },
  ]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result[0].completed).toBe(0);
  expect(result[0].skipped).toBe(0);
  expect(result[0].efficiency).toBe(0);
});

it("getTechnicians: no visits in range returns an empty array without querying technician.findMany", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result).toEqual([]);
  expect(prisma.technician.findMany).not.toHaveBeenCalled();
});

it("getVisits is a function", () => {
  expect(typeof createReportsService(makePrisma()).getVisits).toBe("function");
});

it("getVisits items have date, status and amount", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{
    id: "v1", date: new Date("2026-08-01"), status: "COMPLETED", price: { toNumber: () => 35 },
    property: { addressLine: "12 Castle View", postcode: "NE61 1AB" },
    round: { name: "Alnwick Monday" },
    technician: { name: "James" },
  }]);
  const result = await createReportsService(prisma).getVisits("last30");
  expect(result[0].date).toBeDefined();
  expect(result[0].status).toBe("COMPLETED");
  expect(result[0].amount).toBe(35);
});

it("getActivity is a function", () => {
  expect(typeof createReportsService(makePrisma()).getActivity).toBe("function");
});

it("getActivity returns log entries with type and message", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "al-1", type: "PROPERTY_ADDED", message: "Property added: 18 Green Lane", actorRole: "Admin", createdAt: new Date() },
  ]);
  const result = await createReportsService(prisma).getActivity();
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe("PROPERTY_ADDED");
  expect(result[0].message).toBe("Property added: 18 Green Lane");
});

it("getActivity passes type filter to the query", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createReportsService(prisma).getActivity("PROPERTY_ADDED");
  const call = (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.type).toBe("PROPERTY_ADDED");
});

it("logActivity is a function", () => {
  expect(typeof createReportsService(makePrisma()).logActivity).toBe("function");
});

it("logActivity calls activityLog.create with type and message", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
  await createReportsService(prisma).logActivity("PROPERTY_ADDED", "Property added: 18 Green Lane");
  const call = (prisma.activityLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.data.type).toBe("PROPERTY_ADDED");
  expect(call.data.message).toBe("Property added: 18 Green Lane");
});

it("getSummary totalRevenue sums COMPLETED visit prices via aggregate", async () => {
  const prisma = makePrisma();
  mockSummaryDeps(prisma, {
    visitAgg: { _count: 2, _sum: { price: decimal(85) } },
  });
  const result = await createReportsService(prisma).getSummary("last30");
  expect(result.totalRevenue).toBe(85);
});
