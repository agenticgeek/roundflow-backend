import { it, expect } from "vitest";
import { parseOptionalDateOnly } from "../validation";

it("parseOptionalDateOnly returns undefined when the value is omitted", () => {
  expect(parseOptionalDateOnly(undefined, "from")).toBeUndefined();
});

it("parseOptionalDateOnly parses a well-formed date to UTC midnight", () => {
  const d = parseOptionalDateOnly("2026-03-15", "from");
  expect(d).toEqual(new Date(Date.UTC(2026, 2, 15)));
});

it("parseOptionalDateOnly rejects a non-string value", () => {
  expect(() => parseOptionalDateOnly(123, "from")).toThrowError(/must be a YYYY-MM-DD date/);
});

it("parseOptionalDateOnly rejects a malformed string", () => {
  expect(() => parseOptionalDateOnly("15-03-2026", "from")).toThrowError(/must be a YYYY-MM-DD date/);
  expect(() => parseOptionalDateOnly("2026-3-15", "from")).toThrowError(/must be a YYYY-MM-DD date/);
});

// Regression tests: the previous regex-only check (`/^\d{4}-\d{2}-\d{2}$/`)
// accepted these and either silently rolled the date over to a different
// month/day (new Date() normalizes out-of-range components) or produced an
// Invalid Date that NaN-compared as false against downstream range guards.
it("parseOptionalDateOnly rejects day-of-month 30 in February (not a leap rollover)", () => {
  expect(() => parseOptionalDateOnly("2026-02-30", "from")).toThrowError(/valid calendar date/);
});

it("parseOptionalDateOnly rejects day-of-month 00", () => {
  expect(() => parseOptionalDateOnly("2026-01-00", "from")).toThrowError(/valid calendar date/);
});

it("parseOptionalDateOnly rejects month 00 and month 13", () => {
  expect(() => parseOptionalDateOnly("2026-00-15", "from")).toThrowError(/valid calendar date/);
  expect(() => parseOptionalDateOnly("2026-13-15", "from")).toThrowError(/valid calendar date/);
});

it("parseOptionalDateOnly accepts Feb 29 on a real leap year but rejects it otherwise", () => {
  expect(parseOptionalDateOnly("2028-02-29", "from")).toEqual(new Date(Date.UTC(2028, 1, 29)));
  expect(() => parseOptionalDateOnly("2026-02-29", "from")).toThrowError(/valid calendar date/);
});

it("parseOptionalDateOnly accepts day-of-month 31 only in a 31-day month", () => {
  expect(parseOptionalDateOnly("2026-01-31", "from")).toEqual(new Date(Date.UTC(2026, 0, 31)));
  expect(() => parseOptionalDateOnly("2026-04-31", "from")).toThrowError(/valid calendar date/);
});
