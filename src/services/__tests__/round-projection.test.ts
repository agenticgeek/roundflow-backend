import { describe, it, expect, vi, beforeEach } from "vitest";

const getCachedBusinessSettings = vi.fn();
vi.mock("../settings.service", () => ({ getCachedBusinessSettings: (...a: unknown[]) => getCachedBusinessSettings(...a) }));

import { projectionSeries, projectOccurrences, PROJECTION_HORIZON_WEEKS, PROJECTION_MAX_ENTRIES } from "../round-projection";

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
}) {
  return {
    round: { findMany: vi.fn().mockResolvedValue(opts.rounds ?? []) },
    servicePlan: { findMany: vi.fn().mockResolvedValue(opts.plans ?? []) },
    visit: { groupBy: vi.fn().mockResolvedValue(opts.visits ?? []) },
  } as never;
}

const plan = (roundId: string, over: Record<string, unknown> = {}) => ({
  price: dec(24), cleaningFrequency: "EIGHT_WEEKLY", status: "ACTIVE", nextDueDate: d("2027-01-11"), pauseEndDate: null, property: { roundId }, ...over,
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

  it("the seeded 8-weekly Monday round: one real visit on 16 Nov projects 11 Jan, estimated from its plans", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "MON", frequency: "EIGHT_WEEKLY" }],
      plans: [plan("r1", { price: dec(24) }), plan("r1", { price: dec(30.5) })],
      visits: [{ roundId: "r1", date: d("2026-11-16"), status: "SCHEDULED" }],
    });
    const out = await projectOccurrences(tp, ["r1"], TODAY);
    expect(out.get("r1")).toEqual([
      { date: "2027-01-11", stopCount: 2, totalValue: 54.5, completedCount: 0, completionPct: 0, holdCount: 0, issueCount: 0, technicians: [], projected: true },
    ]);
  });

  it("real visits win: dates that already have visits are not projected, and they count toward the cap of 4", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "THU", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY" })],
      visits: [
        { roundId: "r1", date: d("2026-11-12"), status: "SCHEDULED" },
        { roundId: "r1", date: d("2026-12-10"), status: "SCHEDULED" },
      ],
    });
    const out = await projectOccurrences(tp, ["r1"], TODAY);
    expect(out.get("r1")!.map((o) => o.date)).toEqual(["2027-01-07", "2027-02-04"]);
  });

  it("nothing earlier in the series than a real visit is projected", async () => {
    // next real = 12 Nov (in progress), a later real visit on 7 Jan: only 4 Feb comes after it
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: "THU", frequency: "FOUR_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "FOUR_WEEKLY" })],
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

  it("an overdue plan starts the series today, not in the past", async () => {
    const tp = makeTp({
      rounds: [{ id: "r1", defaultDay: null, frequency: "TWELVE_WEEKLY" }],
      plans: [plan("r1", { cleaningFrequency: "TWELVE_WEEKLY", nextDueDate: d("2026-11-02") })],
    });
    expect((await projectOccurrences(tp, ["r1"], TODAY)).get("r1")!.map((o) => o.date)).toEqual(["2026-11-12", "2027-02-04"]);
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
