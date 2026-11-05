import { it, expect, vi, beforeEach } from "vitest";

const { tenantFindMany, profileFindMany, evaluate, createNotification } = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  profileFindMany: vi.fn(),
  evaluate: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { findMany: tenantFindMany }, profile: { findMany: profileFindMany } },
}));
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: vi.fn((schema: string) => ({ schema })),
}));
vi.mock("../../services/kpi-threshold.service", () => ({
  createKpiThresholdService: vi.fn(() => ({ evaluate })),
}));
vi.mock("../../mobile/services/notification.service", () => ({
  createNotificationService: vi.fn(() => ({ create: createNotification })),
}));

import { runKpiThresholdCheck } from "../kpiThresholds";

const NOW = new Date("2026-10-30T02:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  createNotification.mockResolvedValue({});
});

it("evaluates every tenant, notifies ADMINs per new alert and isolates tenant failures", async () => {
  tenantFindMany.mockResolvedValue([
    { id: "ten1", schemaName: "t_a" },
    { id: "ten2", schemaName: "t_b" },
    { id: "ten3", schemaName: "t_c" },
  ]);
  evaluate
    .mockResolvedValueOnce([
      { technicianId: "t1", technicianName: "Sam", metric: "strikes", value: 4, threshold: 3, operator: "GT" },
      { technicianId: "t2", technicianName: null, metric: "revenuePerHour", value: 20, threshold: 30, operator: "LT" },
    ])
    .mockRejectedValueOnce(new Error("schema gone"))
    .mockResolvedValueOnce([]);
  profileFindMany.mockResolvedValue([{ id: "admin1" }, { id: "admin2" }]);
  createNotification.mockRejectedValueOnce(new Error("push failed"));
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await runKpiThresholdCheck(NOW);

  expect(result).toEqual({ alertsCreated: 2 });
  expect(evaluate).toHaveBeenCalledWith(NOW);
  expect(profileFindMany).toHaveBeenCalledTimes(1);
  expect(profileFindMany).toHaveBeenCalledWith({ where: { tenantId: "ten1", role: "ADMIN" }, select: { id: true } });
  expect(createNotification).toHaveBeenCalledTimes(4);
  expect(createNotification).toHaveBeenCalledWith("admin1", "KPI_ALERT", "KPI threshold crossed", "Sam: strikes is 4 (above 3).");
  expect(createNotification).toHaveBeenCalledWith(
    "admin2",
    "KPI_ALERT",
    "KPI threshold crossed",
    "A technician: revenuePerHour is 20 (below 30)."
  );
  expect(errSpy).toHaveBeenCalledWith("[kpiThresholds] t_b:", expect.any(Error));
  errSpy.mockRestore();
});

it("defaults `now` to the current time", async () => {
  tenantFindMany.mockResolvedValue([{ id: "ten1", schemaName: "t_a" }]);
  evaluate.mockResolvedValue([]);
  await runKpiThresholdCheck();
  expect(evaluate.mock.calls[0][0]).toBeInstanceOf(Date);
});
