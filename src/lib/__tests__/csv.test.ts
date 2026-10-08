import { it, expect } from "vitest";
import { toCsv } from "../csv";

it("toCsv takes headers from first row, escapes comma/quote/newline, blanks null", () => {
  const out = toCsv([
    { a: 1, b: "plain", c: null },
    { a: 2, b: 'has "quote", comma\nnewline', c: "x" },
  ]);
  expect(out).toBe(
    "a,b,c\n" +
    "1,plain,\n" +
    '2,"has ""quote"", comma\nnewline",x'
  );
});

it("toCsv renders Date as ISO and returns empty string for no rows", () => {
  expect(toCsv([])).toBe("");
  expect(toCsv([{ d: new Date("2026-01-02T03:04:05.000Z") }])).toBe("d\n2026-01-02T03:04:05.000Z");
});
