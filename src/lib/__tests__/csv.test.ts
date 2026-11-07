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

it("BE-14: neutralises spreadsheet formula injection in string cells", () => {
  const out = toCsv([
    { a: "=SUM(A1)", b: "+1", c: "-2+3", d: "@cmd", e: "\tTab", f: "\rCR", g: "safe=ok" },
  ]);
  expect(out).toBe("a,b,c,d,e,f,g\n'=SUM(A1),'+1,'-2+3,'@cmd,'\tTab,\"'\rCR\",safe=ok");
});

it("BE-14: leaves real numbers (including negatives) alone, only escapes strings", () => {
  expect(toCsv([{ n: -5, z: 0, s: "-5" }])).toBe("n,z,s\n-5,0,'-5");
});
