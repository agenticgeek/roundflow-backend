import { describe, it, expect } from "vitest";
import { assertSchemaName, isValidSchemaName, quoteSchema } from "../schema-name";

const GOOD = "t_0123456789abcdef0123";

describe("schema-name guard (BE-19)", () => {
  it("accepts t_<20 lowercase hex>", () => {
    expect(isValidSchemaName(GOOD)).toBe(true);
    expect(assertSchemaName(GOOD)).toBe(GOOD);
    expect(quoteSchema(GOOD)).toBe(`"${GOOD}"`);
  });

  it.each([
    "public",
    "t_0123456789abcdef012",
    "t_0123456789abcdef01234",
    "T_0123456789abcdef0123",
    "t_0123456789ABCDEF0123",
    `${GOOD}"; DROP SCHEMA public; --`,
    `${GOOD}\n`,
    "",
    undefined,
    null,
    42,
  ])("rejects %j", (bad) => {
    expect(isValidSchemaName(bad)).toBe(false);
    expect(() => assertSchemaName(bad)).toThrow("Invalid tenant schema name");
    expect(() => quoteSchema(bad)).toThrow("Invalid tenant schema name");
  });
});
