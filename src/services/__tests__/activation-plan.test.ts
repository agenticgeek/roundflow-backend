import { it, expect, vi } from "vitest";
import { buildActivationPlan, loadActivationInputs, type ActivationRound } from "../activation-plan";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function round(overrides: Partial<ActivationRound> = {}): ActivationRound {
  return {
    id: "r1",
    name: "Alnwick Fri",
    defaultDay: "FRI",
    frequency: "FOUR_WEEKLY",
    roundTechnicians: [{ technicianId: "t1" }],
    properties: [
      {
        id: "p1",
        assignedTechnicianId: null,
        customer: { holdNextClean: false },
        servicePlans: [{ id: "sp1", price: 20 as never, paymentMethod: "CASH", cleaningFrequency: null }],
      },
    ],
    ...overrides,
  } as ActivationRound;
}

it("generates visits on the round day with an exclusive end, stamps the sole technician, and continues the series", () => {
  // Fri 2026-10-30, 8 weeks → Oct 30, Nov 27 (Dec 25 is the exclusive end)
  const plan = buildActivationPlan([round()], { startDate: d("2026-10-30"), cycleEndDate: d("2026-12-25"), windows: [] });
  expect(plan.visits.map((v) => v.date)).toEqual([d("2026-10-30"), d("2026-11-27")]);
  expect(plan.visits[0]).toMatchObject({ technicianId: "t1", paymentHold: false, paymentMethod: "CASH", servicePlanId: "sp1", roundId: "r1" });
  expect(plan.nextDueDates).toEqual([{ servicePlanId: "sp1", nextDueDate: d("2026-12-25") }]);
  expect(plan.rounds).toEqual([{ roundId: "r1", name: "Alnwick Fri", firstVisit: d("2026-10-30"), visits: 2 }]);
  expect(plan.total).toBe(2);
});

it("holds only the first visit for a customer on hold, skips unavailable technicians, and prefers the plan's own frequency", () => {
  const r = round({
    roundTechnicians: [{ technicianId: "t1" }, { technicianId: "t2" }],
    properties: [
      {
        id: "p1",
        assignedTechnicianId: "t1",
        customer: { holdNextClean: true },
        servicePlans: [{ id: "sp1", price: 20 as never, paymentMethod: null, cleaningFrequency: "SIX_WEEKLY" }],
      },
    ] as never,
  });
  const plan = buildActivationPlan([r], {
    startDate: d("2026-10-30"),
    cycleEndDate: d("2027-01-01"),
    windows: [{ technicianId: "t1", from: d("2026-12-01"), to: d("2026-12-31") }],
  });
  expect(plan.visits.map((v) => [v.date, v.technicianId, v.paymentHold])).toEqual([
    [d("2026-10-30"), "t1", true],
    [d("2026-12-11"), "t2", false], // t1 away → the other technician
  ]);
});

it("a property without a plan is skipped; a one-off (no frequency anywhere) gets one visit and no nextDueDate; an empty window yields nothing", () => {
  const r = round({
    defaultDay: null,
    frequency: null,
    properties: [
      { id: "p0", assignedTechnicianId: null, customer: { holdNextClean: false }, servicePlans: [] },
      { id: "p1", assignedTechnicianId: null, customer: { holdNextClean: false }, servicePlans: [{ id: "sp1", price: 1 as never, paymentMethod: null, cleaningFrequency: null }] },
    ] as never,
  });
  const plan = buildActivationPlan([r, round({ id: "r2", properties: [] })], {
    startDate: d("2026-11-03"),
    cycleEndDate: d("2026-12-01"),
    windows: [],
  });
  expect(plan.visits.map((v) => v.date)).toEqual([d("2026-11-03")]);
  expect(plan.nextDueDates).toEqual([]);
  expect(plan.rounds[1]).toEqual({ roundId: "r2", name: "Alnwick Fri", firstVisit: null, visits: 0 });

  const empty = buildActivationPlan([round()], { startDate: d("2026-11-03"), cycleEndDate: d("2026-11-03"), windows: [] });
  expect(empty.total).toBe(0);
  expect(empty.nextDueDates).toEqual([]);
});

it("firstVisit is the earliest visit across the round's properties", () => {
  const props = [
    { id: "p1", assignedTechnicianId: null, customer: { holdNextClean: false }, servicePlans: [{ id: "a", price: 1 as never, paymentMethod: null, cleaningFrequency: null }] },
    { id: "p2", assignedTechnicianId: null, customer: { holdNextClean: false }, servicePlans: [{ id: "b", price: 1 as never, paymentMethod: null, cleaningFrequency: null }] },
  ];
  const plan = buildActivationPlan([round({ properties: props as never })], { startDate: d("2026-10-30"), cycleEndDate: d("2026-11-06"), windows: [] });
  expect(plan.rounds[0].firstVisit).toEqual(d("2026-10-30"));
  expect(plan.rounds[0].visits).toBe(2);
});

it("loadActivationInputs loads rounds and only the availability windows that overlap the period", async () => {
  const tp = {
    round: { findMany: vi.fn().mockResolvedValue([round(), round({ id: "r2", roundTechnicians: [{ technicianId: "t1" }, { technicianId: "t9" }] })]) },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue([{ technicianId: "t1", from: d("2026-11-01"), to: d("2026-11-02") }]) },
  };
  const window = { startDate: d("2026-10-30"), cycleEndDate: d("2026-11-27") };
  const result = await loadActivationInputs(tp as never, { status: "ACTIVE" }, window);
  expect(result.rounds).toHaveLength(2);
  expect(result.windows).toHaveLength(1);
  expect(tp.technicianAvailability.findMany).toHaveBeenCalledWith({
    where: { technicianId: { in: ["t1", "t9"] }, from: { lt: window.cycleEndDate }, to: { gte: window.startDate } },
    select: { technicianId: true, from: true, to: true },
  });
});

it("loadActivationInputs skips the availability query when no round has technicians", async () => {
  const tp = {
    round: { findMany: vi.fn().mockResolvedValue([round({ roundTechnicians: [] })]) },
    technicianAvailability: { findMany: vi.fn() },
  };
  const result = await loadActivationInputs(tp as never, {}, { startDate: d("2026-10-30"), cycleEndDate: d("2026-11-27") });
  expect(result.windows).toEqual([]);
  expect(tp.technicianAvailability.findMany).not.toHaveBeenCalled();
});
