import { it, expect, vi } from "vitest";
import { computeTechnicianKpis, emptyKpis, parseKpiPeriod, periodRange } from "../technician-kpi.service";

const NOW = new Date("2026-10-30T15:00:00Z");
const d = (s: string) => new Date(s);

it("periodRange covers every period in UTC", () => {
  expect(periodRange("thisMonth", NOW)).toEqual({ start: d("2026-10-01T00:00:00Z"), end: d("2026-11-01T00:00:00Z") });
  expect(periodRange("monthly", NOW)).toEqual(periodRange("thisMonth", NOW));
  expect(periodRange("lastMonth", NOW)).toEqual({ start: d("2026-09-01T00:00:00Z"), end: d("2026-10-01T00:00:00Z") });
  expect(periodRange("thisYear", NOW)).toEqual({ start: d("2026-01-01T00:00:00Z"), end: d("2027-01-01T00:00:00Z") });
  expect(periodRange("yearly", NOW)).toEqual(periodRange("thisYear", NOW));
  expect(periodRange("last30", NOW)).toEqual({ start: d("2026-10-01T00:00:00Z"), end: d("2026-10-31T00:00:00Z") });
  expect(periodRange("last90", NOW)).toEqual({ start: d("2026-08-02T00:00:00Z"), end: d("2026-10-31T00:00:00Z") });
});

it("parseKpiPeriod accepts known periods, defaults when omitted, 400s otherwise", () => {
  expect(parseKpiPeriod(undefined, "thisMonth")).toBe("thisMonth");
  expect(parseKpiPeriod("last90", "thisMonth")).toBe("last90");
  expect(() => parseKpiPeriod("forever", "thisMonth")).toThrow(/period must be one of/);
  expect(() => parseKpiPeriod(["x"], "thisMonth")).toThrow();
});

function makeTp() {
  return {
    visit: { findMany: vi.fn().mockResolvedValue([]) },
    technicianIncident: { groupBy: vi.fn().mockResolvedValue([]) },
    complaint: { findMany: vi.fn().mockResolvedValue([]) },
  } as any;
}

const RANGE = periodRange("thisMonth", NOW);

it("computeTechnicianKpis computes time on job, revenue per hour, incidents and complaint counts", async () => {
  const tp = makeTp();
  tp.visit.findMany.mockResolvedValue([
    // 30 min, £30
    { technicianId: "t1", price: 30, startedAt: d("2026-10-02T09:00:00Z"), completedAt: d("2026-10-02T09:30:00Z"), _count: { issues: 1 } },
    // 60 min, £20
    { technicianId: "t1", price: 20, startedAt: d("2026-10-03T09:00:00Z"), completedAt: d("2026-10-03T10:00:00Z"), _count: { issues: 0 } },
    // untimed: counts towards value, not towards revenue/hour
    { technicianId: "t1", price: 15.5, startedAt: null, completedAt: d("2026-10-04T09:00:00Z"), _count: { issues: 2 } },
    // completedAt before startedAt: ignored for timing
    { technicianId: "t2", price: 10, startedAt: d("2026-10-05T10:00:00Z"), completedAt: d("2026-10-05T09:00:00Z"), _count: { issues: 0 } },
  ]);
  tp.technicianIncident.groupBy.mockResolvedValue([
    { technicianId: "t1", type: "STRIKE", _count: 2, _sum: { amount: null } },
    { technicianId: "t1", type: "DAMAGE", _count: 1, _sum: { amount: 50 } },
    { technicianId: "t1", type: "UPSELL", _count: 3, _sum: { amount: 45.5 } },
    { technicianId: "t3", type: "UPSELL", _count: 1, _sum: { amount: null } },
  ]);
  tp.complaint.findMany.mockResolvedValue([
    // open, logged this period, upheld this period → open + complaint + strike
    { technicianId: "t1", status: "OPEN", upheld: null, resolvedAt: null, createdAt: d("2026-10-10") },
    // resolved upheld this period, logged last month → strike only
    { technicianId: "t1", status: "RESOLVED", upheld: true, resolvedAt: d("2026-10-12"), createdAt: d("2026-09-20") },
    // upheld last month but logged this period → complaint only
    { technicianId: "t1", status: "RESOLVED", upheld: true, resolvedAt: d("2026-09-12"), createdAt: d("2026-10-01") },
    // resolved not upheld, logged this period → complaint
    { technicianId: "t2", status: "RESOLVED", upheld: false, resolvedAt: d("2026-10-12"), createdAt: d("2026-10-11") },
    // open, logged before the period → open only
    { technicianId: "t2", status: "IN_REVIEW", upheld: null, resolvedAt: null, createdAt: d("2026-08-11") },
  ]);

  const map = await computeTechnicianKpis(tp, RANGE);

  expect(map.get("t1")).toEqual({
    jobsCompleted: 3,
    valueCompleted: 65.5,
    issueCount: 3,
    timeOnJobMinutes: 90,
    revenuePerHour: 33.33, // £50 / 1.5h
    strikes: 3,
    damages: 1,
    upsells: 3,
    upsellValue: 45.5,
    openComplaints: 1,
    complaints: 2,
  });
  expect(map.get("t2")).toMatchObject({
    jobsCompleted: 1,
    timeOnJobMinutes: null,
    revenuePerHour: null,
    openComplaints: 1,
    complaints: 1,
    strikes: 0,
  });
  expect(map.get("t3")).toMatchObject({ upsells: 1, upsellValue: 0, jobsCompleted: 0 });

  // Unscoped: technicianId not null; no technicianId filter on incidents.
  expect(tp.visit.findMany.mock.calls[0][0].where.technicianId).toEqual({ not: null });
  expect(tp.technicianIncident.groupBy.mock.calls[0][0].where.technicianId).toBeUndefined();
});

it("computeTechnicianKpis scopes every query to the given technicians", async () => {
  const tp = makeTp();
  const map = await computeTechnicianKpis(tp, RANGE, ["t1"]);
  expect(map.size).toBe(0);
  expect(tp.visit.findMany.mock.calls[0][0].where.technicianId).toEqual({ in: ["t1"] });
  expect(tp.technicianIncident.groupBy.mock.calls[0][0].where.technicianId).toEqual({ in: ["t1"] });
  expect(tp.complaint.findMany.mock.calls[0][0].where.technicianId).toEqual({ in: ["t1"] });
});

it("emptyKpis has zero counts and null timing", () => {
  expect(emptyKpis()).toMatchObject({ jobsCompleted: 0, timeOnJobMinutes: null, revenuePerHour: null, strikes: 0 });
});
