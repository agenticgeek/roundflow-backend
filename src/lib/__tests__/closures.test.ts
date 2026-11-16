import { describe, expect, it } from "vitest";
import type { DayOfWeek } from "../../generated/tenant-client";
import {
  CLOSURE_RESOLUTION_LIMIT,
  ClosureResolutionLimitError,
  activeClosures,
  advanceDueDate,
  closuresCovering,
  isServedCycle,
  resolveClosedDate,
  visitDateFor,
  type ClosureResolution,
  type ClosureWindow,
} from "../closures";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const MON_FRI = ["MON", "TUE", "WED", "THU", "FRI"];
const MON_SAT = ["MON", "TUE", "WED", "THU", "FRI", "SAT"];
const TUE_SAT = ["TUE", "WED", "THU", "FRI", "SAT"];

let seq = 0;
function closure(
  start: string,
  end: string,
  mode: "MOVE" | "SKIP" = "MOVE",
  roundIds: string[] = [],
  id?: string,
): ClosureWindow {
  seq += 1;
  return { id: id ?? `c${seq}`, label: `closure ${seq}`, startDate: d(start), endDate: d(end), mode, roundIds };
}
const xmas = (mode: "MOVE" | "SKIP" = "MOVE") => closure("2026-12-24", "2027-01-03", mode, [], "XMAS");

// Test-local aid: the nightly rule of rules s4, built on the exported helpers.
// Not the production generation (that lives in visitGeneration.ts).
interface SimInput {
  start: string;
  weeks: number;
  day: DayOfWeek | null;
  workingDays?: string[];
  closures?: ClosureWindow[];
  count: number; // visits to create
  existing?: string[]; // dates of visits the plan already has
}
function simulate(i: SimInput) {
  const wd = i.workingDays ?? MON_FRI;
  const closures = activeClosures(i.closures ?? [], d(i.start));
  const visits: string[] = [];
  const moved: string[] = [];
  const skipped: string[] = [];
  let latest: Date | null = (i.existing ?? []).map(d).reduce<Date | null>((a, b) => (!a || b > a ? b : a), null);
  let next = d(i.start);
  while (visits.length < i.count) {
    const v0 = visitDateFor(next, i.day, wd);
    const r = resolveClosedDate({ visitDate: v0, roundId: "r1", defaultDay: i.day, workingDays: wd, closures });
    const advanced = advanceDueDate(next, v0, { weeks: i.weeks, defaultDay: i.day, workingDays: wd });
    if (r.action === "SKIP") {
      skipped.push(iso(v0));
      next = advanced;
      continue;
    }
    if (isServedCycle(r.date, latest)) {
      next = advanced;
      continue;
    }
    visits.push(iso(r.date));
    if (r.action === "MOVE") moved.push(iso(r.date));
    latest = r.date;
    next = advanced;
  }
  return { visits, moved, skipped, nextDue: iso(next) };
}

describe("visitDateFor", () => {
  it("uses the round day on or after the date, even on a non-working day", () => {
    expect(iso(visitDateFor(d("2026-12-28"), "MON", MON_FRI))).toBe("2026-12-28");
    expect(iso(visitDateFor(d("2026-12-29"), "MON", MON_FRI))).toBe("2027-01-04");
    expect(iso(visitDateFor(d("2026-12-26"), "SUN", MON_FRI))).toBe("2026-12-27");
  });
  it("snaps to a working day when the round has no day", () => {
    expect(iso(visitDateFor(d("2026-11-21"), null, MON_FRI))).toBe("2026-11-23");
    expect(iso(visitDateFor(d("2026-11-23"), null, MON_FRI))).toBe("2026-11-23");
    expect(iso(visitDateFor(d("2026-11-21"), undefined, MON_FRI))).toBe("2026-11-23");
  });
  it("treats an empty working-day list as Monday to Friday", () => {
    expect(iso(visitDateFor(d("2026-11-21"), null, []))).toBe("2026-11-23");
  });
});

describe("advanceDueDate", () => {
  it("adds the cycle and snaps to the round day or working day", () => {
    expect(iso(advanceDueDate(d("2026-11-16"), d("2026-11-16"), { weeks: 4, defaultDay: "MON", workingDays: MON_FRI }))).toBe("2026-12-14");
    expect(iso(advanceDueDate(d("2026-11-16"), d("2026-11-16"), { weeks: 12, defaultDay: null, workingDays: MON_FRI }))).toBe("2027-02-08");
    expect(iso(advanceDueDate(d("2026-12-26"), d("2026-12-26"), { weeks: 4, defaultDay: null, workingDays: MON_FRI }))).toBe("2027-01-25");
    expect(iso(advanceDueDate(d("2026-12-26"), d("2026-12-26"), { weeks: 4, defaultDay: null, workingDays: MON_SAT }))).toBe("2027-01-23");
  });
  it("snaps a non-round-day visit date forward to the round day", () => {
    expect(iso(advanceDueDate(d("2026-11-16"), d("2026-11-17"), { weeks: 4, defaultDay: "MON", workingDays: MON_FRI }))).toBe("2026-12-21");
  });
});

describe("closuresCovering", () => {
  const all = closure("2026-12-24", "2027-01-03");
  const r1 = closure("2026-12-24", "2027-01-03", "MOVE", ["r1"]);
  const r2 = closure("2026-12-24", "2027-01-03", "MOVE", ["r2"]);
  it("treats an empty roundIds as all rounds and scopes by round id", () => {
    expect(closuresCovering(d("2026-12-28"), "r1", [all, r1, r2])).toEqual([all, r1]);
    expect(closuresCovering(d("2026-12-28"), "r3", [all, r1, r2])).toEqual([all]);
    expect(closuresCovering(d("2026-12-28"), "r1", [r2])).toEqual([]);
  });
  it("includes both end days and excludes the days around", () => {
    expect(closuresCovering(d("2026-12-23"), "r1", [all])).toEqual([]);
    expect(closuresCovering(d("2026-12-24"), "r1", [all])).toEqual([all]);
    expect(closuresCovering(d("2027-01-03"), "r1", [all])).toEqual([all]);
    expect(closuresCovering(d("2027-01-04"), "r1", [all])).toEqual([]);
  });
  it("returns nothing for no closures", () => {
    expect(closuresCovering(d("2026-12-28"), "r1", [])).toEqual([]);
  });
});

describe("activeClosures", () => {
  const ended = closure("2026-11-01", "2026-11-15");
  const endsToday = closure("2026-11-10", "2026-11-16");
  const future = closure("2026-12-24", "2027-01-03");
  it("keeps closures whose end is today or later", () => {
    expect(activeClosures([ended, endsToday, future], d("2026-11-16"))).toEqual([endsToday, future]);
    expect(activeClosures([ended, endsToday, future], d("2026-11-17"))).toEqual([future]);
    expect(activeClosures([], d("2026-11-17"))).toEqual([]);
  });
});

describe("isServedCycle", () => {
  it("is false with no plan visit", () => {
    expect(isServedCycle(d("2026-12-14"), null)).toBe(false);
  });
  it("is true when a visit is on or after the candidate, false when earlier", () => {
    expect(isServedCycle(d("2026-12-14"), d("2026-12-16"))).toBe(true);
    expect(isServedCycle(d("2026-12-14"), d("2026-12-14"))).toBe(true);
    expect(isServedCycle(d("2026-12-14"), d("2026-12-13"))).toBe(false);
  });
});

describe("resolveClosedDate (rules 8.4)", () => {
  const run = (
    visitDate: string,
    day: DayOfWeek | null,
    closures: ClosureWindow[],
    workingDays: string[] = MON_FRI,
    roundId = "r1",
  ): ClosureResolution => resolveClosedDate({ visitDate: d(visitDate), roundId, defaultDay: day, workingDays, closures });
  const move = (r: ClosureResolution) => {
    expect(r.action).toBe("MOVE");
    return r as Extract<ClosureResolution, { action: "MOVE" }>;
  };

  it("R1 keep when nothing covers", () => {
    const r = run("2026-12-21", "MON", []);
    expect(r).toEqual({ action: "KEEP", date: d("2026-12-21") });
    expect(run("2026-12-21", "MON", [xmas()])).toEqual({ action: "KEEP", date: d("2026-12-21") });
  });
  it("R2 Monday round moves to the next Monday", () => {
    const r = move(run("2026-12-28", "MON", [xmas()]));
    expect(iso(r.date)).toBe("2027-01-04");
    expect(r.closureIds).toEqual(["XMAS"]);
  });
  it("R3 first closed day (Thu)", () => {
    expect(iso(move(run("2026-12-24", "THU", [xmas()])).date)).toBe("2027-01-07");
  });
  it("R4 Thu 12-31", () => {
    expect(iso(move(run("2026-12-31", "THU", [xmas()])).date)).toBe("2027-01-07");
  });
  it("R5 Fri 01-01", () => {
    expect(iso(move(run("2027-01-01", "FRI", [xmas()])).date)).toBe("2027-01-08");
  });
  it("R6 Sunday round is not checked against working days", () => {
    expect(iso(move(run("2026-12-27", "SUN", [xmas()])).date)).toBe("2027-01-10");
  });
  it("R7 no round day", () => {
    expect(iso(move(run("2026-12-28", null, [xmas()])).date)).toBe("2027-01-04");
  });
  it("R8 no round day, Tue to Sat working days", () => {
    expect(iso(move(run("2026-12-26", null, [xmas()], TUE_SAT)).date)).toBe("2027-01-05");
  });
  it("R9 and R10 keep outside the closure", () => {
    expect(run("2027-01-06", "WED", [xmas()])).toEqual({ action: "KEEP", date: d("2027-01-06") });
    expect(run("2026-12-23", "WED", [xmas()])).toEqual({ action: "KEEP", date: d("2026-12-23") });
  });
  it("R11 Saturday round", () => {
    expect(iso(move(run("2027-01-02", "SAT", [xmas()])).date)).toBe("2027-01-09");
  });
  it("R12 SKIP closure", () => {
    expect(run("2026-12-28", "MON", [xmas("SKIP")])).toEqual({ action: "SKIP", closureId: "XMAS" });
  });
  it("R13 landing day in a SKIP closure skips", () => {
    const skip = closure("2027-01-04", "2027-01-04", "SKIP", [], "S");
    expect(run("2026-12-28", "MON", [xmas(), skip])).toEqual({ action: "SKIP", closureId: "S" });
  });
  it("R14 chained closure", () => {
    const chain = closure("2027-01-04", "2027-01-17", "MOVE", [], "CH");
    const r = move(run("2026-12-28", "MON", [xmas(), chain]));
    expect(iso(r.date)).toBe("2027-01-18");
    expect(r.closureIds).toEqual(["XMAS", "CH"]);
  });
  it("R15 identical duplicate closures", () => {
    const r = move(run("2026-12-28", "MON", [xmas(), closure("2026-12-24", "2027-01-03", "MOVE", [], "DUP")]));
    expect(iso(r.date)).toBe("2027-01-04");
    expect(r.closureIds).toEqual(["XMAS", "DUP"]);
  });
  it("R16 nested closure", () => {
    const outer = closure("2026-12-24", "2027-01-10", "MOVE", [], "OUT");
    const inner = closure("2026-12-28", "2026-12-30", "MOVE", [], "IN");
    const r = move(run("2026-12-28", "MON", [inner, outer]));
    expect(iso(r.date)).toBe("2027-01-11");
    expect(r.closureIds.sort()).toEqual(["IN", "OUT"]);
  });
  it("R17 closure ending on the first Monday", () => {
    expect(iso(move(run("2026-12-28", "MON", [closure("2026-12-24", "2027-01-04")])).date)).toBe("2027-01-11");
  });
  it("R18 one-day closure on the visit day", () => {
    expect(iso(move(run("2026-12-28", "MON", [closure("2026-12-28", "2026-12-28")])).date)).toBe("2027-01-04");
  });
  it("R20 round-scoped closure for another round keeps", () => {
    const other = closure("2026-12-24", "2027-01-03", "MOVE", ["r2"]);
    expect(run("2026-12-28", "MON", [other])).toEqual({ action: "KEEP", date: d("2026-12-28") });
    expect(iso(move(run("2026-12-28", "MON", [other], MON_FRI, "r2")).date)).toBe("2027-01-04");
  });
  it("SKIP wins over MOVE when both cover the same day", () => {
    const mv = closure("2026-12-24", "2027-01-03", "MOVE", [], "MV");
    const sk = closure("2026-12-28", "2026-12-28", "SKIP", [], "SK");
    expect(run("2026-12-28", "MON", [mv, sk])).toEqual({ action: "SKIP", closureId: "SK" });
  });
  it("touching closures chain", () => {
    const a = closure("2026-12-28", "2027-01-03", "MOVE", [], "A");
    const b = closure("2027-01-04", "2027-01-10", "MOVE", [], "B");
    const r = move(run("2026-12-28", "MON", [a, b]));
    expect(iso(r.date)).toBe("2027-01-11");
    expect(r.closureIds).toEqual(["A", "B"]);
  });
  it("a closure listed after a shorter overlapping one still sets the latest end", () => {
    const short = closure("2026-12-28", "2026-12-29", "MOVE", [], "S");
    const long = closure("2026-12-28", "2027-01-05", "MOVE", [], "L");
    expect(iso(move(run("2026-12-28", "MON", [short, long])).date)).toBe("2027-01-11");
    expect(iso(move(run("2026-12-28", "MON", [long, short])).date)).toBe("2027-01-11");
  });

  describe("R19 resolution limit", () => {
    // One-day closures on consecutive Mondays from 2026-12-28.
    const chainOf = (n: number) =>
      Array.from({ length: n }, (_, k) => {
        const day = new Date(d("2026-12-28").getTime() + k * 7 * 86_400_000);
        return closure(iso(day), iso(day));
      });
    it("throws CLOSURE_RESOLUTION_LIMIT after 400 covered landings", () => {
      expect(CLOSURE_RESOLUTION_LIMIT).toBe(400);
      expect(() => run("2026-12-28", "MON", chainOf(401))).toThrow(ClosureResolutionLimitError);
      expect(() => run("2026-12-28", "MON", chainOf(400))).toThrow("CLOSURE_RESOLUTION_LIMIT");
      const err = (() => {
        try {
          run("2026-12-28", "MON", chainOf(400));
        } catch (e) {
          return e as Error;
        }
        return null;
      })();
      expect(err).toBeInstanceOf(Error);
      expect(err?.name).toBe("ClosureResolutionLimitError");
    });
    it("still resolves a chain just under the limit", () => {
      const r = move(run("2026-12-28", "MON", chainOf(399)));
      expect(r.closureIds).toHaveLength(399);
    });
  });

  it("a round with a day on a non-working day still lands on that day", () => {
    expect(iso(move(run("2026-12-26", "SAT", [xmas()], MON_FRI)).date)).toBe("2027-01-09");
  });
});

describe("generation sequences built from the helpers (rules 8.1 to 8.3)", () => {
  it("A1 4-weekly Monday", () => {
    const r = simulate({ start: "2026-11-16", weeks: 4, day: "MON", count: 6 });
    expect(r.visits).toEqual(["2026-11-16", "2026-12-14", "2027-01-11", "2027-02-08", "2027-03-08", "2027-04-05"]);
    expect(r.nextDue).toBe("2027-05-03");
    expect(r.moved).toEqual([]);
  });
  it("A2 6-weekly Monday", () => {
    expect(simulate({ start: "2026-11-16", weeks: 6, day: "MON", count: 4 }).visits).toEqual([
      "2026-11-16", "2026-12-28", "2027-02-08", "2027-03-22",
    ]);
  });
  it("A3 8-weekly Tuesday", () => {
    expect(simulate({ start: "2026-11-17", weeks: 8, day: "TUE", count: 3 }).visits).toEqual([
      "2026-11-17", "2027-01-12", "2027-03-09",
    ]);
  });
  it("A4 12-weekly Friday", () => {
    expect(simulate({ start: "2026-11-20", weeks: 12, day: "FRI", count: 2 }).visits).toEqual([
      "2026-11-20", "2027-02-12",
    ]);
  });
  it("A5 4-weekly no round day, N on a Saturday", () => {
    expect(simulate({ start: "2026-11-21", weeks: 4, day: null, count: 6 }).visits).toEqual([
      "2026-11-23", "2026-12-21", "2027-01-18", "2027-02-15", "2027-03-15", "2027-04-12",
    ]);
  });

  const TAIL = ["2027-01-25", "2027-02-22", "2027-03-22", "2027-04-19"];

  it("B1 XMAS 4w Monday: anchor kept", () => {
    const r = simulate({ start: "2026-11-30", weeks: 4, day: "MON", closures: [xmas()], count: 6 });
    expect(r.visits).toEqual(["2026-11-30", "2027-01-04", ...TAIL]);
    expect(r.moved).toEqual(["2027-01-04"]);
  });
  it("B2 XMAS 4w Thursday", () => {
    const r = simulate({ start: "2026-12-03", weeks: 4, day: "THU", closures: [xmas()], count: 6 });
    expect(r.visits).toEqual(["2026-12-03", "2027-01-07", "2027-01-28", "2027-02-25", "2027-03-25", "2027-04-22"]);
    expect(r.moved).toEqual(["2027-01-07"]);
  });
  it("B3 XMAS as SKIP", () => {
    const r = simulate({ start: "2026-11-30", weeks: 4, day: "MON", closures: [xmas("SKIP")], count: 5 });
    expect(r.visits).toEqual(["2026-11-30", ...TAIL]);
    expect(r.skipped).toEqual(["2026-12-28"]);
  });
  it("B4 XMAS, no round day", () => {
    const r = simulate({ start: "2026-11-30", weeks: 4, day: null, closures: [xmas()], count: 6 });
    expect(r.visits).toEqual(["2026-11-30", "2027-01-04", ...TAIL]);
  });
  it("B5 XMAS, no round day, Mon to Sat, N Saturday", () => {
    const r = simulate({ start: "2026-12-26", weeks: 4, day: null, workingDays: MON_SAT, closures: [xmas()], count: 5 });
    expect(r.visits).toEqual(["2027-01-04", "2027-01-23", "2027-02-20", "2027-03-20", "2027-04-17"]);
  });
  it("B6 XMAS, no round day, Tue to Sat", () => {
    const r = simulate({ start: "2026-12-26", weeks: 4, day: null, workingDays: TUE_SAT, closures: [xmas()], count: 5 });
    expect(r.visits).toEqual(["2027-01-05", "2027-01-23", "2027-02-20", "2027-03-20", "2027-04-17"]);
  });
  it("B7 XMAS ends Sunday, N 12-28", () => {
    expect(simulate({ start: "2026-12-28", weeks: 4, day: "MON", closures: [xmas()], count: 5 }).visits).toEqual([
      "2027-01-04", ...TAIL,
    ]);
  });
  it("B8 closure to Monday 01-04", () => {
    const r = simulate({ start: "2026-12-28", weeks: 4, day: "MON", closures: [closure("2026-12-24", "2027-01-04")], count: 5 });
    expect(r.visits).toEqual(["2027-01-11", ...TAIL]);
  });
  it("B9 5-week MOVE closure collapses a cycle", () => {
    const r = simulate({ start: "2026-12-14", weeks: 4, day: "MON", closures: [closure("2026-12-14", "2027-01-18")], count: 4 });
    expect(r.visits).toEqual(["2027-01-25", "2027-02-08", "2027-03-08", "2027-04-05"]);
    expect(r.moved).toEqual(["2027-01-25"]);
  });
  it("B10 5-week SKIP closure", () => {
    const r = simulate({ start: "2026-12-14", weeks: 4, day: "MON", closures: [closure("2026-12-14", "2027-01-18", "SKIP")], count: 3 });
    expect(r.visits).toEqual(["2027-02-08", "2027-03-08", "2027-04-05"]);
    expect(r.skipped).toEqual(["2026-12-14", "2027-01-11"]);
  });
  it("B11 MOVE plus SKIP on the landing day", () => {
    const r = simulate({
      start: "2026-12-28", weeks: 4, day: "MON",
      closures: [xmas(), closure("2027-01-02", "2027-01-10", "SKIP")], count: 4,
    });
    expect(r.visits).toEqual(TAIL);
    expect(r.skipped).toEqual(["2026-12-28"]);
  });
  it("B12 chained MOVE closures", () => {
    const r = simulate({
      start: "2026-12-28", weeks: 4, day: "MON",
      closures: [xmas(), closure("2027-01-04", "2027-01-10")], count: 5,
    });
    expect(r.visits).toEqual(["2027-01-11", ...TAIL]);
  });
  it("B13 one-day closure on Monday", () => {
    const r = simulate({ start: "2026-12-28", weeks: 4, day: "MON", closures: [closure("2026-12-28", "2026-12-28")], count: 5 });
    expect(r.visits).toEqual(["2027-01-04", ...TAIL]);
  });
  it("B14 same closure, no round day", () => {
    const r = simulate({ start: "2026-12-28", weeks: 4, day: null, closures: [closure("2026-12-28", "2026-12-28")], count: 5 });
    expect(r.visits).toEqual(["2026-12-29", ...TAIL]);
  });
  it("B15 closure on the Tuesday does not touch a Monday visit", () => {
    const r = simulate({ start: "2026-12-28", weeks: 4, day: "MON", closures: [closure("2026-12-29", "2026-12-29")], count: 5 });
    expect(r.visits).toEqual(["2026-12-28", ...TAIL]);
    expect(r.moved).toEqual([]);
  });
  it("B16 closure Monday to Monday", () => {
    const r = simulate({ start: "2026-12-14", weeks: 4, day: "MON", closures: [closure("2026-12-14", "2026-12-21")], count: 5 });
    expect(r.visits).toEqual(["2026-12-28", "2027-01-11", "2027-02-08", "2027-03-08", "2027-04-05"]);
  });
  it("B17 XMAS 6-weekly", () => {
    expect(simulate({ start: "2026-12-28", weeks: 6, day: "MON", closures: [xmas()], count: 3 }).visits).toEqual([
      "2027-01-04", "2027-02-08", "2027-03-22",
    ]);
  });
  it("B18 XMAS 12-weekly, N the Monday before", () => {
    expect(simulate({ start: "2026-12-21", weeks: 12, day: "MON", closures: [xmas()], count: 3 }).visits).toEqual([
      "2026-12-21", "2027-03-15", "2027-06-07",
    ]);
  });
  it("B19 closure already ended is ignored", () => {
    const r = simulate({ start: "2027-01-11", weeks: 4, day: "MON", closures: [xmas()], count: 4 });
    expect(r.visits).toEqual(["2027-01-11", "2027-02-08", "2027-03-08", "2027-04-05"]);
  });

  it("C1 carryover does not move the cycle", () => {
    // The 11-16 visit is carried to Wed 11-18; the plan's cycle was already advanced from 11-16.
    const r = simulate({ start: "2026-12-14", weeks: 4, day: "MON", existing: ["2026-11-18"], count: 2 });
    expect(r.visits).toEqual(["2026-12-14", "2027-01-11"]);
  });
  it("C2 a pushed visit serves the due cycle (guard)", () => {
    const r = simulate({ start: "2026-12-14", weeks: 4, day: "MON", existing: ["2026-12-16"], count: 2 });
    expect(r.visits).toEqual(["2027-01-11", "2027-02-08"]);
  });
});
