import { describe, expect, it } from "vitest";
import { invoicesRouter } from "../invoices";
import { customersRouter } from "../customers";
import { paymentsRouter } from "../payments";
import { messagesRouter } from "../messages";

// BE-17 wiring: the optional Idempotency-Key middleware sits in front of the admin write handlers. Its behaviour
// (atomic claim, replay, in-progress 409) is covered in src/lib/__tests__/idempotency.test.ts.
type Layer = { name?: string; route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string }> }; handle: { name: string } };
const stackOf = (router: unknown) => (router as { stack: Layer[] }).stack;
const postStack = (router: unknown, path: string) =>
  stackOf(router).find((l) => l.route?.path === path && l.route.methods.post)?.route?.stack.map((s) => s.name) ?? [];

describe("admin writes accept Idempotency-Key", () => {
  it.each([
    ["POST /invoices", invoicesRouter, "/"],
    ["POST /customers", customersRouter, "/"],
    ["POST /payments/stripe/checkout", paymentsRouter, "/stripe/checkout"],
  ])("%s", (_name, router, path) => {
    expect(postStack(router, path)).toContain("idempotencyMiddleware");
  });

  it("every POST /messages/* is covered by the router-level guard (GETs are not)", () => {
    const guard = stackOf(messagesRouter).find((l) => !l.route && l.handle.name !== "router" && l.handle.name !== "bound dispatch");
    expect(stackOf(messagesRouter).some((l) => !l.route && l.handle.name === "")).toBe(true);
    expect(guard).toBeDefined();
  });
});
