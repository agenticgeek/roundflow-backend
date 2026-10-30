import { it, expect, vi } from "vitest";
import {
  autoRoundName,
  NoMatchingRoundError,
  pausePlan,
  resumePlan,
  updatePlan,
} from "../service-plan-lifecycle";
import { AppError } from "../../lib/app-error";
import { LifecycleStatus, RoundStatus, VisitStatus } from "../../generated/tenant-client";

function makeTx() {
  return {
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
    servicePlan: { update: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "sp1", ...data })) },
    property: { update: vi.fn().mockResolvedValue({}) },
    round: { create: vi.fn().mockResolvedValue({ id: "rNew", name: "Alnwick Fri 6wk", defaultDay: "FRI" }) },
    roundTechnician: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

function makeTp(tx = makeTx()) {
  return {
    tx,
    tp: {
      servicePlan: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({ id: "sp1" }) },
      property: { findUnique: vi.fn() },
      round: { findMany: vi.fn() },
      $transaction: vi.fn((cb: any) => cb(tx)),
    } as any,
  };
}

const NOW = new Date("2026-10-30T10:00:00Z"); // a Friday
const day = (s: string) => new Date(`${s}T00:00:00Z`);

// ── pausePlan ───────────────────────────────────────────────────────────────

it("pausePlan with a start today pauses now and cancels visits in the inclusive window", async () => {
  const { tp, tx } = makeTp();
  const result = await pausePlan(tp, { id: "sp1" }, { pauseStartDate: NOW, pauseEndDate: day("2026-11-20") }, NOW);

  expect(tx.visit.updateMany).toHaveBeenCalledWith({
    where: {
      servicePlanId: "sp1",
      status: VisitStatus.SCHEDULED,
      date: { gte: day("2026-10-30"), lt: day("2026-11-21") },
    },
    data: { status: VisitStatus.CANCELLED, cancelReason: "PAUSED" },
  });
  expect(tx.servicePlan.update.mock.calls[0][0].data).toEqual({
    status: LifecycleStatus.PAUSED,
    pauseStartDate: NOW,
    pauseEndDate: day("2026-11-20"),
  });
  expect(result).toMatchObject({ cancelledVisits: 3, pauseScheduled: false });
});

it("pausePlan open-ended cancels every visit from start", async () => {
  const { tp, tx } = makeTp();
  await pausePlan(tp, { id: "sp1" }, { pauseStartDate: day("2026-10-01") }, NOW);
  expect(tx.visit.updateMany.mock.calls[0][0].where.date).toEqual({ gte: day("2026-10-01") });
  expect(tx.servicePlan.update.mock.calls[0][0].data.pauseEndDate).toBeNull();
});

it("pausePlan with a future start keeps the plan ACTIVE and stores the window for the nightly job", async () => {
  const { tp, tx } = makeTp();
  const start = day("2026-11-10");
  const result = await pausePlan(tp, { id: "sp1" }, { pauseStartDate: start, pauseEndDate: null }, NOW);
  expect(tx.servicePlan.update.mock.calls[0][0].data).toEqual({ pauseStartDate: start, pauseEndDate: null });
  expect(result.pauseScheduled).toBe(true);
});

// ── resumePlan ──────────────────────────────────────────────────────────────

it("resumePlan sets ACTIVE, clears the window and moves nextDueDate to the next round day", async () => {
  const { tp } = makeTp();
  tp.property.findUnique.mockResolvedValue({ round: { defaultDay: "TUE" } });
  await resumePlan(tp, { id: "sp1", propertyId: "p1" }, NOW);
  expect(tp.servicePlan.update).toHaveBeenCalledWith({
    where: { id: "sp1" },
    data: { status: LifecycleStatus.ACTIVE, pauseStartDate: null, pauseEndDate: null, nextDueDate: day("2026-11-03") },
  });
});

it("resumePlan without a round day uses today snapped to a weekday", async () => {
  const { tp } = makeTp();
  tp.property.findUnique.mockResolvedValue({ round: null });
  await resumePlan(tp, { id: "sp1", propertyId: "p1" }, new Date("2026-10-31T10:00:00Z")); // Saturday
  expect(tp.servicePlan.update.mock.calls[0][0].data.nextDueDate).toEqual(day("2026-11-02"));
});

// ── updatePlan (B3) ─────────────────────────────────────────────────────────

function planWith(round: any, extra: any = {}) {
  return {
    id: "sp1",
    propertyId: "p1",
    lastCompleted: null,
    property: { serviceAreaId: "sa1", serviceArea: { name: "Alnwick" }, round, ...extra },
  };
}

const ROUND = {
  id: "r1",
  name: "Alnwick Fri",
  frequency: "FOUR_WEEKLY",
  defaultDay: "FRI",
  serviceAreaId: "sa1",
  serviceArea: { name: "Alnwick" },
  roundTechnicians: [{ technicianId: "t1" }],
};

it("autoRoundName formats <Area> <Day> <N>wk and drops a missing day", () => {
  expect(autoRoundName("Alnwick", "FRI", "SIX_WEEKLY")).toBe("Alnwick Fri 6wk");
  expect(autoRoundName("Alnwick", null, "TWELVE_WEEKLY")).toBe("Alnwick 12wk");
});

it("updatePlan 404s when the plan is missing", async () => {
  const { tp } = makeTp();
  tp.servicePlan.findUnique.mockResolvedValue(null);
  await expect(updatePlan(tp, "x", {}, NOW)).rejects.toMatchObject({ statusCode: 404 });
});

it("updatePlan writes only provided fields when the frequency is unchanged / absent / unassigned", async () => {
  const { tp } = makeTp();
  tp.servicePlan.findUnique.mockResolvedValue(planWith(ROUND));
  const res = await updatePlan(
    tp,
    "sp1",
    { price: 30, cleanMethod: "WFP", paymentMethod: "BACS" as never, cleaningFrequency: "FOUR_WEEKLY" as never },
    NOW
  );
  expect(tp.servicePlan.update).toHaveBeenCalledWith({
    where: { id: "sp1" },
    data: { price: 30, cleanMethod: "WFP", paymentMethod: "BACS", cleaningFrequency: "FOUR_WEEKLY" },
  });
  expect(res.movedToRound).toBeNull();

  tp.servicePlan.findUnique.mockResolvedValue(planWith(null));
  await updatePlan(tp, "sp1", { cleaningFrequency: "SIX_WEEKLY" as never }, NOW);
  expect(tp.servicePlan.update.mock.calls[1][0].data).toEqual({ cleaningFrequency: "SIX_WEEKLY" });

  await updatePlan(tp, "sp1", { cleaningFrequency: null }, NOW);
  expect(tp.round.findMany).not.toHaveBeenCalled();
});

it("updatePlan moves the property to a matching round, preferring the same defaultDay", async () => {
  const { tp, tx } = makeTp();
  tp.servicePlan.findUnique.mockResolvedValue({ ...planWith(ROUND), lastCompleted: day("2026-10-23") });
  tp.round.findMany.mockResolvedValue([
    { id: "rMon", name: "Alnwick Mon 6wk", defaultDay: "MON" },
    { id: "rFri", name: "Alnwick Fri 6wk", defaultDay: "FRI" },
  ]);

  const res = await updatePlan(tp, "sp1", { cleaningFrequency: "SIX_WEEKLY" as never, price: 25 }, NOW);

  expect(tp.round.findMany.mock.calls[0][0].where).toEqual({
    status: RoundStatus.ACTIVE,
    frequency: "SIX_WEEKLY",
    serviceAreaId: "sa1",
    NOT: { id: "r1" },
  });
  expect(res.movedToRound).toEqual({ id: "rFri", name: "Alnwick Fri 6wk", created: false });
  expect(tx.round.create).not.toHaveBeenCalled();
  expect(tx.visit.updateMany).toHaveBeenCalledWith({
    where: { propertyId: "p1", roundId: "r1", status: VisitStatus.SCHEDULED, date: { gte: day("2026-10-30") } },
    data: { status: VisitStatus.CANCELLED, cancelReason: "FREQUENCY_CHANGED" },
  });
  expect(tx.property.update).toHaveBeenCalledWith({
    where: { id: "p1" },
    data: { roundId: "rFri", assignedTechnicianId: null },
  });
  // last clean 2026-10-23 + 6 weeks = 2026-12-04 (a Friday)
  expect(tx.servicePlan.update.mock.calls[0][0].data).toEqual({
    price: 25,
    cleaningFrequency: "SIX_WEEKLY",
    nextDueDate: day("2026-12-04"),
  });
});

it("updatePlan falls back to the first candidate when no round shares the day", async () => {
  const { tp } = makeTp();
  tp.servicePlan.findUnique.mockResolvedValue(planWith(ROUND));
  tp.round.findMany.mockResolvedValue([{ id: "rMon", name: "Alnwick Mon 6wk", defaultDay: "MON" }]);
  const res = await updatePlan(tp, "sp1", { cleaningFrequency: "SIX_WEEKLY" as never }, NOW);
  expect(res.movedToRound?.id).toBe("rMon");
});

it("updatePlan throws NO_MATCHING_ROUND with suggestions when none match and creation isn't requested", async () => {
  const { tp } = makeTp();
  tp.servicePlan.findUnique.mockResolvedValue(planWith(ROUND));
  const suggestions = [{ id: "r2", name: "Alnwick Mon", frequency: "FOUR_WEEKLY", defaultDay: "MON" }];
  tp.round.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(suggestions);

  const err = await updatePlan(tp, "sp1", { cleaningFrequency: "SIX_WEEKLY" as never }, NOW).catch((e) => e);

  expect(err).toBeInstanceOf(NoMatchingRoundError);
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ statusCode: 409, code: "NO_MATCHING_ROUND", suggestions, proposedName: "Alnwick Fri 6wk" });
  expect(tp.$transaction).not.toHaveBeenCalled();
});

it("updatePlan creates '<Area> <Day> <N>wk' copying day, area and technicians when createRoundIfMissing", async () => {
  const { tp, tx } = makeTp();
  tp.servicePlan.findUnique.mockResolvedValue(planWith(ROUND));
  tp.round.findMany.mockResolvedValue([]);

  const res = await updatePlan(tp, "sp1", { cleaningFrequency: "SIX_WEEKLY" as never, createRoundIfMissing: true }, NOW);

  expect(tx.round.create.mock.calls[0][0].data).toEqual({
    name: "Alnwick Fri 6wk",
    frequency: "SIX_WEEKLY",
    serviceAreaId: "sa1",
    defaultDay: "FRI",
    status: RoundStatus.ACTIVE,
  });
  expect(tx.roundTechnician.createMany).toHaveBeenCalledWith({ data: [{ roundId: "rNew", technicianId: "t1" }] });
  expect(res.movedToRound).toEqual({ id: "rNew", name: "Alnwick Fri 6wk", created: true });
  // no lastCompleted → next Friday on/after today (today is a Friday)
  expect(tx.servicePlan.update.mock.calls[0][0].data.nextDueDate).toEqual(day("2026-10-30"));
});

it("updatePlan created round without technicians, and with area/name fallbacks from the round", async () => {
  const { tp, tx } = makeTp();
  const bareRound = { ...ROUND, roundTechnicians: [], serviceArea: null, name: "Old Round" };
  tp.servicePlan.findUnique.mockResolvedValue(planWith(bareRound, { serviceAreaId: null, serviceArea: null }));
  tp.round.findMany.mockResolvedValue([]);
  tx.round.create.mockResolvedValue({ id: "rNew", name: "Old Round Fri 6wk", defaultDay: "FRI" });

  await updatePlan(tp, "sp1", { cleaningFrequency: "SIX_WEEKLY" as never, createRoundIfMissing: true }, NOW);

  expect(tx.round.create.mock.calls[0][0].data.name).toBe("Old Round Fri 6wk");
  expect(tx.roundTechnician.createMany).not.toHaveBeenCalled();
});

it("updatePlan uses the round's service area name when the property has none", async () => {
  const { tp } = makeTp();
  tp.servicePlan.findUnique.mockResolvedValue(planWith(ROUND, { serviceArea: null }));
  tp.round.findMany.mockResolvedValue([]);
  const err = await updatePlan(tp, "sp1", { cleaningFrequency: "EIGHT_WEEKLY" as never }, NOW).catch((e) => e);
  expect(err.proposedName).toBe("Alnwick Fri 8wk");
});

it("NoMatchingRoundError is a named AppError", () => {
  const e = new NoMatchingRoundError("m", [], "x");
  expect(e.name).toBe("NoMatchingRoundError");
});

it("updatePlan with no cleaningFrequency leaves the frequency untouched", async () => {
  const { tp } = makeTp();
  tp.servicePlan.findUnique.mockResolvedValue(planWith(ROUND));
  await updatePlan(tp, "sp1", { price: 12 }, NOW);
  expect(tp.servicePlan.update).toHaveBeenCalledWith({ where: { id: "sp1" }, data: { price: 12 } });
});
