import { describe, expect, it } from "vitest";
import { clip, humanize, minutesBetween, pct, sortedUnique } from "../e2-helpers";

describe("e2 helpers", () => {
  it("pct", () => {
    expect(pct(1, 3)).toBe(33.33);
    expect(pct(1, 0)).toBeNull();
  });
  it("humanize", () => {
    expect(humanize("ACCESS_PROBLEM")).toBe("Access problem");
  });
  it("sortedUnique", () => {
    expect(sortedUnique(["b", "a", "b"])).toEqual(["a", "b"]);
  });
  it("minutesBetween", () => {
    const a = new Date("2026-11-01T10:00:00Z");
    expect(minutesBetween(a, new Date("2026-11-01T10:30:00Z"))).toBe(30);
    expect(minutesBetween(a, new Date("2026-11-01T09:00:00Z"))).toBeNull();
    expect(minutesBetween(null, a)).toBeNull();
    expect(minutesBetween(a, undefined)).toBeNull();
  });
  it("clip", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
  });
});
