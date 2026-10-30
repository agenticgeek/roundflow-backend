import { it, expect } from "vitest";
import { normaliseMobile, normaliseEmail, CustomerIndex } from "../customer-match";

it("normaliseMobile folds +44 / 0044 / 44 onto the national 0 and strips formatting", () => {
  expect(normaliseMobile("07700 900201")).toBe("07700900201");
  expect(normaliseMobile("+44 7700 900201")).toBe("07700900201");
  expect(normaliseMobile("0044 (7700) 900-201")).toBe("07700900201");
  expect(normaliseMobile("447700900201")).toBe("07700900201");
  expect(normaliseMobile("123")).toBeNull();
  expect(normaliseMobile(null)).toBeNull();
  expect(normaliseMobile(undefined)).toBeNull();
});

it("normaliseEmail trims and lower-cases; blank is null", () => {
  expect(normaliseEmail("  Sam@Example.COM ")).toBe("sam@example.com");
  expect(normaliseEmail("  ")).toBeNull();
  expect(normaliseEmail(null)).toBeNull();
});

it("CustomerIndex matches by mobile, then by case-insensitive email", () => {
  const idx = new CustomerIndex([
    { id: "c1", phone: "07700 900201", email: null },
    { id: "c2", phone: null, email: "Jo@Example.com" },
    { id: "c3", phone: "07700900201", email: "jo@example.com" }, // duplicate keys: first wins
  ]);
  expect(idx.find({ phone: "+447700900201" })).toBe("c1");
  expect(idx.find({ email: "jo@example.COM" })).toBe("c2");
  expect(idx.find({ phone: "07000000000", email: "jo@example.com" })).toBe("c2");
  expect(idx.find({ phone: "07000000000", email: "x@y.z" })).toBeNull();
  expect(idx.find({})).toBeNull();
  expect(new CustomerIndex().find({ phone: "07700900201" })).toBeNull();
});

it("merge adds the other index's keys without replacing existing ones", () => {
  const a = new CustomerIndex([{ id: "a", phone: "07700900201", email: "a@x.com" }]);
  const b = new CustomerIndex();
  b.add("b", { phone: "07700900201", email: "b@x.com" });
  b.add("c", { phone: "07000000009", email: "a@x.com" });
  a.merge(b);
  expect(a.find({ phone: "07700900201" })).toBe("a");
  expect(a.find({ email: "b@x.com" })).toBe("b");
  expect(a.find({ email: "a@x.com" })).toBe("a");
  expect(a.find({ phone: "07000000009" })).toBe("c");
});
