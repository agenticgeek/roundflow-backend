import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: (...a: unknown[]) => tenantFindMany(...a) } } }));
const clients: Record<string, unknown> = {};
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (s: string) => clients[s],
  withTenantClient: (s: string, fn: (c: unknown) => Promise<unknown>) => Promise.resolve().then(() => fn(clients[s])),
}));

import { runOverdueSweep, sweepOverduePayments } from "../overdueSweep";

const mkTp = (count: number) => ({
  payment: { updateMany: vi.fn().mockResolvedValue({ count }) },
  activityLog: { create: vi.fn().mockResolvedValue({}) },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sweepOverduePayments (BE-08)", () => {
  const now = new Date("2026-11-07T15:30:00Z");

  it("marks unsettled non-direct-debit payments whose SENT invoice is past due as OVERDUE", async () => {
    const tp = mkTp(3);
    await expect(sweepOverduePayments(tp as never, now)).resolves.toBe(3);
    expect(tp.payment.updateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["NOT_DUE", "PENDING"] },
        method: { not: "GOCARDLESS" },
        visit: { is: { invoice: { is: { status: "SENT", dueDate: { lt: new Date("2026-11-07T00:00:00Z") } } } } },
      },
      data: { status: "OVERDUE" },
    });
    expect(tp.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "PAYMENTS_MARKED_OVERDUE", message: expect.stringContaining("3 unpaid payments"), details: { count: 3 } }),
    });
  });

  it("singular wording, and nothing is logged when nothing changed (no reminders are ever sent)", async () => {
    const one = mkTp(1);
    await sweepOverduePayments(one as never, now);
    expect(one.activityLog.create.mock.calls[0][0].data.message).toContain("1 unpaid payment passed");
    expect(one.activityLog.create.mock.calls[0][0].data.message).toContain("was marked overdue");

    const none = mkTp(0);
    await expect(sweepOverduePayments(none as never)).resolves.toBe(0);
    expect(none.activityLog.create).not.toHaveBeenCalled();
  });
});

describe("runOverdueSweep", () => {
  it("runs for every tenant and survives one failing", async () => {
    clients.t_a = mkTp(1);
    clients.t_b = { payment: { updateMany: vi.fn().mockRejectedValue(new Error("db")) }, activityLog: { create: vi.fn() } };
    tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }, { schemaName: "t_b" }]);
    await runOverdueSweep(new Date("2026-11-07T00:00:00Z"));
    expect((clients.t_a as ReturnType<typeof mkTp>).payment.updateMany).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[overdueSweep] tenant failed:", expect.any(Error));
  });

  it("defaults to now", async () => {
    tenantFindMany.mockResolvedValue([]);
    await expect(runOverdueSweep()).resolves.toBeUndefined();
  });
});
