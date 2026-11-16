import { describe, it, expect, vi, beforeEach } from "vitest";
import { closureMarker, closureWarnings, loadActiveClosures } from "../closure-warnings";
import type { ClosureWindow } from "../../lib/closures";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const win = (id: string, start: string, end: string, roundIds: string[] = [], label = id): ClosureWindow => ({
  id, label, startDate: d(start), endDate: d(end), mode: "MOVE", roundIds,
});
const XMAS = win("xmas", "2026-12-24", "2027-01-03", [], "Christmas");

describe("loadActiveClosures", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("runs one findMany filtered on endDate >= today and keeps only active windows", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "a", label: "A", startDate: d("2026-12-24"), endDate: d("2027-01-03"), mode: "MOVE", roundIds: [] },
      { id: "old", label: "Old", startDate: d("2026-10-01"), endDate: d("2026-10-05"), mode: "SKIP", roundIds: ["r1"] },
    ]);
    const res = await loadActiveClosures({ businessClosure: { findMany } } as never, d("2026-11-16"));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ endDate: { gte: d("2026-11-16") } });
    expect(res.map((c) => c.id)).toEqual(["a"]);
  });

  it("returns no closures (and never throws) when the lookup fails", async () => {
    const res = await loadActiveClosures({ businessClosure: { findMany: vi.fn().mockRejectedValue(new Error("db")) } } as never, d("2026-11-16"));
    expect(res).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("closureWarnings", () => {
  it("is undefined when nothing covers the date", () => {
    expect(closureWarnings(d("2027-01-05"), ["r1"], [XMAS])).toBeUndefined();
    expect(closureWarnings(d("2026-12-30"), ["r1"], [])).toBeUndefined();
  });

  it("returns the DATE_IN_CLOSURE shape with ISO dates; both ends inclusive", () => {
    const expected = [{ code: "DATE_IN_CLOSURE", closureId: "xmas", label: "Christmas", startDate: "2026-12-24", endDate: "2027-01-03" }];
    expect(closureWarnings(d("2026-12-30"), ["r1"], [XMAS])).toEqual(expected);
    expect(closureWarnings(d("2026-12-24"), ["r1"], [XMAS])).toEqual(expected);
    expect(closureWarnings(d("2027-01-03"), ["r1"], [XMAS])).toEqual(expected);
    expect(closureWarnings(d("2026-12-23"), ["r1"], [XMAS])).toBeUndefined();
  });

  it("W4: a round-scoped closure warns only its own rounds; a visit without a round only meets all-rounds closures", () => {
    const scoped = win("scoped", "2026-12-24", "2027-01-03", ["r1"]);
    expect(closureWarnings(d("2026-12-30"), ["r2"], [scoped])).toBeUndefined();
    expect(closureWarnings(d("2026-12-30"), ["r1"], [scoped])?.map((w) => w.closureId)).toEqual(["scoped"]);
    expect(closureWarnings(d("2026-12-30"), [null], [scoped])).toBeUndefined();
    expect(closureWarnings(d("2026-12-30"), [null], [XMAS])?.map((w) => w.closureId)).toEqual(["xmas"]);
  });

  it("de-duplicates by closure id across rounds and sorts by startDate (then id)", () => {
    const late = win("late", "2026-12-28", "2027-01-10");
    const tieB = win("b", "2026-12-28", "2027-01-02");
    const res = closureWarnings(d("2026-12-30"), ["r1", "r2", "r1", null], [late, XMAS, tieB]);
    expect(res?.map((w) => w.closureId)).toEqual(["xmas", "b", "late"]);
  });
});

describe("closureMarker", () => {
  it("flags the first covering closure by startDate, ignoring round scope; undefined when none", () => {
    const scoped = win("scoped", "2026-12-20", "2027-01-03", ["r9"], "Scoped");
    expect(closureMarker(d("2026-12-30"), [XMAS, scoped])).toEqual({ closureId: "scoped", label: "Scoped" });
    expect(closureMarker(d("2026-12-19"), [XMAS, scoped])).toBeUndefined();
    expect(closureMarker(d("2027-01-04"), [XMAS])).toBeUndefined();
    expect(closureMarker(d("2026-12-30"), [])).toBeUndefined();
  });
});
