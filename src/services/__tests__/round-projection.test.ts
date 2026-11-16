import { describe, it, expect, vi, beforeEach } from "vitest";

const getCachedBusinessSettings = vi.fn();
vi.mock("../settings.service", () => ({ getCachedBusinessSettings: (...a: unknown[]) => getCachedBusinessSettings(...a) }));

import { projectionSeries, closureProjectionSeries, planFirstCycle, projectOccurrences, PROJECTION_HORIZON_WEEKS, PROJECTION_MAX_ENTRIES } from "../round-projection";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const keys = (ds: Date[]) => ds.map((x) => x.toISOString().slice(0, 10));
const dec = (n: number) => ({ toNumber: () => n });

describe("projectionSeries (the 13-week horizon, cap of 4, from the plan's examples)", () => {
  it("exposes the two constants in one place", () => {
    expect(PROJECTION_HORIZON_WEEKS).toBe(13);
    expect(PROJECTION_MAX_ENTRIES).toBe(4);
  });

  it("4-weekly from Fri 20 Nov: 20 Nov, 18 Dec, 15 Jan, 12 Feb", () => {
    expect(keys(projectionSeries(d("2026-11-20"), "FOUR_WEEKLY" as never, "FRI" as never))).toEqual(["2026-11-20", "2026-12-18", "2027-01-15", "2027-02-12"]);
  });

  it("6-weekly from 20 Nov: 20 Nov, 1 Jan, 12 Feb (26 Mar is past the horizon)", () => {
    expect(keys(projectionSeries(d("2026-11-20"), "SIX_WEEKLY" as never, "FRI" as never))).toEqual(["2026-11-20", "2027-01-01", "2027-02-12"]);
  });

  it("8-weekly from Mon 16 Nov: 16 Nov, 11 Jan (8 Mar is past the horizon)", () => {
    expect(keys(projectionSeries(d("2026-11-16"), "EIGHT_WEEKLY" as never, "MON" as never))).toEqual(["2026-11-16", "2027-01-11"]);
  });

  it("12-weekly from 20 Nov: 20 Nov and 12 Feb", () => {
    expect(keys(projectionSeries(d("2026-11-20"), "TWELVE_WEEKLY" as never, "FRI" as never))).toEqual(["2026-11-20", "2027-02-12"]);
  });

  it("a round without a round day keeps whole cycles and snaps a weekend forward onto the working days", () => {
    // Sat 21 Nov + 4 weeks = Sat 19 Dec -> Mon 21 Dec (default Mon-Fri)
    expect(keys(projectionSeries(d("2026-11-21"), "FOUR_WEEKLY" as never, null))).toEqual(["2026-11-21", "2026-12-21", "2027-01-18", "2027-02-15"]);
  });

  it("a round without a round day honours the tenant's working days", () => {
    // working days Tue-Sat: a Saturday stays on Saturday
    expect(keys(projectionSeries(d("2026-11-21"), "FOUR_WEEKLY" as never, null, ["TUE", "WED", "THU", "FRI", "SAT"])).slice(0, 2)).toEqual(["2026-11-21", "2026-12-19"]);
  });

  it("ignores the time part of the first date", () => {
    expect(keys(projectionSeries(new Date("2026-11-20T15:30:00.000Z"), "TWELVE_WEEKLY" as never, "FRI" as never))[0]).toBe("2026-11-20");
  });

  it("crosses the October clock change without drifting a day", () => {
    expect(keys(projectionSeries(d("2026-10-16"), "FOUR_WEEKLY" as never, "FRI" as never))).toEqual(["2026-10-16", "2026-11-13", "2026-12-11", "2027-01-08"]);
  });
});

// ---- projectOccurrences ------------------------------------------------------------------------------------------

const TODAY = d("2026-11-12");

function makeTp(opts: {
  rounds?: Array<{ id: string; defaultDay: string | null; frequency: string | null }>;
  plans?: Array<Record<string, unknown>>;
  visits?: Array<{ roundId: string; date: Date; status: string }>;
  closures?: Array<Record<string, unknown>>;
  /** Per plan: the latest non-cancelled, non-one-off visit date (any date), as the per-plan groupBy returns it. */
  latest?: Record<string, Date>;
  /** Raw rows for the per-plan groupBy (overrides `latest`). */
  latestRows?: Array<Record<string, unknown>>;
}) {
  return {
    round: { findMany: vi.fn().mockResolvedValue(opts.rounds ?? []) },
    servicePlan: { findMany: vi.fn().mockResolvedValue(opts.plans ?? []) },
    visit: {
      groupBy: vi.fn(async (args: { by: string[] }) =>
        args.by.includes("servicePlanId")
          ? (opts.latestRows ?? Object.entries(opts.latest ?? {}).map(([servicePlanId, date]) => ({ servicePlanId, _max: { date } })))
          : (opts.visits ?? [])),
    },
    businessClosure: { findMany: vi.fn().mockResolvedValue(opts.closures ?? []) },
  } as never;
}

let planSeq = 0;
const plan = (roundId: string, over: Record<string, unknown> = {}) => ({
  id: `plan-${++planSeq}`, price: dec(24), cleaningFrequency: "EIGHT_WEEKLY", status: "ACTIVE", nextDueDate: d("2027-01-11"), pauseEndDate: null, property: { roundId }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getCachedBusinessSettings.mockResolvedValue(null);
});

describe("projectOccurrences", () => {
  it("only looks at ACTIVE rounds and returns nothing when there are none", async () => {
    const tp = makeTp({ rounds: [] });
    expect((await projectOccurrences(tp, ["r1"], TODAY)).size).toBe(0);
    expect((tp as any).round.findMany).toHaveBeenCalledWith({ where: { id: { in: ["r1"] }, status: "ACTIVE" }, select: { id: true, defaultDay: true, frequency: true } });
    expect((tp as any).servicePlan.findMany).not.toHaveBeenCalled();
  });

  it("the seeded 8-weekly Monday round: one real visit on 16 Nov, forecast from the plans' 11 Jan due date, estimated from its plans", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "EIGHT_WEEKLY" }],
      plans: [plan("r1", { price: dec(24) }), plan("r1", { price: dec(30.5) })],
      visits: [{ roundId: "r1", date: d("2026-11-16"), status: "SCHEDULED" }],
    });
    const out = await projectOccurrences(tp, ["r1"], TODAY);
    // forecast anchored on the plans' due date (11 Jan); the horizon runs from the real visit (16 Nov), so 8 Mar is out
    expect(out.get("r1")).toEqual([
      { date: "2027-01-11", stopCount: 2, totalValue: 54.5, completedCount: 0, completionPct: 0, holdCount: 0, issueCount: 0, technicians: [], projected: true },
    ]);
  });

  it("real visits win: dates that already have visits are not projected, and they count toward the cap of 4", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "THU", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2027-01-07") })],
      visits: [
        { roundId: "r1", date: d("2026-11-12"), status: "SCHEDULED" },
        { roundId: "r1", date: d("2026-12-10"), status: "SCHEDULED" },
      ],
    });
    const out = await projectOccurrences(tp, ["r1"], TODAY);
    expect(out.get("r1")!.map((o) => o.date)).toEqual(["2027-01-07", "2027-02-04"]);
  });

  it("nothing earlier in the series than a real visit is projected", async () => {
    // real 12 Nov (in progress) and 7 Jan are 2 of the 4 slots (the series starts at the plan's due date, 7 Jan; horizon from 12 Nov ends 11 Feb): only 4 Feb comes after
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "THU", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2027-01-07") })],
      visits: [
        { roundId: "r1", date: d("2026-11-12"), status: "IN_PROGRESS" },
        { roundId: "r1", date: d("2027-01-07"), status: "SCHEDULED" },
      ],
    });
    expect((await projectOccurrences(tp, ["r1"], TODAY)).get("r1")!.map((o) => o.date)).toEqual(["2027-02-04"]);
  });

  it("with no upcoming real visit it starts from the earliest active plan due date", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "FRI", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-11-20") }), plan("r1", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-11-27") })],
    });
    expect((await projectOccurrences(tp, ["r1"], TODAY)).get("r1")!.map((o) => o.date)).toEqual(["2026-11-20", "2026-12-18", "2027-01-15", "2027-02-12"]);
  });

  it("completed visits do not set the next date but still stop a projection landing on the same day", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "FRI", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-11-13") })],
      visits: [{ roundId: "r1", date: d("2026-11-13"), status: "COMPLETED" }],
    });
    expect((await projectOccurrences(tp, ["r1"], TODAY)).get("r1")!.map((o) => o.date)).toEqual(["2026-12-11", "2027-01-08", "2027-02-05"]);
  });

  // Amended 2026-11-16 (rules 5.1): only the FIRST date is clamped to today; the cycle after it keeps the plan's phase
  // (11-02 + 12 weeks = 01-25). It used to re-phase from today (02-04), which disagreed with the nightly job.
  it("an overdue plan shows its first forecast today, not in the past, and keeps its phase afterwards", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: null, frequency: "TWELVE_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "TWELVE_WEEKLY", nextDueDate: d("2026-11-02") })],
    });
    expect((await projectOccurrences(tp, ["r1"], TODAY)).get("r1")!.map((o) => o.date)).toEqual(["2026-11-12", "2027-01-25"]);
  });

  it("a plan with no due date is ignored", async () => {
    const tp = makeTp({ rounds: [{ id: "r1", defaultDay: "MON", frequency: "FOUR_WEEKLY" }], plans: [plan("r1", { nextDueDate: null })] });
    expect((await projectOccurrences(tp, ["r1"], TODAY)).size).toBe(0);
  });

  it("falls back to a plan's own frequency when the round has none, and gives up when nobody has one", async () => {
    const fromPlan = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: null }],
      plans: [plan("r1", { cleaningFrequency: null }), plan("r1", { cleaningFrequency: "SIX_WEEKLY", nextDueDate: d("2026-11-16") })],
    });
    expect((await projectOccurrences(fromPlan, ["r1"], TODAY)).get("r1")![0].date).toBe("2026-11-16");
    const none = makeTp({ rounds: [{ id: "r1", defaultDay: "MON", frequency: null }], plans: [plan("r1", { cleaningFrequency: null })] });
    expect((await projectOccurrences(none, ["r1"], TODAY)).size).toBe(0);
  });

  it("paused plans: nothing when all are paused with no end date; a pause ending inside the horizon projects from the resume day", async () => {
    const allPaused = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { status: "PAUSED", pauseEndDate: null, cleaningFrequency: "FOUR_WEEKLY" })],
    });
    expect((await projectOccurrences(allPaused, ["r1"], TODAY)).size).toBe(0);

    // pause ends Wed 2 Dec -> resumes Mon 7 Dec; the active plan is due Mon 30 Nov, so the series starts on 30 Nov
    const resuming = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { status: "PAUSED", pauseEndDate: d("2026-12-02"), cleaningFrequency: "FOUR_WEEKLY", price: dec(10) }), plan("r1", { status: "ACTIVE", cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-11-30"), price: dec(20) })],
    });
    const out = (await projectOccurrences(resuming, ["r1"], TODAY)).get("r1")!;
    expect(out.map((o) => o.date)).toEqual(["2026-11-30", "2026-12-28", "2027-01-25", "2027-02-22"]);
    // the paused plan is back in the estimate once its pause has ended; before that only the active one counts
    expect(out.map((o) => o.stopCount)).toEqual([1, 2, 2, 2]);
    expect([out[0].totalValue, out[1].totalValue]).toEqual([20, 30]);

    // when the pause is the earliest thing coming back, the series starts on the resume day (Mon 23 Nov)
    const resumeFirst = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { status: "PAUSED", pauseEndDate: d("2026-11-22"), cleaningFrequency: "FOUR_WEEKLY" })],
    });
    expect((await projectOccurrences(resumeFirst, ["r1"], TODAY)).get("r1")![0].date).toBe("2026-11-23");
  });

  it("resume day for a round with no round day follows the working days", async () => {
    getCachedBusinessSettings.mockResolvedValue({ defaultWorkingDays: ["MON", "TUE", "WED", "THU", "FRI"] });
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: null, frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { status: "PAUSED", pauseEndDate: d("2026-11-21"), cleaningFrequency: "FOUR_WEEKLY" })],
    });
    // pause ends Sat 21 Nov -> day after is Sun 22 Nov -> snapped to Mon 23 Nov
    expect((await projectOccurrences(tp, ["r1"], TODAY)).get("r1")![0].date).toBe("2026-11-23");
  });

  it("counts only plans on the round's frequency (or with none) and skips cancelled-out estimates of zero", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "EIGHT_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "EIGHT_WEEKLY" }), plan("r1", { cleaningFrequency: null }), plan("r1", { cleaningFrequency: "FOUR_WEEKLY" })],
      visits: [{ roundId: "r1", date: d("2026-11-16"), status: "SCHEDULED" }],
    });
    expect((await projectOccurrences(tp, ["r1"], TODAY)).get("r1")![0].stopCount).toBe(2);

    const onlyOther = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "EIGHT_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY" })],
      visits: [{ roundId: "r1", date: d("2026-11-16"), status: "SCHEDULED" }],
    });
    expect((await projectOccurrences(onlyOther, ["r1"], TODAY)).size).toBe(0);
  });

  it("only returns projected dates inside the requested window, with either bound optional", async () => {
    const base = {
      rounds: [{ id: "r1", defaultDay: "FRI", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-11-20") })],
    };
    const dates = async (from?: Date, to?: Date) => (await projectOccurrences(makeTp(base), ["r1"], TODAY, from, to)).get("r1")?.map((o) => o.date);
    expect(await dates(d("2026-12-01"), d("2027-01-31"))).toEqual(["2026-12-18", "2027-01-15"]);
    expect(await dates(d("2027-01-01"), undefined)).toEqual(["2027-01-15", "2027-02-12"]);
    expect(await dates(undefined, d("2026-12-18"))).toEqual(["2026-11-20", "2026-12-18"]);
    expect(await dates(d("2026-12-19"), d("2027-01-14"))).toBeUndefined();
  });

  it("handles several rounds at once and keeps each round's plans and visits apart", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "EIGHT_WEEKLY" }, { id: "r2", defaultDay: "FRI", frequency: "TWELVE_WEEKLY" }],
      plans: [plan("r1"), plan("r2", { cleaningFrequency: "TWELVE_WEEKLY", nextDueDate: d("2026-11-20") })],
      visits: [{ roundId: "r1", date: d("2026-11-16"), status: "SCHEDULED" }],
    });
    const out = await projectOccurrences(tp, ["r1", "r2"], TODAY);
    expect(out.get("r1")!.map((o) => o.date)).toEqual(["2027-01-11"]);
    expect(out.get("r2")!.map((o) => o.date)).toEqual(["2026-11-20", "2027-02-12"]);
  });

  it("asks only for what it needs: active/paused plans, and upcoming non-cancelled visits", async () => {
    const tp = makeTp({ rounds: [{ id: "r1", defaultDay: "MON", frequency: "EIGHT_WEEKLY" }], plans: [plan("r1")] });
    await projectOccurrences(tp, ["r1"], TODAY);
    expect((tp as any).servicePlan.findMany.mock.calls[0][0].where).toEqual({ property: { roundId: { in: ["r1"] } }, status: { in: ["ACTIVE", "PAUSED"] } });
    expect((tp as any).visit.groupBy.mock.calls[0][0]).toMatchObject({ by: ["roundId", "date", "status"], where: { roundId: { in: ["r1"] }, status: { not: "CANCELLED" }, date: { gte: TODAY } } });
  });

  it("a round with upcoming visits but no plans at all projects nothing", async () => {
    const tp = makeTp({ rounds: [{ id: "r1", defaultDay: "MON", frequency: "EIGHT_WEEKLY" }], visits: [{ roundId: "r1", date: d("2026-11-16"), status: "SCHEDULED" }] });
    expect((await projectOccurrences(tp, ["r1"], TODAY)).size).toBe(0);
  });

  it("a stray plan or visit with no round is ignored", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "EIGHT_WEEKLY" }],
      plans: [plan("r1"), { ...plan("r1"), property: { roundId: null } }],
      visits: [{ roundId: null as never, date: d("2026-11-16"), status: "SCHEDULED" }],
    });
    expect((await projectOccurrences(tp, ["r1"], TODAY)).get("r1")![0].date).toBe("2027-01-11");
  });
});

// ---- anchor = plans' nextDueDate, never the dates of existing visits (rules section 5.1, example P1) ----------------

describe("projectOccurrences anchors the forecast on nextDueDate", () => {
  const MON4 = { id: "r1", defaultDay: "MON", frequency: "FOUR_WEEKLY" };
  const p4 = (over: Record<string, unknown> = {}) => plan("r1", { cleaningFrequency: "FOUR_WEEKLY", ...over });
  const dates = async (tp: never, today = TODAY) => (await projectOccurrences(tp, ["r1"], today)).get("r1")?.map((o) => o.date);

  it("P1: a visit pushed to Tuesday does not shift the forecast off the Monday anchor", async () => {
    const tp = makeTp({
      rounds: [MON4],
      plans: [p4({ nextDueDate: d("2026-12-14") })],
      visits: [{ roundId: "r1", date: d("2026-11-17"), status: "SCHEDULED" }],
    });
    // real 17 Nov takes one of the 4 slots, so three forecasts
    expect(await dates(tp, d("2026-11-17"))).toEqual(["2026-12-14", "2027-01-11", "2027-02-08"]);
  });

  it("all upcoming visits on Tuesday: still the Monday cycle", async () => {
    const tp = makeTp({
      rounds: [MON4],
      plans: [p4({ nextDueDate: d("2027-01-11") })],
      visits: [{ roundId: "r1", date: d("2026-11-17"), status: "SCHEDULED" }, { roundId: "r1", date: d("2026-12-15"), status: "SCHEDULED" }],
    });
    // both real Tuesdays use a slot of the cap; the 14 Dec cycle was already generated (nextDueDate is the next cycle)
    expect(await dates(tp, d("2026-11-17"))).toEqual(["2027-01-11", "2027-02-08"]);
  });

  it("a mix of Monday and Wednesday upcoming visits ignores their dates", async () => {
    const tp = makeTp({
      rounds: [MON4],
      plans: [p4({ nextDueDate: d("2026-12-14") })],
      visits: [{ roundId: "r1", date: d("2026-11-18"), status: "SCHEDULED" }, { roundId: "r1", date: d("2026-11-23"), status: "SCHEDULED" }],
    });
    expect(await dates(tp, d("2026-11-17"))).toEqual(["2026-12-14", "2027-01-11"]);
  });

  it("a plan whose visit is already generated (next cycle) versus one with no visit yet", async () => {
    const generated = makeTp({
      rounds: [MON4],
      plans: [p4({ nextDueDate: d("2026-12-14") })],
      visits: [{ roundId: "r1", date: d("2026-11-16"), status: "SCHEDULED" }],
    });
    expect(await dates(generated, d("2026-11-16"))).toEqual(["2026-12-14", "2027-01-11", "2027-02-08"]);
    const noVisit = makeTp({ rounds: [MON4], plans: [p4({ nextDueDate: d("2026-11-16") })] });
    expect(await dates(noVisit, d("2026-11-16"))).toEqual(["2026-11-16", "2026-12-14", "2027-01-11", "2027-02-08"]);
  });

  it("a paused plan with a resume day anchors the series when it is the earliest", async () => {
    // pause ends Wed 18 Nov -> resumes Mon 23 Nov; the active plan is not due until 14 Dec
    const tp = makeTp({
      rounds: [MON4],
      plans: [p4({ status: "PAUSED", pauseEndDate: d("2026-11-18") }), p4({ nextDueDate: d("2026-12-14") })],
      visits: [{ roundId: "r1", date: d("2026-11-17"), status: "SCHEDULED" }],
    });
    expect(await dates(tp, d("2026-11-17"))).toEqual(["2026-11-23", "2026-12-21", "2027-01-18"]);
  });

  it.each([
    ["FOUR_WEEKLY", ["2026-12-14", "2027-01-11", "2027-02-08"]],
    ["SIX_WEEKLY", ["2026-12-14", "2027-01-25"]],
    ["EIGHT_WEEKLY", ["2026-12-14", "2027-02-08"]],
    ["TWELVE_WEEKLY", ["2026-12-14"]],
  ])("%s with the only visit pushed to Tuesday", async (freq, expected) => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: freq }],
      plans: [plan("r1", { cleaningFrequency: freq, nextDueDate: d("2026-12-14") })],
      visits: [{ roundId: "r1", date: d("2026-11-17"), status: "SCHEDULED" }],
    });
    // the horizon runs 13 weeks from the real visit (17 Nov -> 16 Feb) and the cap (real takes one slot) bound the list
    expect(await dates(tp, d("2026-11-17"))).toEqual(expected);
  });

  it("real wins: a real visit on a series date replaces it and nothing earlier is forecast", async () => {
    const tp = makeTp({
      rounds: [MON4],
      plans: [p4({ nextDueDate: d("2026-12-14") })],
      visits: [{ roundId: "r1", date: d("2026-12-14"), status: "SCHEDULED" }],
    });
    expect(await dates(tp, d("2026-11-17"))).toEqual(["2027-01-11", "2027-02-08", "2027-03-08"]);
  });

  it("cap of 4 counting real visits before the anchor, and the 13-week horizon from the first forecast", async () => {
    const many = makeTp({
      rounds: [MON4],
      plans: [p4({ nextDueDate: d("2026-12-14") })],
      visits: ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23"].map((x) => ({ roundId: "r1", date: d(x), status: "SCHEDULED" })),
    });
    expect(await dates(many, d("2026-11-17"))).toBeUndefined();
    const far = makeTp({ rounds: [{ id: "r1", defaultDay: "MON", frequency: "TWELVE_WEEKLY" }], plans: [plan("r1", { cleaningFrequency: "TWELVE_WEEKLY", nextDueDate: d("2026-12-14") })] });
    expect(await dates(far, d("2026-11-17"))).toEqual(["2026-12-14", "2027-03-08"]);
  });

  it("a round with no round day: the anchor snaps to a working day (Sat 21 Nov -> Mon 23 Nov), cycles stay whole", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: null, frequency: "FOUR_WEEKLY" }],
      plans: [p4({ nextDueDate: d("2026-11-21") })],
      visits: [{ roundId: "r1", date: d("2026-11-23"), status: "SCHEDULED" }],
    });
    expect(await dates(tp, d("2026-11-17"))).toEqual(["2026-12-21", "2027-01-18", "2027-02-15"]);
  });

  it("an anchor that is not on the round day lands on the round day", async () => {
    const tp = makeTp({ rounds: [MON4], plans: [p4({ nextDueDate: d("2026-12-16") })] });
    expect(await dates(tp, d("2026-11-17"))).toEqual(["2026-12-21", "2027-01-18", "2027-02-15", "2027-03-15"]);
  });

  it("plans on different anchors in one round: the earliest starts the series, the estimate counts plans due by then", async () => {
    const tp = makeTp({
      rounds: [MON4],
      plans: [p4({ nextDueDate: d("2026-12-14"), price: dec(10) }), p4({ nextDueDate: d("2027-01-11"), price: dec(5) })],
      visits: [{ roundId: "r1", date: d("2026-11-17"), status: "SCHEDULED" }],
    });
    const out = (await projectOccurrences(tp, ["r1"], d("2026-11-17"))).get("r1")!;
    expect(out.map((o) => o.date)).toEqual(["2026-12-14", "2027-01-11", "2027-02-08"]);
  });

  it("pins the horizon base: 13 weeks from the earliest real visit, not from the first forecast date", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "EIGHT_WEEKLY" }],
      plans: [plan("r1", { nextDueDate: d("2027-01-11") })],
      visits: [{ roundId: "r1", date: d("2026-11-16"), status: "SCHEDULED" }],
    });
    expect(await dates(tp, d("2026-11-16"))).toEqual(["2027-01-11"]);
  });

  it("no plans, or nothing to project, gives nothing even with upcoming visits", async () => {
    const noPlans = makeTp({ rounds: [MON4], visits: [{ roundId: "r1", date: d("2026-11-17"), status: "SCHEDULED" }] });
    expect(await dates(noPlans, d("2026-11-17"))).toBeUndefined();
    const nothing = makeTp({ rounds: [MON4], plans: [p4({ nextDueDate: null })] });
    expect(await dates(nothing, d("2026-11-17"))).toBeUndefined();
  });
});

// ---- business closures (rules s5.2, examples P2-P6) --------------------------------------------------------------

describe("projectOccurrences with closures", () => {
  const XMAS = { id: "xmas", label: "XMAS", startDate: d("2026-12-24"), endDate: d("2027-01-03"), mode: "MOVE", roundIds: [] as string[] };
  const four = (extra: Record<string, unknown> = {}) => ({
    rounds: [{ id: "r1", defaultDay: "MON", frequency: "FOUR_WEEKLY" }],
    plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-12-28") })],
    ...extra,
  });
  const dates = async (tp: unknown, today = d("2026-12-01"), roundId = "r1") =>
    (await projectOccurrences(tp as never, [roundId], today)).get(roundId)?.map((o) => o.date);

  it("P2: XMAS MOVE shows the moved date and the next cycle returns to the anchor", async () => {
    expect(await dates(makeTp(four({ closures: [XMAS] })))).toEqual(["2027-01-04", "2027-01-25", "2027-02-22", "2027-03-22"]);
  });

  it("P3: XMAS as SKIP drops the cycle; the cap admits the next one (horizon measured from the first entry)", async () => {
    expect(await dates(makeTp(four({ closures: [{ ...XMAS, mode: "SKIP" }] })))).toEqual(["2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"]);
  });

  it("P4: a 5-week MOVE closure collapses the 01-11 cycle (served by the 01-25 entry)", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-12-14") })],
      closures: [{ ...XMAS, startDate: d("2026-12-14"), endDate: d("2027-01-18") }],
    });
    expect(await dates(tp)).toEqual(["2027-01-25", "2027-02-08", "2027-03-08", "2027-04-05"]);
  });

  it("P5: a closure that has ended before the forecast has no effect, and one that ended over 366 days ago is dropped", async () => {
    const old = { ...XMAS, id: "old", startDate: d("2025-01-01"), endDate: d("2025-01-05") };
    const tp = makeTp({ ...four({ plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2027-01-11") })], closures: [XMAS, old] }) });
    expect(await dates(tp, d("2027-01-11"))).toEqual(["2027-01-11", "2027-02-08", "2027-03-08", "2027-04-05"]);
    expect((tp as any).businessClosure.findMany).toHaveBeenCalledTimes(1);
    expect((tp as any).businessClosure.findMany).toHaveBeenCalledWith({ where: { endDate: { gte: d("2026-01-10") } } });
  });

  it("P6: a round-scoped closure changes the forecast only for that round", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "FOUR_WEEKLY" }, { id: "r2", defaultDay: "MON", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-12-28") }), plan("r2", { cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-12-28") })],
      closures: [{ ...XMAS, roundIds: ["r2"] }],
    });
    const out = await projectOccurrences(tp, ["r1", "r2"], d("2026-12-01"));
    expect(out.get("r1")!.map((o) => o.date)).toEqual(["2026-12-28", "2027-01-25", "2027-02-22", "2027-03-22"]);
    expect(out.get("r2")!.map((o) => o.date)).toEqual(["2027-01-04", "2027-01-25", "2027-02-22", "2027-03-22"]);
    expect((tp as any).businessClosure.findMany).toHaveBeenCalledTimes(1);
  });

  it("the horizon runs from the next real visit when it is earlier: a moved entry past it is dropped; real visits use up cap slots", async () => {
    const tp = makeTp(four({
      closures: [XMAS],
      visits: [{ roundId: "r1", date: d("2026-12-02"), status: "SCHEDULED" }],
    }));
    // horizon = 12-02 + 13 weeks = 03-03: 01-04, 01-25, 02-22 fit, 03-22 does not; one slot taken by the real visit
    expect(await dates(tp)).toEqual(["2027-01-04", "2027-01-25", "2027-02-22"]);
  });

  it("a round whose every cycle is skipped has nothing to forecast", async () => {
    const tp = makeTp(four({ closures: [{ ...XMAS, mode: "SKIP", startDate: d("2026-12-01"), endDate: d("2036-12-31") }] }));
    expect((await projectOccurrences(tp, ["r1"], d("2026-12-01"))).has("r1")).toBe(false);
  });

  it("closureProjectionSeries: stops at the cap and ignores a time part on the first date", () => {
    const s = closureProjectionSeries(new Date("2026-12-28T09:00:00Z"), { id: "r1", defaultDay: "MON" as never }, "FOUR_WEEKLY" as never, [], []);
    expect(keys(s)).toEqual(["2026-12-28", "2027-01-25", "2027-02-22", "2027-03-22"]);
  });
});

// ---- stale nextDueDate (rules 5.1 amended, examples P7, P8, C2) ----------------------------------------------------------

describe("projectOccurrences with a stale nextDueDate", () => {
  const MOVE = { id: "k", label: "Refit", startDate: d("2026-12-14"), endDate: d("2027-01-18"), mode: "MOVE", roundIds: [] as string[] };
  const round4 = [{ id: "r1", defaultDay: "MON", frequency: "FOUR_WEEKLY" }];
  const p4 = (id: string, due: string, over: Record<string, unknown> = {}) => plan("r1", { id, cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d(due), ...over });
  const run = async (tp: unknown, today: string) => (await projectOccurrences(tp as never, ["r1"], d(today))).get("r1")?.map((o) => o.date);

  it("P7: after a MOVE collapse the plan has a visit on 01-25 and nextDueDate 01-11; read on 01-27 the forecast is 02-08, 03-08, 04-05 (never 02-01)", async () => {
    const tp = makeTp({ rounds: round4, plans: [p4("a", "2027-01-11")], closures: [MOVE], latest: { a: d("2027-01-25") } });
    expect(await run(tp, "2027-01-27")).toEqual(["2027-02-08", "2027-03-08", "2027-04-05", "2027-05-03"]);
  });

  it("P8 / C2: a visit pushed to Wed 12-16 serves the 12-14 cycle: real 12-16, forecast 01-11, 02-08, 03-08", async () => {
    const tp = makeTp({
      rounds: round4, plans: [p4("a", "2026-12-14")],
      visits: [{ roundId: "r1", date: d("2026-12-16"), status: "SCHEDULED" }], latest: { a: d("2026-12-16") },
    });
    expect(await run(tp, "2026-12-14")).toEqual(["2027-01-11", "2027-02-08", "2027-03-08"]);
  });

  it("no closure: a visit pushed past the NEXT cycle serves both cycles", async () => {
    const tp = makeTp({
      rounds: round4, plans: [p4("a", "2026-12-14")],
      visits: [{ roundId: "r1", date: d("2027-01-12"), status: "SCHEDULED" }], latest: { a: d("2027-01-12") },
    });
    expect(await run(tp, "2026-12-14")).toEqual(["2027-02-08", "2027-03-08", "2027-04-05"]);
  });

  it("a plan whose latest visit is later than N but earlier than the cycle's visit date is NOT served", async () => {
    // N is Thu 12-10, the cycle falls on Mon 12-14; the latest visit (Sat 12-12) is after N but before the cycle
    const tp = makeTp({ rounds: round4, plans: [p4("a", "2026-12-10")], latest: { a: d("2026-12-12") } });
    expect(await run(tp, "2026-12-01")).toEqual(["2026-12-14", "2027-01-11", "2027-02-08", "2027-03-08"]);
  });

  it("several plans with different anchors: the plan whose first forecast is earliest starts the series", async () => {
    const early = makeTp({ rounds: round4, plans: [p4("a", "2026-12-14", {}), p4("b", "2026-12-28")], latest: { a: d("2026-12-16") } });
    expect(await run(early, "2026-12-01")).toEqual(["2026-12-28", "2027-01-25", "2027-02-22", "2027-03-22"]);
    const other = makeTp({ rounds: round4, plans: [p4("a", "2026-12-14"), p4("b", "2026-12-28")] });
    expect(await run(other, "2026-12-01")).toEqual(["2026-12-14", "2027-01-11", "2027-02-08", "2027-03-08"]);
  });

  it("an overdue plan with no visit: the first forecast is clamped to today, the cycles after it keep the phase", async () => {
    const tp = makeTp({ rounds: round4, plans: [p4("a", "2026-11-16")] });
    expect(await run(tp, "2026-12-02")).toEqual(["2026-12-02", "2026-12-14", "2027-01-11", "2027-02-08"]);
  });

  it("one-off visits never count: both visit queries exclude them, and the served query looks at any date", async () => {
    const tp = makeTp({ rounds: round4, plans: [p4("a", "2026-12-14")] });
    await run(tp, "2026-12-14");
    const calls = (tp as any).visit.groupBy.mock.calls.map((c: any) => c[0]);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.where).toMatchObject({ isOneOff: false, status: { not: "CANCELLED" } });
    const served = calls.find((c: any) => c.by.includes("servicePlanId"));
    expect(served.where.date).toBeUndefined();
    expect(served._max).toEqual({ date: true });
    expect(served.where.servicePlanId).toEqual({ in: ["a"] });
    expect(calls.find((c: any) => !c.by.includes("servicePlanId")).where.date).toEqual({ gte: d("2026-12-14") });
  });

  it("ignores per-plan rows without a plan id or without a date", async () => {
    const tp = makeTp({
      rounds: round4, plans: [p4("a", "2026-12-14")],
      latestRows: [{ servicePlanId: null, _max: { date: d("2027-06-01") } }, { servicePlanId: "a", _max: { date: null } }],
    });
    expect(await run(tp, "2026-12-14")).toEqual(["2026-12-14", "2027-01-11", "2027-02-08", "2027-03-08"]);
  });

  it("the first forecast is always shown, even when it is more than 13 weeks after the next real visit", async () => {
    const tp = makeTp({
      rounds: round4, plans: [p4("a", "2027-03-01")],
      visits: [{ roundId: "r1", date: d("2026-11-16"), status: "SCHEDULED" }],
    });
    expect(await run(tp, "2026-11-12")).toEqual(["2027-03-01"]);
  });

  it("planFirstCycle: null when every cycle it looks at is dropped", () => {
    const skipAll = { id: "s", label: "s", startDate: d("2026-12-01"), endDate: d("2036-12-31"), mode: "SKIP" as const, roundIds: [] };
    expect(planFirstCycle(d("2026-12-14"), null, { id: "r1", defaultDay: "MON" as never }, "FOUR_WEEKLY" as never, [], [skipAll])).toBeNull();
  });
});
