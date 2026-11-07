import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: (...a: unknown[]) => tenantFindMany(...a) } } }));
const tpA = { name: "A" };
const tpB = { name: "B" };
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (s: string) => (s === "t_aaaaaaaaaaaaaaaaaaaa" ? tpA : tpB),
  withTenantClient: (s: string, fn: (c: unknown) => Promise<unknown>) => Promise.resolve().then(() => fn(s === "t_aaaaaaaaaaaaaaaaaaaa" ? tpA : tpB)),
}));
const sweep = vi.fn();
vi.mock("../../services/webhook-events.service", () => ({ sweepWebhookEvents: (...a: unknown[]) => sweep(...a) }));
const handleStripeEvent = vi.fn();
const handleGocardlessEvent = vi.fn();
const handleGhlEvent = vi.fn();
const handleSesPayload = vi.fn();
vi.mock("../../routes/stripeWebhook", () => ({ handleStripeEvent: (...a: unknown[]) => handleStripeEvent(...a) }));
vi.mock("../../routes/gocardlessWebhook", () => ({ handleGocardlessEvent: (...a: unknown[]) => handleGocardlessEvent(...a) }));
vi.mock("../../routes/sesWebhook", () => ({ handleSesPayload: (...a: unknown[]) => handleSesPayload(...a) }));
vi.mock("../../routes/ghlWebhook", () => ({ handleGhlEvent: (...a: unknown[]) => handleGhlEvent(...a) }));

import { runWebhookRetry } from "../webhookRetry";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  tenantFindMany.mockResolvedValue([
    { id: "ta", schemaName: "t_aaaaaaaaaaaaaaaaaaaa" },
    { id: "tb", schemaName: "t_bbbbbbbbbbbbbbbbbbbb" },
  ]);
});

describe("runWebhookRetry (BE-03)", () => {
  it("sweeps every tenant with handlers bound to that tenant and logs only when something was retried", async () => {
    sweep.mockResolvedValueOnce({ retried: 2, done: 1, failed: 1, skipped: 0 }).mockResolvedValueOnce({ retried: 0, done: 0, failed: 0, skipped: 0 });
    await runWebhookRetry();

    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sweep.mock.calls[0][0]).toBe(tpA);
    expect(sweep.mock.calls[1][0]).toBe(tpB);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("t_aaaaaaaaaaaaaaaaaaaa: retried 2"));

    const handlers = sweep.mock.calls[0][1];
    await handlers.stripe({ id: "evt" });
    await handlers.gocardless({ id: "ev" });
    await handlers.ghl({ id: "g" });
    await handlers.ses({ id: "s" });
    expect(handleStripeEvent).toHaveBeenCalledWith(tpA, "ta", { id: "evt" });
    expect(handleGocardlessEvent).toHaveBeenCalledWith(tpA, { id: "ev" });
    expect(handleGhlEvent).toHaveBeenCalledWith("t_aaaaaaaaaaaaaaaaaaaa", { id: "g" });
    expect(handleSesPayload).toHaveBeenCalledWith(tpA, { id: "s" });
  });

  it("BUG-010: sweeps 300 tenants with bounded concurrency (never one client per tenant at once)", async () => {
    tenantFindMany.mockResolvedValue(Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, schemaName: `t_${i}` })));
    let active = 0;
    let peak = 0;
    sweep.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      active--;
      return { retried: 0, done: 0, failed: 0, skipped: 0 };
    });
    await runWebhookRetry();
    expect(sweep).toHaveBeenCalledTimes(300);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("one failing tenant does not stop the others and is logged", async () => {
    sweep.mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce({ retried: 0, done: 0, failed: 0, skipped: 0 });
    await runWebhookRetry();
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith("[webhookRetry] tenant sweep failed:", expect.any(Error));
  });
});
