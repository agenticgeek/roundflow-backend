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

const { pausePlan, resumePlan } = vi.hoisted(() => ({
  pausePlan: vi.fn().mockResolvedValue({}),
  resumePlan: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../services/service-plan-lifecycle", () => ({ pausePlan, resumePlan }));

import { runVisitGeneration, generateForRound, applyPauseTransitions } from "../visitGeneration";

function makeTp(overrides: Record<string, unknown> = {}) {
  return {
    round: { findMany: vi.fn().mockResolvedValue([]) },
    property: { findMany: vi.fn().mockResolvedValue([]) },
    roundTechnician: { findMany: vi.fn().mockResolvedValue([]) },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue([]) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue(null) },
    visit: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    servicePlan: { update: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-1", price: 35, nextDueDate: new Date("2026-03-05T00:00:00Z"), cleaningFrequency: "FOUR_WEEKLY",
    serviceId: null, pauseStartDate: null, pauseEndDate: null, ...overrides,
  };
}

function property(overrides: Record<string, unknown> = {}) {
  return {
    id: "prop-1", customerId: "cust-1", assignedTechnicianId: null,
    customer: { holdNextClean: false }, servicePlans: [plan()], ...overrides,
  };
}

function withProperties(props: unknown[], overrides: Record<string, unknown> = {}) {
  return makeTp({ property: { findMany: vi.fn().mockResolvedValue(props) }, ...overrides });
}

// A Thursday — snapToWeekday leaves it unchanged, keeping date math simple.
const TODAY = new Date("2026-03-05T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateForRound", () => {
  it("creates a visit, advances nextDueDate, and queues visit.scheduled", async () => {
    const tp: any = withProperties([property({ servicePlans: [plan({ serviceId: "svc-1" })] })]);

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
        technicianId: null,
      },
    });
    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "visit.scheduled", "cust-1", { nextCleanDate: "2026-03-05" });
    expect(tp.servicePlan.update).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: { nextDueDate: new Date("2026-04-02T00:00:00Z") },
    });
  });

  it("stamps the round's sole technician and the customer's payment hold (X-1, A3)", async () => {
    const tp: any = withProperties([property({ customer: { holdNextClean: true } })], {
      roundTechnician: { findMany: vi.fn().mockResolvedValue([{ technicianId: "t1" }]) },
    });

    await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(tp.visit.create.mock.calls[0][0].data).toMatchObject({ technicianId: "t1", paymentHold: true });
  });

  it("stamps the property's assigned technician on a multi-technician round", async () => {
    const tp: any = withProperties([property({ assignedTechnicianId: "t2" })], {
      roundTechnician: { findMany: vi.fn().mockResolvedValue([{ technicianId: "t1" }, { technicianId: "t2" }]) },
    });

    await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(tp.visit.create.mock.calls[0][0].data.technicianId).toBe("t2");
  });

  it("skips a technician unavailable on the visit date, looking availability up once per date", async () => {
    const tp: any = withProperties(
      [property(), property({ id: "prop-2", customerId: "cust-2", servicePlans: [plan({ id: "plan-2" })] })],
      {
        roundTechnician: { findMany: vi.fn().mockResolvedValue([{ technicianId: "t1" }]) },
        technicianAvailability: { findMany: vi.fn().mockResolvedValue([{ technicianId: "t1" }]) },
      }
    );

    await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(tp.visit.create).toHaveBeenCalledTimes(2);
    expect(tp.visit.create.mock.calls.map((c: any) => c[0].data.technicianId)).toEqual([null, null]);
    expect(tp.technicianAvailability.findMany).toHaveBeenCalledTimes(1);
  });

  it("puts the visit on the round's day and advances to the next round day", async () => {
    // nextDueDate Thu 2026-03-05, round day MON → visit Mon 03-09, next Mon 04-06.
    const tp: any = withProperties([property()]);

    await generateForRound(tp, { id: "round-1", frequency: null, defaultDay: "MON" }, TODAY);

    expect(tp.visit.create.mock.calls[0][0].data.date).toEqual(new Date("2026-03-09T00:00:00Z"));
    expect(tp.servicePlan.update).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: { nextDueDate: new Date("2026-04-06T00:00:00Z") },
    });
  });

  it("keeps a Saturday round day instead of snapping it to Monday", async () => {
    const tp: any = withProperties([property({ servicePlans: [plan({ nextDueDate: new Date("2026-03-07T00:00:00Z") })] })]);

    await generateForRound(tp, { id: "round-1", frequency: null, defaultDay: "SAT" }, TODAY);

    expect(tp.visit.create.mock.calls[0][0].data.date).toEqual(new Date("2026-03-07T00:00:00Z"));
  });

  it("falls back to the round's frequency when the plan has none", async () => {
    const tp: any = withProperties([property({ servicePlans: [plan({ cleaningFrequency: null })] })]);

    const created = await generateForRound(tp, { id: "round-1", frequency: "SIX_WEEKLY" }, TODAY);

    expect(created).toBe(1);
    expect(tp.servicePlan.update).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: { nextDueDate: new Date("2026-04-16T00:00:00Z") },
    });
  });

  it("skips a plan with no frequency at all (plan or round)", async () => {
    const tp: any = withProperties([property({ servicePlans: [plan({ cleaningFrequency: null })] })]);

    const created = await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(created).toBe(0);
    expect(tp.visit.create).not.toHaveBeenCalled();
  });

  it("skips a plan with no nextDueDate", async () => {
    const tp: any = withProperties([property({ servicePlans: [plan({ nextDueDate: null })] })]);

    const created = await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(created).toBe(0);
    expect(tp.visit.create).not.toHaveBeenCalled();
  });

  it("skips (idempotent) when a future scheduled visit already exists for the plan", async () => {
    const tp: any = withProperties([property()], {
      visit: { findFirst: vi.fn().mockResolvedValue({ id: "existing-visit" }), create: vi.fn() },
    });

    const created = await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(created).toBe(0);
    expect(tp.visit.create).not.toHaveBeenCalled();
    expect(queueGhlEvent).not.toHaveBeenCalled();
  });

  it("does not create a visit inside a future-dated pause window (A4)", async () => {
    const windows = [
      { pauseStartDate: new Date("2026-03-01T00:00:00Z"), pauseEndDate: null },                            // open-ended
      { pauseStartDate: new Date("2026-03-05T00:00:00Z"), pauseEndDate: new Date("2026-03-20T00:00:00Z") }, // covers the date
    ];
    for (const w of windows) {
      const tp: any = withProperties([property({ servicePlans: [plan(w)] })]);
      expect(await generateForRound(tp, { id: "round-1", frequency: null }, TODAY)).toBe(0);
      expect(tp.servicePlan.update).not.toHaveBeenCalled();
    }
  });

  it("creates the visit when a pause window doesn't cover its date", async () => {
    const windows = [
      { pauseStartDate: new Date("2026-03-10T00:00:00Z"), pauseEndDate: null },                            // starts later
      { pauseStartDate: new Date("2026-02-01T00:00:00Z"), pauseEndDate: new Date("2026-03-01T00:00:00Z") }, // already over
    ];
    for (const w of windows) {
      const tp: any = withProperties([property({ servicePlans: [plan(w)] })]);
      expect(await generateForRound(tp, { id: "round-1", frequency: null }, TODAY)).toBe(1);
    }
  });

  it("snaps a Saturday due date forward to Monday", async () => {
    // 2026-03-07 is a Saturday
    const tp: any = withProperties([property({ servicePlans: [plan({ nextDueDate: new Date("2026-03-07T00:00:00Z") })] })]);

    await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "visit.scheduled", "cust-1", { nextCleanDate: "2026-03-09" });
  });

  it("snaps a Sunday due date forward to Monday", async () => {
    // 2026-03-08 is a Sunday
    const tp: any = withProperties([property({ servicePlans: [plan({ nextDueDate: new Date("2026-03-08T00:00:00Z") })] })]);

    await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "visit.scheduled", "cust-1", { nextCleanDate: "2026-03-09" });
  });

  it("counts visits created across multiple properties and plans", async () => {
    const tp: any = withProperties([
      property(),
      property({ id: "prop-2", customerId: "cust-2", servicePlans: [plan({ id: "plan-2", price: 20, cleaningFrequency: "SIX_WEEKLY" })] }),
    ]);

    const created = await generateForRound(tp, { id: "round-1", frequency: null }, TODAY);

    expect(created).toBe(2);
  });
});

describe("applyPauseTransitions", () => {
  it("pauses started future-dated pauses via the lifecycle pausePlan()", async () => {
    const start = new Date("2026-03-01T00:00:00Z");
    const end = new Date("2026-03-20T00:00:00Z");
    const tp: any = makeTp();
    const p1 = { id: "plan-1", pauseStartDate: start, pauseEndDate: end };
    const p2 = { id: "plan-2", pauseStartDate: start, pauseEndDate: null };
    tp.servicePlan.findMany.mockResolvedValueOnce([p1, p2]).mockResolvedValueOnce([]);

    await applyPauseTransitions(tp, TODAY);

    expect(tp.servicePlan.findMany.mock.calls[0][0].where).toEqual({
      status: "ACTIVE",
      pauseStartDate: { lte: TODAY },
      OR: [{ pauseEndDate: null }, { pauseEndDate: { gte: TODAY } }],
    });
    expect(pausePlan).toHaveBeenCalledWith(tp, p1, { pauseStartDate: start, pauseEndDate: end }, TODAY);
    expect(pausePlan).toHaveBeenCalledWith(tp, p2, { pauseStartDate: start, pauseEndDate: null }, TODAY);
    expect(resumePlan).not.toHaveBeenCalled();
  });

  it("resumes plans whose pause has ended via the lifecycle resumePlan()", async () => {
    const tp: any = makeTp();
    const ended = [{ id: "plan-1", propertyId: "prop-1" }, { id: "plan-2", propertyId: "prop-2" }];
    tp.servicePlan.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(ended);
    const saturday = new Date("2026-03-07T00:00:00Z");

    await applyPauseTransitions(tp, saturday);

    expect(tp.servicePlan.findMany.mock.calls[1][0]).toEqual({
      where: { status: "PAUSED", pauseEndDate: { lt: saturday } },
      select: { id: true, propertyId: true },
    });
    expect(resumePlan).toHaveBeenCalledWith(tp, ended[0], saturday);
    expect(resumePlan).toHaveBeenCalledWith(tp, ended[1], saturday);
    expect(pausePlan).not.toHaveBeenCalled();
  });
});

describe("runVisitGeneration", () => {
  it("runs pause transitions then processes each tenant's active rounds", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp({ round: { findMany: vi.fn().mockResolvedValue([{ id: "round-1", frequency: null, defaultDay: null }]) } });
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runVisitGeneration();

    expect(tp.servicePlan.findMany).toHaveBeenCalledTimes(2);
    expect(tp.round.findMany).toHaveBeenCalledWith({
      where: { status: "ACTIVE" },
      select: { id: true, frequency: true, defaultDay: true },
    });
    expect(tp.property.findMany).toHaveBeenCalled();
  });

  it("skips generation (but not pause transitions) when autoCreateNextVisit is off (B2)", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp({ businessSettings: { findFirst: vi.fn().mockResolvedValue({ autoCreateNextVisit: false }) } });
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runVisitGeneration();

    expect(tp.servicePlan.findMany).toHaveBeenCalledTimes(2);
    expect(tp.round.findMany).not.toHaveBeenCalled();
  });

  it("generates when autoCreateNextVisit is on", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp({ businessSettings: { findFirst: vi.fn().mockResolvedValue({ autoCreateNextVisit: true }) } });
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runVisitGeneration();

    expect(tp.round.findMany).toHaveBeenCalled();
  });

  it("logs and continues when one tenant's processing throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tenantFindMany.mockResolvedValue([{ schemaName: "t_bad" }, { schemaName: "t_ok" }]);
    const badTp = { servicePlan: { findMany: vi.fn().mockRejectedValue(new Error("db down")) } };
    const okTp = makeTp();
    getTenantPrismaForSchema.mockImplementation((schemaName: string) => (schemaName === "t_bad" ? badTp : okTp));

    await runVisitGeneration();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("t_bad"), expect.any(Error));
    expect(okTp.round.findMany).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
