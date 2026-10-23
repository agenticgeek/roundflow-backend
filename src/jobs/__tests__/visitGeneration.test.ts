import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { findMany: (...args: unknown[]) => tenantFindMany(...args) } },
}));

const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...args: unknown[]) => getTenantPrismaForSchema(...args),
}));

const queueGhlEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({
  queueGhlEvent: (...args: unknown[]) => queueGhlEvent(...args),
}));

import { runVisitGeneration, generateForRound } from "../visitGeneration";

function makeTp(overrides: Record<string, unknown> = {}) {
  return {
    round: { findMany: vi.fn().mockResolvedValue([]) },
    property: { findMany: vi.fn().mockResolvedValue([]) },
    visit: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    servicePlan: { update: vi.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

// A Thursday — snapToWeekday leaves it unchanged, keeping date math simple.
const TODAY = new Date("2026-03-05T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateForRound", () => {
  it("creates a visit, advances nextDueDate, and queues visit.scheduled", async () => {
    const tp: any = makeTp({
      property: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "prop-1",
            customerId: "cust-1",
            servicePlans: [
              { id: "plan-1", price: 35, nextDueDate: new Date("2026-03-05T00:00:00Z"), cleaningFrequency: "FOUR_WEEKLY", serviceId: "svc-1" },
            ],
          },
        ]),
      },
    });

    const created = await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(created).toBe(1);
    expect(tp.visit.create).toHaveBeenCalledWith({
      data: {
        propertyId: "prop-1",
        roundId: "round-1",
        servicePlanId: "plan-1",
        serviceId: "svc-1",
        date: new Date("2026-03-05T00:00:00Z"),
        price: 35,
        isOneOff: false,
        status: "SCHEDULED",
        paymentHold: false,
      },
    });
    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "visit.scheduled", "cust-1", { nextCleanDate: "2026-03-05" });
    expect(tp.servicePlan.update).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: { nextDueDate: new Date("2026-04-02T00:00:00Z") },
    });
  });

  it("falls back to the round's frequency when the plan has none", async () => {
    const tp: any = makeTp({
      property: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "prop-1",
            customerId: "cust-1",
            servicePlans: [
              { id: "plan-1", price: 35, nextDueDate: new Date("2026-03-05T00:00:00Z"), cleaningFrequency: null, serviceId: null },
            ],
          },
        ]),
      },
    });

    const created = await generateForRound(tp, { id: "round-1", frequency: "SIX_WEEKLY" }, TODAY);

    expect(created).toBe(1);
    expect(tp.servicePlan.update).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: { nextDueDate: new Date("2026-04-16T00:00:00Z") },
    });
  });

  it("skips a plan with no frequency at all (plan or round)", async () => {
    const tp: any = makeTp({
      property: {
        findMany: vi.fn().mockResolvedValue([
          { id: "prop-1", customerId: "cust-1", servicePlans: [{ id: "plan-1", price: 35, nextDueDate: new Date(), cleaningFrequency: null, serviceId: null }] },
        ]),
      },
    });

    const created = await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(created).toBe(0);
    expect(tp.visit.create).not.toHaveBeenCalled();
  });

  it("skips a plan with no nextDueDate", async () => {
    const tp: any = makeTp({
      property: {
        findMany: vi.fn().mockResolvedValue([
          { id: "prop-1", customerId: "cust-1", servicePlans: [{ id: "plan-1", price: 35, nextDueDate: null, cleaningFrequency: "FOUR_WEEKLY", serviceId: null }] },
        ]),
      },
    });

    const created = await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(created).toBe(0);
    expect(tp.visit.create).not.toHaveBeenCalled();
  });

  it("skips (idempotent) when a future scheduled visit already exists for the plan", async () => {
    const tp: any = makeTp({
      property: {
        findMany: vi.fn().mockResolvedValue([
          { id: "prop-1", customerId: "cust-1", servicePlans: [{ id: "plan-1", price: 35, nextDueDate: new Date("2026-03-05T00:00:00Z"), cleaningFrequency: "FOUR_WEEKLY", serviceId: null }] },
        ]),
      },
      visit: { findFirst: vi.fn().mockResolvedValue({ id: "existing-visit" }), create: vi.fn() },
    });

    const created = await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(created).toBe(0);
    expect(tp.visit.create).not.toHaveBeenCalled();
    expect(queueGhlEvent).not.toHaveBeenCalled();
  });

  it("snaps a Saturday due date forward to Monday", async () => {
    const tp: any = makeTp({
      property: {
        findMany: vi.fn().mockResolvedValue([
          // 2026-03-07 is a Saturday
          { id: "prop-1", customerId: "cust-1", servicePlans: [{ id: "plan-1", price: 35, nextDueDate: new Date("2026-03-07T00:00:00Z"), cleaningFrequency: "FOUR_WEEKLY", serviceId: null }] },
        ]),
      },
    });

    await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "visit.scheduled", "cust-1", { nextCleanDate: "2026-03-09" });
  });

  it("snaps a Sunday due date forward to Monday", async () => {
    const tp: any = makeTp({
      property: {
        findMany: vi.fn().mockResolvedValue([
          // 2026-03-08 is a Sunday
          { id: "prop-1", customerId: "cust-1", servicePlans: [{ id: "plan-1", price: 35, nextDueDate: new Date("2026-03-08T00:00:00Z"), cleaningFrequency: "FOUR_WEEKLY", serviceId: null }] },
        ]),
      },
    });

    await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "visit.scheduled", "cust-1", { nextCleanDate: "2026-03-09" });
  });

  it("counts visits created across multiple properties and plans", async () => {
    const tp: any = makeTp({
      property: {
        findMany: vi.fn().mockResolvedValue([
          { id: "prop-1", customerId: "cust-1", servicePlans: [{ id: "plan-1", price: 35, nextDueDate: new Date("2026-03-05T00:00:00Z"), cleaningFrequency: "FOUR_WEEKLY", serviceId: null }] },
          { id: "prop-2", customerId: "cust-2", servicePlans: [{ id: "plan-2", price: 20, nextDueDate: new Date("2026-03-05T00:00:00Z"), cleaningFrequency: "SIX_WEEKLY", serviceId: null }] },
        ]),
      },
    });

    const created = await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(created).toBe(2);
  });
});

describe("runVisitGeneration", () => {
  it("processes each tenant's active rounds", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp({ round: { findMany: vi.fn().mockResolvedValue([{ id: "round-1", frequency: null }]) } });
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runVisitGeneration();

    expect(tp.round.findMany).toHaveBeenCalledWith({ where: { status: "ACTIVE" }, select: { id: true, frequency: true } });
    expect(tp.property.findMany).toHaveBeenCalled();
  });

  it("logs and continues when one tenant's processing throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tenantFindMany.mockResolvedValue([{ schemaName: "t_bad" }, { schemaName: "t_ok" }]);
    const badTp = { round: { findMany: vi.fn().mockRejectedValue(new Error("db down")) } };
    const okTp = makeTp();
    getTenantPrismaForSchema.mockImplementation((schemaName: string) => (schemaName === "t_bad" ? badTp : okTp));

    await runVisitGeneration();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("t_bad"), expect.any(Error));
    expect(okTp.round.findMany).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
