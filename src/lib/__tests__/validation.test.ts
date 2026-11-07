import { it, expect, describe } from "vitest";
import {
  parseOptionalDateOnly, optTechnicianRole, parseIsoDate, optIsoDate, assertCalendarDate, isValidEmail, optEmail, optTimeZone, optCurrency,
  assertUkBankFormat, optNonNegativeInt, optNonNegativeAmount,
} from "../validation";

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

// ---- optTechnicianRole -------------------------------------------------------

it("optTechnicianRole returns undefined when omitted", () => {
  expect(optTechnicianRole(undefined)).toBeUndefined();
});

it("optTechnicianRole treats null and empty string as clear", () => {
  expect(optTechnicianRole(null)).toBeNull();
  expect(optTechnicianRole("")).toBeNull();
});

it("optTechnicianRole accepts a valid role", () => {
  expect(optTechnicianRole("SENIOR")).toBe("SENIOR");
});

it("optTechnicianRole rejects an unrecognised role", () => {
  expect(() => optTechnicianRole("Team Lead")).toThrowError(/"role" must be one of/);
});

it("optTechnicianRole rejects a non-string value", () => {
  expect(() => optTechnicianRole(42)).toThrowError(/"role" must be one of/);
});

// BUG-007: impossible calendar dates were silently rolled over (2026-02-29 -> 2026-03-01).
it("parseIsoDate accepts real dates and timestamps", () => {
  expect(parseIsoDate("2028-02-29", "d")).toEqual(new Date("2028-02-29T00:00:00.000Z"));
  expect(parseIsoDate("2026-11-06T09:30:00Z", "d").toISOString()).toBe("2026-11-06T09:30:00.000Z");
  expect(parseIsoDate("2026-11-06T23:30:00-05:00", "d").toISOString()).toBe("2026-11-07T04:30:00.000Z");
});

it.each(["2026-02-29", "2026-02-30", "2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2027-02-29T10:00:00Z"])(
  "parseIsoDate rejects the impossible date %s with a 400 (never rolls it over)",
  (v) => {
    expect(() => parseIsoDate(v, "dueDate")).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => optIsoDate(v, "dueDate")).toThrow(expect.objectContaining({ statusCode: 400 }));
  }
);

it("parseIsoDate still rejects garbage, blanks and non-strings", () => {
  for (const v of ["garbage", "", "  ", 5, null, undefined]) expect(() => parseIsoDate(v, "d")).toThrow(expect.objectContaining({ statusCode: 400 }));
});

it("assertCalendarDate returns the UTC-midnight date for YYYY-MM-DD only", () => {
  expect(assertCalendarDate("2028-02-29", "date")).toEqual(new Date("2028-02-29T00:00:00.000Z"));
  for (const v of ["2027-02-29", "2026-4-1", "2026-11-06T00:00:00Z", 5, undefined]) {
    expect(() => assertCalendarDate(v, "date")).toThrow(expect.objectContaining({ statusCode: 400 }));
  }
});

// BUG-003/006/008: validators for values that used to reach Prisma or be stored unchecked.
describe("isValidEmail / optEmail", () => {
  it("accepts ordinary addresses", () => {
    for (const v of ["a@b.co", "first.last+tag@sub.example.co.uk", "o'brien@x.io"]) expect(isValidEmail(v)).toBe(true);
  });
  it.each([
    "nope", "a@", "@b.co", "a@b", "a b@c.co", "a@b.co\r\nBcc: x@y.com", "a@b.co\n", "<b>x</b>@c.co", "a@b..co", "a@-b.co",
    "x".repeat(300) + "@a.co", "a".repeat(65) + "@b.co", "a@b.c",
  ])("rejects %j", (v) => expect(isValidEmail(v)).toBe(false));

  it("optEmail: undefined stays, null/blank clear, a valid address is trimmed, anything else is a field-level 400", () => {
    expect(optEmail(undefined, "email")).toBeUndefined();
    expect(optEmail(null, "email")).toBeNull();
    expect(optEmail("   ", "email")).toBeNull();
    expect(optEmail("  A@B.co ", "email")).toBe("A@B.co");
    for (const v of ["nope", "a@b.co\r\nBcc: x@y.com", 5]) {
      try {
        optEmail(v, "email");
        throw new Error("should have thrown");
      } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.code).toBe("INVALID_EMAIL_ADDRESS");
        expect(e.fields).toEqual([{ path: "email", code: "INVALID_EMAIL_ADDRESS", message: expect.any(String) }]);
      }
    }
  });
});

describe("optTimeZone / optCurrency", () => {
  it("accepts IANA zones and ISO 4217 codes; undefined/null pass through", () => {
    expect(optTimeZone("Europe/London", "timezone")).toBe("Europe/London");
    expect(optTimeZone(undefined, "timezone")).toBeUndefined();
    expect(optTimeZone(null, "timezone")).toBeNull();
    expect(optCurrency("GBP", "currency")).toBe("GBP");
    expect(optCurrency("eur", "currency")).toBe("EUR");
    expect(optCurrency("£", "currency")).toBe("£"); // the stored value has always been a symbol such as "£"
    expect(optCurrency(undefined, "currency")).toBeUndefined();
    expect(optCurrency(null, "currency")).toBeNull();
  });
  it("rejects invented zones and codes with a field error", () => {
    for (const v of ["Mars/Olympus", "", 5, "UTC+1"]) expect(() => optTimeZone(v, "timezone")).toThrow(expect.objectContaining({ statusCode: 400, code: "INVALID_TIMEZONE" }));
    for (const v of ["ZZZZ", "ZZZ", "pounds", "", 5]) expect(() => optCurrency(v, "currency")).toThrow(expect.objectContaining({ statusCode: 400, code: "INVALID_CURRENCY" }));
  });
});

describe("assertUkBankFormat", () => {
  it("accepts 6-digit sort codes (with or without dashes) and 8-digit account numbers", () => {
    expect(() => assertUkBankFormat("12-34-56", "12345678")).not.toThrow();
    expect(() => assertUkBankFormat("123456", "12345678")).not.toThrow();
  });
  it("rejects anything else with field errors", () => {
    for (const [sc, an] of [["12-34", "12345678"], ["abcdef", "12345678"], ["12-34-56", "1234"], ["12-34-56", "1234567x"]]) {
      expect(() => assertUkBankFormat(sc, an)).toThrow(expect.objectContaining({ statusCode: 400, code: "INVALID_BANK_DETAILS" }));
    }
  });
});

describe("optNonNegativeInt / optNonNegativeAmount", () => {
  it("passes undefined and null, accepts valid numbers", () => {
    expect(optNonNegativeInt(undefined, "n")).toBeUndefined();
    expect(optNonNegativeInt(null, "n")).toBeNull();
    expect(optNonNegativeInt(0, "n")).toBe(0);
    expect(optNonNegativeInt(3, "n")).toBe(3);
    expect(optNonNegativeAmount(12.5, "a")).toBe(12.5);
    expect(optNonNegativeAmount(undefined, "a")).toBeUndefined();
    expect(optNonNegativeAmount(null, "a")).toBeNull();
  });
  it("rejects negatives, fractions (ints), strings and non-finite numbers", () => {
    for (const v of [-1, 1.5, "3", Number.NaN, Infinity]) expect(() => optNonNegativeInt(v, "n")).toThrow(expect.objectContaining({ statusCode: 400 }));
    for (const v of [-0.01, "3", Number.NaN, 1e12]) expect(() => optNonNegativeAmount(v, "a")).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
