import { it, expect, vi, beforeEach } from "vitest";

const { tenantFindMany, evaluate, notifyAdmins } = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  evaluate: vi.fn(),
  notifyAdmins: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: tenantFindMany } } }));
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: vi.fn((schema: string) => ({ schema })),
}));
vi.mock("../../services/kpi-threshold.service", () => ({
  createKpiThresholdService: vi.fn(() => ({ evaluate })),
}));
vi.mock("../../services/notify", () => ({ notifyAdmins }));

import { runKpiThresholdCheck } from "../kpiThresholds";

const NOW = new Date("2026-10-30T02:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  notifyAdmins.mockResolvedValue(2);
});

it("evaluates every tenant, notifies ADMIN and MANAGER profiles per new alert and isolates tenant failures", async () => {
  tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }, { schemaName: "t_b" }, { schemaName: "t_c" }]);
  evaluate
    .mockResolvedValueOnce([
      { technicianId: "t1", technicianName: "Sam", metric: "strikes", value: 4, threshold: 3, operator: "GT" },
      { technicianId: "t2", technicianName: null, metric: "revenuePerHour", value: 20, threshold: 30, operator: "LT" },
    ])
    .mockRejectedValueOnce(new Error("schema gone"))
    .mockResolvedValueOnce([]);
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await runKpiThresholdCheck(NOW);

  expect(result).toEqual({ alertsCreated: 2 });
  expect(evaluate).toHaveBeenCalledWith(NOW);
  expect(notifyAdmins).toHaveBeenCalledTimes(2);
  expect(notifyAdmins).toHaveBeenCalledWith(
    { schema: "t_a" },
    { type: "KPI_ALERT", title: "KPI threshold crossed", body: "Sam: strikes is 4 (above 3)." }
  );
  expect(notifyAdmins).toHaveBeenCalledWith(
    { schema: "t_a" },
    { type: "KPI_ALERT", title: "KPI threshold crossed", body: "A technician: revenuePerHour is 20 (below 30)." }
  );
  expect(errSpy).toHaveBeenCalledWith("[kpiThresholds] t_b:", expect.any(Error));
  errSpy.mockRestore();
});

it("defaults `now` to the current time", async () => {
  tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }]);
  evaluate.mockResolvedValue([]);
  await runKpiThresholdCheck();
  expect(evaluate.mock.calls[0][0]).toBeInstanceOf(Date);
  expect(notifyAdmins).not.toHaveBeenCalled();
});
