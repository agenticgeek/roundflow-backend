import { describe, expect, it } from "vitest";
import {
  addDays, checkRange, columns, dateToDay, dayToDate, daysBetween, instantRange, localDayBounds, localDayOf, optDate, optEnum, optId, optInt,
  optNumber, optString, parseArgs, parseLimit, rangeLabel, reqString, resolveRange, round2, tenantClock, toDateRange, ToolInputError, visitDateWhere,
} from "../shared";
import { ctxFor, fakePrisma } from "./fake-prisma";

const bad = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolInputError);
    return (e as Error).message;
  }
  throw new Error("expected ToolInputError");
};

describe("argument parsing", () => {
  it("accepts an object, undefined and null; rejects other shapes and unknown keys", () => {
    expect(parseArgs(undefined, ["a"])).toEqual({});
    expect(parseArgs(null, ["a"])).toEqual({});
    expect(parseArgs({ a: 1 }, ["a"])).toEqual({ a: 1 });
    expect(bad(() => parseArgs("x", ["a"]))).toMatch(/JSON object/);
    expect(bad(() => parseArgs([1], ["a"]))).toMatch(/JSON object/);
    expect(bad(() => parseArgs({ b: 1, c: 2 }, ["a"]))).toBe("Unknown argument(s): b, c. Allowed: a");
    expect(bad(() => parseArgs({ b: 1 }, []))).toMatch(/Allowed: none/);
  });

  it("validates real calendar dates", () => {
    expect(optDate({ d: "2026-02-28" }, "d")).toBe("2026-02-28");
    expect(optDate({}, "d")).toBeUndefined();
    expect(optDate({ d: null }, "d")).toBeUndefined();
    expect(bad(() => optDate({ d: "2026-02-30" }, "d"))).toMatch(/valid calendar date/);
    expect(bad(() => optDate({ d: "13/02/2026" }, "d"))).toMatch(/YYYY-MM-DD/);
    expect(bad(() => optDate({ d: 5 }, "d"))).toMatch(/YYYY-MM-DD/);
  });

  it("validates enums, ints, numbers, strings and ids", () => {
    expect(optEnum({ e: "A" }, "e", ["A", "B"] as const)).toBe("A");
    expect(optEnum({}, "e", ["A"] as const)).toBeUndefined();
    expect(optEnum({ e: null }, "e", ["A"] as const)).toBeUndefined();
    expect(bad(() => optEnum({ e: "Z" }, "e", ["A", "B"] as const))).toBe('"e" must be one of: A, B');
    expect(bad(() => optEnum({ e: 1 }, "e", ["A"] as const))).toMatch(/must be one of/);

    expect(optInt({ n: 5 }, "n", 1, 10)).toBe(5);
    expect(optInt({}, "n", 1, 10)).toBeUndefined();
    expect(optInt({ n: null }, "n", 1, 10)).toBeUndefined();
    for (const v of [0, 11, 1.5, "5"]) expect(bad(() => optInt({ n: v }, "n", 1, 10))).toMatch(/whole number from 1 to 10/);

    expect(optNumber({ n: 2.5 }, "n", 0, 10)).toBe(2.5);
    expect(optNumber({}, "n", 0, 10)).toBeUndefined();
    expect(optNumber({ n: null }, "n", 0, 10)).toBeUndefined();
    for (const v of [-1, 11, Infinity, NaN, "1"]) expect(bad(() => optNumber({ n: v }, "n", 0, 10))).toMatch(/number from 0 to 10/);

    expect(optString({ s: "  hi " }, "s", 5)).toBe("hi");
    expect(optString({ s: "   " }, "s", 5)).toBeUndefined();
    expect(optString({}, "s", 5)).toBeUndefined();
    expect(optString({ s: null }, "s", 5)).toBeUndefined();
    expect(bad(() => optString({ s: "toolong" }, "s", 5))).toMatch(/at most 5 characters/);
    expect(bad(() => optString({ s: 3 }, "s", 5))).toMatch(/must be text/);
    expect(reqString({ s: "x" }, "s", 5)).toBe("x");
    expect(bad(() => reqString({}, "s", 5))).toMatch(/is required/);

    expect(optId({ i: "abc_12-3" }, "i")).toBe("abc_12-3");
    expect(optId({}, "i")).toBeUndefined();
    expect(bad(() => optId({ i: "a b" }, "i"))).toMatch(/not a valid id/);
    expect(bad(() => optId({ i: "x".repeat(65) }, "i"))).toMatch(/at most 64/);
  });

  it("limits default to 50 and cap at 200", () => {
    expect(parseLimit({})).toBe(50);
    expect(parseLimit({ limit: 200 })).toBe(200);
    expect(bad(() => parseLimit({ limit: 201 }))).toMatch(/1 to 200/);
  });
});

describe("dates", () => {
  it("does day arithmetic in whole calendar days", () => {
    expect(dayToDate("2026-03-29").toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(dateToDay(new Date("2026-03-29T00:00:00Z"))).toBe("2026-03-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });

  it("builds range labels", () => {
    expect(rangeLabel("2026-10-01", "2026-10-30")).toBe("1 to 30 Oct 2026");
    expect(rangeLabel("2026-10-28", "2026-11-03")).toBe("28 Oct to 3 Nov 2026");
    expect(rangeLabel("2026-12-30", "2027-01-02")).toBe("30 Dec 2026 to 2 Jan 2027");
    expect(rangeLabel("2026-10-05", "2026-10-05")).toBe("5 Oct 2026");
    expect(toDateRange("2026-10-01", "2026-10-30")).toEqual({ from: "2026-10-01", to: "2026-10-30", label: "1 to 30 Oct 2026" });
  });

  it("checks ranges: order and 366-day cap (inclusive)", () => {
    expect(checkRange("2026-01-01", "2026-01-01")).toEqual({ from: "2026-01-01", to: "2026-01-01" });
    expect(checkRange("2025-11-10", "2026-11-10")).toEqual({ from: "2025-11-10", to: "2026-11-10" }); // 366 days
    expect(bad(() => checkRange("2025-11-09", "2026-11-10"))).toMatch(/at most 366 days/);
    expect(bad(() => checkRange("2026-02-02", "2026-02-01"))).toMatch(/must not be after/);
  });

  it("resolves defaults from the tenant clock (month start .. today)", () => {
    const clock = { tz: "Europe/London", today: "2026-11-10", now: new Date() };
    expect(resolveRange({}, clock)).toEqual({ from: "2026-11-01", to: "2026-11-10" });
    expect(resolveRange({ from: "2026-10-01", to: "2026-10-31" }, clock)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("uses tenant-local today: 00:30 BST on the 11th is already the 11th, 22:59Z on the 10th is not", async () => {
    const { tp } = fakePrisma();
    expect((await tenantClock(ctxFor(tp, "2026-07-14T23:30:00Z"))).today).toBe("2026-07-15");
    expect((await tenantClock(ctxFor(tp, "2026-07-14T22:59:00Z"))).today).toBe("2026-07-14");
    const ny = fakePrisma({}, { timezone: "America/New_York" });
    expect((await tenantClock(ctxFor(ny.tp, "2026-11-10T03:00:00Z"))).today).toBe("2026-11-09");
    expect((await tenantClock({ scope: "ADMIN", tenantPrisma: tp, profileId: "p" })).today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("maps local days to instants, including DST and far-east zones", () => {
    expect(visitDateWhere("2026-10-01", "2026-10-31")).toEqual({ gte: new Date("2026-10-01T00:00:00Z"), lt: new Date("2026-11-01T00:00:00Z") });
    expect(localDayBounds("Europe/London", "2026-10-25")).toEqual({ start: new Date("2026-10-24T23:00:00Z"), end: new Date("2026-10-26T00:00:00Z") });
    expect(localDayBounds("Europe/London", "2026-03-29")).toEqual({ start: new Date("2026-03-29T00:00:00Z"), end: new Date("2026-03-29T23:00:00Z") });
    expect(localDayBounds("Pacific/Kiritimati", "2026-11-10")).toEqual({ start: new Date("2026-11-09T10:00:00Z"), end: new Date("2026-11-10T10:00:00Z") });
    expect(instantRange("Europe/London", "2026-10-24", "2026-10-25")).toEqual({ gte: new Date("2026-10-23T23:00:00Z"), lt: new Date("2026-10-26T00:00:00Z") });
    expect(localDayOf(new Date("2026-07-14T23:30:00Z"), "Europe/London")).toBe("2026-07-15");
  });
});

describe("misc", () => {
  it("rounds to 2 dp (money is decimal pounds)", () => {
    expect(round2(1.005 * 100)).toBe(100.5);
    expect(round2(12.345)).toBe(12.35);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it("builds columns with alignment from the format", () => {
    expect(columns(["a", "A", "text"], ["b", "B", "date"], ["c", "C", "currency"], ["d", "D", "integer"], ["e", "E", "percent"]).map((c) => c.align)).toEqual([
      "left", "left", "right", "right", "right",
    ]);
  });
});
