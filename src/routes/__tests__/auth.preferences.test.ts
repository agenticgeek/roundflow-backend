import { it, expect } from "vitest";
import { mergePreferences } from "../auth";

it("merges, overwrites keys, and treats null/non-object existing as empty", () => {
  expect(mergePreferences(null, { a: 1 })).toEqual({ a: 1 });
  expect(mergePreferences({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  expect(mergePreferences("garbage", { a: 1 })).toEqual({ a: 1 });
  expect(mergePreferences(["arr"], { a: 1 })).toEqual({ a: 1 });
});

it("rejects oversized payloads (>100KB)", () => {
  expect(() => mergePreferences({}, { blob: "x".repeat(200_000) })).toThrow(/too large/);
});
