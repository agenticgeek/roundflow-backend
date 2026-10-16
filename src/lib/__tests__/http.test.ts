import { it, expect } from "vitest";
import { parsePageParams } from "../http";

it("parsePageParams defaults to page 1 and the given defaultPageSize when omitted", () => {
  expect(parsePageParams({})).toEqual({ page: 1, pageSize: 50, skip: 0 });
  expect(parsePageParams({}, { defaultPageSize: 20 })).toEqual({ page: 1, pageSize: 20, skip: 0 });
});

it("parsePageParams parses valid integer strings and computes skip", () => {
  expect(parsePageParams({ page: "3", pageSize: "10" })).toEqual({ page: 3, pageSize: 10, skip: 20 });
});

it("parsePageParams clamps pageSize to maxPageSize", () => {
  expect(parsePageParams({ pageSize: "500" }, { maxPageSize: 100 })).toEqual({
    page: 1,
    pageSize: 100,
    skip: 0,
  });
});

// Regression tests: the previous inline `Number(...) && Number.isFinite(...)
// && ... > 0` checks (routes/customers.ts, routes/debt.ts) accepted a
// fractional value like "1.5", which then reached Prisma's skip/take as a
// non-integer and threw an unhandled PrismaClientValidationError (500)
// instead of a clean 400.
it("parsePageParams rejects a fractional page value", () => {
  expect(() => parsePageParams({ page: "1.5" })).toThrowError(/must be a positive integer/);
});

it("parsePageParams rejects a fractional pageSize value", () => {
  expect(() => parsePageParams({ pageSize: "10.5" })).toThrowError(/must be a positive integer/);
});

it("parsePageParams rejects zero, negative, non-numeric, and empty-string values", () => {
  expect(() => parsePageParams({ page: "0" })).toThrowError(/must be a positive integer/);
  expect(() => parsePageParams({ page: "-1" })).toThrowError(/must be a positive integer/);
  expect(() => parsePageParams({ page: "abc" })).toThrowError(/must be a positive integer/);
  expect(() => parsePageParams({ page: "" })).toThrowError(/must be a positive integer/);
});

it("parsePageParams rejects a non-string query value (e.g. an array from a repeated query param)", () => {
  expect(() => parsePageParams({ page: ["1", "2"] })).toThrowError(/must be a positive integer/);
});
