import { it, expect, vi } from "vitest";

import { createReportsService } from "../reports.service";

function makePrisma() {
  return {
    visit: { findMany: vi.fn(), count: vi.fn() },
    invoice: { findMany: vi.fn() },
    round: { findMany: vi.fn() },
    technician: { findMany: vi.fn() },
    activityLog: { findMany: vi.fn(), create: vi.fn() },
  } as unknown as Parameters<typeof createReportsService>[0];
}

it("createReportsService returns an object", () => {
  expect(createReportsService(makePrisma())).toBeDefined();
});

it("getSummary is a function", () => {
  expect(typeof createReportsService(makePrisma()).getSummary).toBe("function");
});

it("getSummary result has totalRevenue", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getSummary("last30");
  expect("totalRevenue" in result).toBe(true);
});

it("getSummary result has completedVisits", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getSummary("last30");
  expect("completedVisits" in result).toBe(true);
});

it("getSummary completedVisits counts only COMPLETED visits", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { price: { toNumber: () => 35 }, status: "COMPLETED", roundId: "r1" },
    { price: { toNumber: () => 35 }, status: "SKIPPED",   roundId: "r1" },
  ]);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getSummary("last30");
  expect(result.completedVisits).toBe(1);
});

it("getSummary result has completedRounds", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getSummary("last30");
  expect("completedRounds" in result).toBe(true);
});

it("getSummary completedRounds counts distinct rounds with a COMPLETED visit", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { price: { toNumber: () => 35 }, status: "COMPLETED", roundId: "r1" },
    { price: { toNumber: () => 35 }, status: "COMPLETED", roundId: "r1" },
    { price: { toNumber: () => 35 }, status: "COMPLETED", roundId: "r2" },
  ]);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getSummary("last30");
  expect(result.completedRounds).toBe(2);
});

it("getSummary result has undonePayments", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getSummary("last30");
  expect("undonePayments" in result).toBe(true);
});

it("getSummary undonePayments sums SENT invoice amounts", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { amount: { toNumber: () => 35 } },
    { amount: { toNumber: () => 100 } },
  ]);
  const result = await createReportsService(prisma).getSummary("last30");
  expect(result.undonePayments).toBe(135);
});

it("getRevenue is a function", () => {
  expect(typeof createReportsService(makePrisma()).getRevenue).toBe("function");
});

it("getRevenue returns an array", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getRevenue("last30", "daily");
  expect(Array.isArray(result)).toBe(true);
});

it("getRevenue items have date and amount fields", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { date: new Date("2026-08-01"), price: { toNumber: () => 35 }, status: "COMPLETED" },
  ]);
  const result = await createReportsService(prisma).getRevenue("last30", "daily");
  expect(result.length).toBeGreaterThan(0);
  expect("date" in result[0]).toBe(true);
  expect("amount" in result[0]).toBe(true);
});

it("getRevenue groups visits on the same day into one entry", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { date: new Date("2026-08-01T09:00:00Z"), price: { toNumber: () => 35 }, status: "COMPLETED" },
    { date: new Date("2026-08-01T11:00:00Z"), price: { toNumber: () => 50 }, status: "COMPLETED" },
  ]);
  const result = await createReportsService(prisma).getRevenue("last30", "daily");
  expect(result).toHaveLength(1);
  expect(result[0].amount).toBe(85);
});

it("getTechnicians is a function", () => {
  expect(typeof createReportsService(makePrisma()).getTechnicians).toBe("function");
});

it("getTechnicians items have completed and skipped fields", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t1", status: "COMPLETED", price: { toNumber: () => 35 }, technician: { id: "t1", name: "James", email: "j@x.com" } },
    { technicianId: "t1", status: "SKIPPED",   price: { toNumber: () => 35 }, technician: { id: "t1", name: "James", email: "j@x.com" } },
  ]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result).toHaveLength(1);
  expect(result[0].completed).toBe(1);
  expect(result[0].skipped).toBe(1);
});

it("getTechnicians efficiency is completed / (completed + skipped) * 100", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t1", status: "COMPLETED", price: { toNumber: () => 35 }, technician: { id: "t1", name: "James", email: null } },
    { technicianId: "t1", status: "COMPLETED", price: { toNumber: () => 35 }, technician: { id: "t1", name: "James", email: null } },
    { technicianId: "t1", status: "SKIPPED",   price: { toNumber: () => 35 }, technician: { id: "t1", name: "James", email: null } },
  ]);
  const result = await createReportsService(prisma).getTechnicians("last30");
  expect(result[0].efficiency).toBe(67);
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

it("getSummary totalRevenue sums COMPLETED visit prices", async () => {
  const prisma = makePrisma();
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { price: { toNumber: () => 35 }, status: "COMPLETED", roundId: "r1" },
    { price: { toNumber: () => 50 }, status: "COMPLETED", roundId: "r1" },
  ]);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createReportsService(prisma).getSummary("last30");
  expect(result.totalRevenue).toBe(85);
});
