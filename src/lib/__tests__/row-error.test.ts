import { it, expect } from "vitest";
import { rowError } from "../row-error";

it("carries the text as both error (contract) and message (legacy)", () => {
  expect(rowError(2, "phone", "phone is required")).toEqual({
    row: 2,
    field: "phone",
    error: "phone is required",
    message: "phone is required",
  });
});
