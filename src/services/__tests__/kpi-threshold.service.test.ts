import { it, expect, vi, beforeEach } from "vitest";

vi.mock("../technician-kpi.service", async (orig) => ({
  ...(await orig<typeof import("../technician-kpi.service")>()),
  computeTechnicianKpis: vi.fn(),
}));

import { createKpiThresholdService, isCrossed, monthPeriodKey } from "../kpi-threshold.service";
import { computeTechnicianKpis, emptyKpis } from "../technician-kpi.service";

const NOW = new Date("2026-10-30T02:00:00Z");

function makeTp() {
  const tx = { kpiThreshold: { deleteMany: vi.fn(), createMany: vi.fn() } };
  return {
    tx,
    tp: {
      kpiThreshold: { findMany: vi.fn().mockResolvedValue([]) },
      technician: { findMany: vi.fn().mockResolvedValue([]) },
      kpiAlert: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
      $transaction: vi.fn((cb: any) => cb(tx)),
    } as any,
  };
}

beforeEach(() => {
  vi.mocked(computeTechnicianKpis).mockReset().mockResolvedValue(new Map());
});

it("monthPeriodKey and isCrossed", () => {
  expect(monthPeriodKey(NOW)).toBe("2026-10");
  expect(monthPeriodKey(new Date("2026-03-05"))).toBe("2026-03");
  expect(isCrossed("GT" as never, 4, 3)).toBe(true);
  expect(isCrossed("GT" as never, 3, 3)).toBe(false);
  expect(isCrossed("LT" as never, 2, 3)).toBe(true);
  expect(isCrossed("LT" as never, 3, 3)).toBe(false);
});

it("list maps Decimal values to numbers", async () => {
  const { tp } = makeTp();
  tp.kpiThreshold.findMany.mockResolvedValue([{ id: "k1", metric: "strikes", operator: "GT", value: "3.00" }]);
  expect(await createKpiThresholdService(tp).list()).toEqual([{ id: "k1", metric: "strikes", operator: "GT", value: 3 }]);
});

it("replaceAll rejects duplicate metric+operator pairs", async () => {
  const { tp } = makeTp();
  await expect(
    createKpiThresholdService(tp).replaceAll([
      { metric: "strikes", operator: "GT" as never, value: 3 },
      { metric: "strikes", operator: "GT" as never, value: 5 },
    ])
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(tp.$transaction).not.toHaveBeenCalled();
});

it("replaceAll deletes all then creates the new set; an empty set only deletes", async () => {
  const { tp, tx } = makeTp();
  const items = [
    { metric: "strikes" as const, operator: "GT" as never, value: 3 },
    { metric: "strikes" as const, operator: "LT" as never, value: 1 },
  ];
  await createKpiThresholdService(tp).replaceAll(items);
  expect(tx.kpiThreshold.deleteMany).toHaveBeenCalledWith({});
  expect(tx.kpiThreshold.createMany).toHaveBeenCalledWith({ data: items });

  await createKpiThresholdService(tp).replaceAll([]);
  expect(tx.kpiThreshold.createMany).toHaveBeenCalledTimes(1);
});

it("evaluate does nothing without thresholds or technicians", async () => {
  const { tp } = makeTp();
  expect(await createKpiThresholdService(tp).evaluate(NOW)).toEqual([]);
  expect(tp.technician.findMany).not.toHaveBeenCalled();

  tp.kpiThreshold.findMany.mockResolvedValue([{ id: "k1", metric: "strikes", operator: "GT", value: 1 }]);
  expect(await createKpiThresholdService(tp).evaluate(NOW)).toEqual([]);
  expect(computeTechnicianKpis).not.toHaveBeenCalled();
});

it("evaluate creates one alert per crossing, skips existing ones and metrics with no data", async () => {
  const { tp } = makeTp();
  tp.kpiThreshold.findMany.mockResolvedValue([
    { id: "k1", metric: "strikes", operator: "GT", value: 2 },
    { id: "k2", metric: "revenuePerHour", operator: "LT", value: 30 },
    { id: "k3", metric: "upsells", operator: "LT", value: 1 },
  ]);
  tp.technician.findMany.mockResolvedValue([
    { id: "t1", name: "Sam" },
    { id: "t2", name: "Alex" },
  ]);
  // t1 already alerted on strikes this month.
  tp.kpiAlert.findMany.mockResolvedValue([{ technicianId: "t1", metric: "strikes" }]);
  vi.mocked(computeTechnicianKpis).mockResolvedValue(
    new Map([["t1", { ...emptyKpis(), strikes: 5, revenuePerHour: 25, upsells: 3 }]])
  );

  const created = await createKpiThresholdService(tp).evaluate(NOW);

  // t1: revenuePerHour 25 < 30. t2 (no data): upsells 0 < 1; revenuePerHour null → skipped; strikes 0 not > 2.
  expect(created).toEqual([
    { technicianId: "t1", technicianName: "Sam", metric: "revenuePerHour", value: 25, threshold: 30, operator: "LT" },
    { technicianId: "t2", technicianName: "Alex", metric: "upsells", value: 0, threshold: 1, operator: "LT" },
  ]);
  expect(tp.kpiAlert.create).toHaveBeenCalledWith({
    data: { technicianId: "t1", metric: "revenuePerHour", value: 25, threshold: 30, operator: "LT", periodKey: "2026-10" },
  });
  expect(tp.kpiAlert.findMany).toHaveBeenCalledWith({ where: { periodKey: "2026-10" }, select: { technicianId: true, metric: true } });
  const [, range, ids] = vi.mocked(computeTechnicianKpis).mock.calls[0];
  expect(range).toEqual({ start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") });
  expect(ids).toEqual(["t1", "t2"]);
});
