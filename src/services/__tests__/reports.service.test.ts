import { it, expect, vi, beforeEach } from "vitest";

const { profileFindMany } = vi.hoisted(() => ({
  profileFindMany: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../lib/prisma", () => ({
  prisma: { profile: { findMany: profileFindMany } },
}));

import { createReportsService } from "../reports.service";

beforeEach(() => {
  profileFindMany.mockReset();
  profileFindMany.mockResolvedValue([]);
});

function makePrisma() {
  return {
    visit: { findMany: vi.fn(), count: vi.fn().mockResolvedValue(0), groupBy: vi.fn(), aggregate: vi.fn() },
    invoice: { findMany: vi.fn(), aggregate: vi.fn() },
    round: { findMany: vi.fn() },
    technician: { findMany: vi.fn() },
    activityLog: { findMany: vi.fn(), create: vi.fn(), count: vi.fn().mockResolvedValue(0) },
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
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].completed).toBe(1);
  expect(result.rows[0].skipped).toBe(1);
  expect(result.rows[0].name).toBe("James");
  expect(result.rows[0].email).toBe("j@x.com");
  expect(result.pagination).toEqual({ page: 1, pageSize: 50, total: 1, totalPages: 1 });
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
  expect(result.rows[0].efficiency).toBe(67);
  expect(result.rows[0].revenueImpact).toBe(70);
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
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].completed).toBe(0);
  expect(result.rows[0].skipped).toBe(3);
  expect(result.rows[0].efficiency).toBe(0);
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
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].technicianId).toBe("t1");
});

it("getTechnicians: a technicianId present in groups but missing from the technician lookup (e.g. deleted) falls back to null name/email", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t-gone", status: "COMPLETED", _count: 1, _sum: { price: { toNumber: () => 35 } } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result.rows[0].name).toBeNull();
  expect(result.rows[0].email).toBeNull();
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
  expect(result.rows[0].revenueImpact).toBe(0);
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
  expect(result.rows[0].completed).toBe(0);
  expect(result.rows[0].skipped).toBe(0);
  expect(result.rows[0].efficiency).toBe(0);
});

it("getTechnicians: no visits in range returns an empty rows array without querying technician.findMany", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result.rows).toEqual([]);
  expect(result.pagination).toEqual({ page: 1, pageSize: 50, total: 0, totalPages: 0 });
  expect(prisma.technician.findMany).not.toHaveBeenCalled();
});

it("getTechnicians sorts by name (then id) for stable pagination and slices by page/pageSize", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t1", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
    { technicianId: "t2", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
    { technicianId: "t3", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", name: "Priya", email: null },
    { id: "t2", name: "Alice", email: null },
    { id: "t3", name: "James", email: null },
  ]);
  const result = await createReportsService(prisma).getTechnicians("last30", 2, 1);
  expect(result.rows).toHaveLength(1);
  // Alphabetical by name: Alice, James, Priya — page 2 (pageSize 1) is "James".
  expect(result.rows[0].name).toBe("James");
  expect(result.pagination).toEqual({ page: 2, pageSize: 1, total: 3, totalPages: 3 });
});

it("getTechnicians sort breaks a name tie by technicianId, and treats a null name as empty string", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t2", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
    { technicianId: "t1", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
    { technicianId: "t3", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", name: "Sam", email: null },
    { id: "t2", name: "Sam", email: null },
    { id: "t3", name: null, email: null },
  ]);
  const result = await createReportsService(prisma).getTechniciansExport("last30");
  // t3 (null name -> "") sorts first, then the "Sam" tie breaks by id: t1 before t2.
  expect(result.map((r) => r.technicianId)).toEqual(["t3", "t1", "t2"]);
});

it("getTechnicians sort handles a null name on either side of the comparison (order A)", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t-null", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
    { technicianId: "t-named", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t-null", name: null, email: null },
    { id: "t-named", name: "Zed", email: null },
  ]);
  const result = await createReportsService(prisma).getTechniciansExport("last30");
  expect(result.map((r) => r.technicianId)).toEqual(["t-null", "t-named"]);
});

it("getTechnicians sort handles a null name on either side of the comparison (order B)", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t-named", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
    { technicianId: "t-null", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t-named", name: "Zed", email: null },
    { id: "t-null", name: null, email: null },
  ]);
  const result = await createReportsService(prisma).getTechniciansExport("last30");
  expect(result.map((r) => r.technicianId)).toEqual(["t-null", "t-named"]);
});

it("getTechniciansExport returns the full unpaginated technician row list", async () => {
  const prisma = makePrisma();
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t1", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
    { technicianId: "t2", status: "COMPLETED", _count: 1, _sum: { price: decimal(10) } },
  ]);
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "t1", name: "Priya", email: null },
    { id: "t2", name: "Alice", email: null },
  ]);
  const result = await createReportsService(prisma).getTechniciansExport("last30");
  expect(result).toHaveLength(2);
  expect(result[0].name).toBe("Alice");
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
  expect(result.rows[0].date).toBeDefined();
  expect(result.rows[0].status).toBe("COMPLETED");
  expect(result.rows[0].amount).toBe(35);
  expect(result.pagination).toEqual({ page: 1, pageSize: 50, total: 0, totalPages: 0 });
});

it("getVisits applies the status filter when given", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createReportsService(prisma).getVisits("last30", "SKIPPED");
  const call = (prisma.visit.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.status).toBe("SKIPPED");
});

it("getVisits falls back to blank/null fields when property, round, or technician is missing", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{
    id: "v1", date: new Date("2026-08-01"), status: "SCHEDULED", price: { toNumber: () => 0 },
    property: null, round: null, technician: null,
  }]);
  const result = await createReportsService(prisma).getVisits("last30");
  expect(result.rows[0]).toMatchObject({ property: "", postcode: null, round: null, technician: null });
});

it("getVisits applies the 'today' period range branch", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createReportsService(prisma).getVisits("today");
  expect(prisma.visit.findMany).toHaveBeenCalled();
});

it("getVisits applies the 'last7' period range branch", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createReportsService(prisma).getVisits("last7");
  expect(prisma.visit.findMany).toHaveBeenCalled();
});

it("getVisitsExport falls back to blank/null fields when property, round, or technician is missing", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{
    id: "v1", date: new Date("2026-08-01"), status: "SCHEDULED", price: { toNumber: () => 0 },
    property: null, round: null, technician: null,
  }]);
  const result = await createReportsService(prisma).getVisitsExport("last30");
  expect(result[0]).toMatchObject({ property: "", postcode: null, round: null, technician: null });
});

it("getVisits threads page/pageSize into take/skip and returns matching pagination metadata", async () => {
  const prisma = makePrisma();
  (prisma.visit.count as ReturnType<typeof vi.fn>).mockResolvedValue(120);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getVisits("last30", undefined, 3, 20);
  const call = (prisma.visit.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.take).toBe(20);
  expect(call.skip).toBe(40);
  expect(result.pagination).toEqual({ page: 3, pageSize: 20, total: 120, totalPages: 6 });
});

it("getVisitsExport returns the full unpaginated row list (no take/skip)", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{
    id: "v1", date: new Date("2026-08-01"), status: "COMPLETED", price: { toNumber: () => 35 },
    property: { addressLine: "12 Castle View", postcode: "NE61 1AB" },
    round: { name: "Alnwick Monday" },
    technician: { name: "James" },
  }]);
  const result = await createReportsService(prisma).getVisitsExport("last30");
  expect(result).toHaveLength(1);
  expect(result[0].amount).toBe(35);
  const call = (prisma.visit.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.take).toBeUndefined();
  expect(call.skip).toBeUndefined();
  expect(prisma.visit.count).not.toHaveBeenCalled();
});

it("getVisitsExport applies the status filter", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createReportsService(prisma).getVisitsExport("last30", "SKIPPED");
  const call = (prisma.visit.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.status).toBe("SKIPPED");
});

it("getActivity is a function", () => {
  expect(typeof createReportsService(makePrisma()).getActivity).toBe("function");
});

it("getActivity returns log entries with type and message", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "al-1", type: "PROPERTY_ADDED", message: "Property added: 18 Green Lane", actorRole: "Admin", actorId: null, createdAt: new Date() },
  ]);
  (prisma.activityLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  const result = await createReportsService(prisma).getActivity();
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].type).toBe("PROPERTY_ADDED");
  expect(result.rows[0].message).toBe("Property added: 18 Green Lane");
  expect(result.pagination).toEqual({ page: 1, pageSize: 50, total: 1, totalPages: 1 });
});

it("getActivity passes type filter to the query", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createReportsService(prisma).getActivity("PROPERTY_ADDED");
  const call = (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.type).toBe("PROPERTY_ADDED");
});

it("getActivity omits the createdAt filter when neither from nor to is given", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  await createReportsService(prisma).getActivity();
  const call = (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.createdAt).toBeUndefined();
});

it("getActivity applies a from/to createdAt range filter", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const from = new Date("2026-01-01T00:00:00.000Z");
  const to = new Date("2026-01-31T00:00:00.000Z");
  await createReportsService(prisma).getActivity(undefined, from, to);
  const call = (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.createdAt).toEqual({ gte: from, lte: to });
});

it("getActivity applies only a 'from' bound when 'to' is omitted", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const from = new Date("2026-01-01T00:00:00.000Z");
  await createReportsService(prisma).getActivity(undefined, from, undefined);
  const call = (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.createdAt).toEqual({ gte: from });
});

it("getActivity applies only a 'to' bound when 'from' is omitted", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const to = new Date("2026-01-31T00:00:00.000Z");
  await createReportsService(prisma).getActivity(undefined, undefined, to);
  const call = (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.where.createdAt).toEqual({ lte: to });
});

it("getActivity resolves actorName from the control-plane Profile table, deduped across repeated actors", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "al-1", type: "A", message: "m1", actorRole: "ADMIN", actorId: "p1", createdAt: new Date() },
    { id: "al-2", type: "A", message: "m2", actorRole: "ADMIN", actorId: "p1", createdAt: new Date() },
  ]);
  profileFindMany.mockResolvedValueOnce([{ id: "p1", name: "Jordan" }]);
  const result = await createReportsService(prisma).getActivity();
  expect(result.rows[0].actorName).toBe("Jordan");
  expect(result.rows[1].actorName).toBe("Jordan");
  expect(profileFindMany).toHaveBeenCalledTimes(1);
  expect(profileFindMany).toHaveBeenCalledWith({ where: { id: { in: ["p1"] } }, select: { id: true, name: true } });
});

it("getActivity does not query Profile when no log has an actorId", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "al-1", type: "A", message: "m1", actorRole: null, actorId: null, createdAt: new Date() },
  ]);
  const result = await createReportsService(prisma).getActivity();
  expect(result.rows[0].actorName).toBeNull();
  expect(profileFindMany).not.toHaveBeenCalled();
});

it("getActivity defaults actorName to null when the actorId has no matching Profile (e.g. deleted)", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "al-1", type: "A", message: "m1", actorRole: "ADMIN", actorId: "p-gone", createdAt: new Date() },
  ]);
  profileFindMany.mockResolvedValueOnce([]);
  const result = await createReportsService(prisma).getActivity();
  expect(result.rows[0].actorName).toBeNull();
});

it("getActivity threads page/pageSize into take/skip", async () => {
  const prisma = makePrisma();
  (prisma.activityLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(75);
  (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getActivity(undefined, undefined, undefined, 2, 25);
  const call = (prisma.activityLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.take).toBe(25);
  expect(call.skip).toBe(25);
  expect(result.pagination).toEqual({ page: 2, pageSize: 25, total: 75, totalPages: 3 });
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
