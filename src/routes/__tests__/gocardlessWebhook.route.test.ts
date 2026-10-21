import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
// @ts-expect-error — gocardless-nodejs ships ESM as main but has a CJS build under require condition
import { InvalidSignatureError } from "gocardless-nodejs";
import { Prisma } from "../../generated/tenant-client";

const tenantFindUnique = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { findUnique: (...args: unknown[]) => tenantFindUnique(...args) } },
}));

const decrypt = vi.fn((v: string) => `decrypted(${v})`);
vi.mock("../../lib/crypto", () => ({
  decrypt: (...args: [string]) => decrypt(...args),
}));

const parse = vi.fn();
vi.mock("gocardless-nodejs", () => ({
  parse: (...args: unknown[]) => parse(...args),
  InvalidSignatureError: class InvalidSignatureError extends Error {},
}));

const queueGhlEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({
  queueGhlEvent: (...args: unknown[]) => queueGhlEvent(...args),
}));

function makeTenantPrisma() {
  return {
    businessSettings: { findFirst: vi.fn() },
    webhookEvent: { create: vi.fn().mockResolvedValue({}) },
    payment: { updateMany: vi.fn().mockResolvedValue({}), findFirst: vi.fn() },
    customer: { updateMany: vi.fn().mockResolvedValue({}) },
  };
}

const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...args: unknown[]) => getTenantPrismaForSchema(...args),
}));

import { gocardlessWebhookRouter } from "../gocardlessWebhook";

function makeApp() {
  const app = express();
  app.use("/webhooks/gocardless", express.raw({ type: "application/json" }), gocardlessWebhookRouter);
  return app;
}

function send(query: string, events: unknown[] = [{ id: "ev_1", resource_type: "payments", action: "paid", links: { payment: "PM1" } }]) {
  return request(makeApp())
    .post(`/webhooks/gocardless${query}`)
    .set("webhook-signature", "sig_test")
    .set("Content-Type", "application/json")
    .send(JSON.stringify(events));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /webhooks/gocardless — routing", () => {
  it("400s when tenantId or secret is missing", async () => {
    const res = await send("");
    expect(res.status).toBe(400);
  });

  it("400s when only secret is present", async () => {
    const res = await send("?secret=abc");
    expect(res.status).toBe(400);
  });

  it("200s when the tenant doesn't exist", async () => {
    tenantFindUnique.mockResolvedValue(null);
    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(200);
  });

  it("200s when the tenant has no route-token secret stored", async () => {
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ gocardlessWebhookSecretEncrypted: null });
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(200);
  });

  it("200s when the real signing secret hasn't been pasted in yet", async () => {
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({
      gocardlessWebhookSecretEncrypted: "route-token",
      gocardlessWebhookSigningSecretEncrypted: null,
    });
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(200);
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/gocardless — signature verification", () => {
  function setup() {
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({
      gocardlessWebhookSecretEncrypted: "route-token",
      gocardlessWebhookSigningSecretEncrypted: "real-signing-secret",
    });
    getTenantPrismaForSchema.mockReturnValue(tp);
    return tp;
  }

  it("401s on an invalid signature", async () => {
    setup();
    parse.mockImplementation(() => {
      // gocardless-nodejs's own .d.ts mistypes this as a plain `(): void`
      // function rather than a class, even though the real implementation
      // (and our mock below) is newable — cast through to construct it.
      throw new (InvalidSignatureError as unknown as new () => Error)();
    });
    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(401);
  });

  it("400s on a malformed body", async () => {
    setup();
    parse.mockImplementation(() => {
      throw new Error("malformed");
    });
    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(400);
  });

  it("verifies with the decrypted real signing secret, not the route token", async () => {
    setup();
    parse.mockReturnValue([]);
    await send("?tenantId=tenant-1&secret=abc");
    expect(decrypt).toHaveBeenCalledWith("real-signing-secret");
    expect(parse).toHaveBeenCalledWith(expect.anything(), "decrypted(real-signing-secret)", "sig_test");
  });

  it("falls back to an empty-string signature when the webhook-signature header is missing", async () => {
    setup();
    parse.mockReturnValue([]);
    await request(makeApp())
      .post("/webhooks/gocardless?tenantId=tenant-1&secret=abc")
      .set("Content-Type", "application/json")
      .send(JSON.stringify([]));
    expect(parse).toHaveBeenCalledWith(expect.anything(), "decrypted(real-signing-secret)", "");
  });
});

describe("POST /webhooks/gocardless — event processing", () => {
  function setup(events: unknown[]) {
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({
      gocardlessWebhookSecretEncrypted: "route-token",
      gocardlessWebhookSigningSecretEncrypted: "real-signing-secret",
    });
    getTenantPrismaForSchema.mockReturnValue(tp);
    parse.mockReturnValue(events);
    return tp;
  }

  it("200s immediately and processes events async", async () => {
    const tp = setup([{ id: "ev_1", resource_type: "payments", action: "paid", links: { payment: "PM1" } }]);
    tp.payment.findFirst.mockResolvedValue({ customerId: "cust-1" });

    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(tp.webhookEvent.create).toHaveBeenCalledWith({
      data: { source: "gocardless", externalId: "ev_1" },
    }));
  });

  it("skips an event with no id", async () => {
    const tp = setup([{ resource_type: "payments", action: "paid" }]);
    await send("?tenantId=tenant-1&secret=abc");
    await new Promise((r) => setTimeout(r, 10));
    expect(tp.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("skips a duplicate event (unique constraint) without processing it", async () => {
    const tp = setup([{ id: "ev_1", resource_type: "payments", action: "paid", links: { payment: "PM1" } }]);
    tp.webhookEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6.19.3" })
    );

    await send("?tenantId=tenant-1&secret=abc");
    await vi.waitFor(() => expect(tp.webhookEvent.create).toHaveBeenCalled());
    expect(tp.payment.updateMany).not.toHaveBeenCalled();
  });

  it("logs and continues when recording an event fails for a non-duplicate reason", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = setup([
      { id: "ev_1", resource_type: "payments", action: "paid", links: { payment: "PM1" } },
      { id: "ev_2", resource_type: "payments", action: "paid", links: { payment: "PM2" } },
    ]);
    tp.webhookEvent.create.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({});
    tp.payment.findFirst.mockResolvedValue(null);

    await send("?tenantId=tenant-1&secret=abc");

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to record webhook event ev_1"),
      expect.any(Error)
    ));
    // the second event in the batch still gets processed
    await vi.waitFor(() => expect(tp.payment.updateMany).toHaveBeenCalledWith({
      where: { gocardlessId: "PM2" },
      data: { status: "PAID", paidAt: expect.any(Date) },
    }));
    consoleSpy.mockRestore();
  });

  it("logs and continues when handling an individual event throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = setup([{ id: "ev_1", resource_type: "payments", action: "paid", links: { payment: "PM1" } }]);
    tp.payment.updateMany.mockRejectedValue(new Error("boom"));

    await send("?tenantId=tenant-1&secret=abc");

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("event ev_1 (payments.paid) failed"),
      expect.any(Error)
    ));
    consoleSpy.mockRestore();
  });

  it("logs when the whole batch processing promise rejects", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({
      gocardlessWebhookSecretEncrypted: "route-token",
      gocardlessWebhookSigningSecretEncrypted: "real-signing-secret",
    });
    getTenantPrismaForSchema.mockReturnValue(tp);
    // A non-array/malformed parse result makes the for..of in processEvents throw synchronously.
    parse.mockReturnValue(null);

    await send("?tenantId=tenant-1&secret=abc");

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("processing failed"),
      expect.anything()
    ));
    consoleSpy.mockRestore();
  });

  describe("payments resource", () => {
    function setupPayments(action: string) {
      return setup([{ id: "ev_1", resource_type: "payments", action, links: { payment: "PM1" } }]);
    }

    it("does nothing when a payments event has no payment link", async () => {
      const tp = setup([{ id: "ev_1", resource_type: "payments", action: "paid", links: {} }]);
      await send("?tenantId=tenant-1&secret=abc");
      await vi.waitFor(() => expect(tp.webhookEvent.create).toHaveBeenCalled());
      expect(tp.payment.updateMany).not.toHaveBeenCalled();
    });

    it("marks PAID and queues a GHL event on 'paid'", async () => {
      const tp = setupPayments("paid");
      tp.payment.findFirst.mockResolvedValue({ customerId: "cust-1" });
      await send("?tenantId=tenant-1&secret=abc");
      await vi.waitFor(() => expect(tp.payment.updateMany).toHaveBeenCalledWith({
        where: { gocardlessId: "PM1" },
        data: { status: "PAID", paidAt: expect.any(Date) },
      }));
      await vi.waitFor(() => expect(queueGhlEvent).toHaveBeenCalledWith(tp, "payment.collected", "cust-1"));
    });

    it("marks PAID on 'confirmed' but skips the GHL queue when no payment row is found", async () => {
      const tp = setupPayments("confirmed");
      tp.payment.findFirst.mockResolvedValue(null);
      await send("?tenantId=tenant-1&secret=abc");
      await vi.waitFor(() => expect(tp.payment.updateMany).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 10));
      expect(queueGhlEvent).not.toHaveBeenCalled();
    });

    it("marks FAILED on 'failed'", async () => {
      const tp = setupPayments("failed");
      await send("?tenantId=tenant-1&secret=abc");
      await vi.waitFor(() => expect(tp.payment.updateMany).toHaveBeenCalledWith({
        where: { gocardlessId: "PM1" },
        data: { status: "FAILED" },
      }));
    });

    it("marks CANCELLED on 'cancelled'", async () => {
      const tp = setupPayments("cancelled");
      await send("?tenantId=tenant-1&secret=abc");
      await vi.waitFor(() => expect(tp.payment.updateMany).toHaveBeenCalledWith({
        where: { gocardlessId: "PM1" },
        data: { status: "CANCELLED" },
      }));
    });

    it("does nothing for an unrecognised action", async () => {
      const tp = setupPayments("something_else");
      await send("?tenantId=tenant-1&secret=abc");
      await vi.waitFor(() => expect(tp.webhookEvent.create).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 10));
      expect(tp.payment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("mandates resource", () => {
    function setupMandate(action: string) {
      return setup([{ id: "ev_1", resource_type: "mandates", action, links: { mandate: "MD1" } }]);
    }

    it("does nothing when a mandates event has no mandate link", async () => {
      const tp = setup([{ id: "ev_1", resource_type: "mandates", action: "active", links: {} }]);
      await send("?tenantId=tenant-1&secret=abc");
      await vi.waitFor(() => expect(tp.webhookEvent.create).toHaveBeenCalled());
      expect(tp.customer.updateMany).not.toHaveBeenCalled();
    });

    it.each(["active", "cancelled", "failed", "expired"])("maps action '%s' to the matching mandate status", async (action) => {
      const tp = setupMandate(action);
      await send("?tenantId=tenant-1&secret=abc");
      await vi.waitFor(() => expect(tp.customer.updateMany).toHaveBeenCalledWith({
        where: { gocardlessMandateId: "MD1" },
        data: { gocardlessMandateStatus: action },
      }));
    });

    it("does nothing for an unrecognised mandate action", async () => {
      const tp = setupMandate("something_else");
      await send("?tenantId=tenant-1&secret=abc");
      await vi.waitFor(() => expect(tp.webhookEvent.create).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 10));
      expect(tp.customer.updateMany).not.toHaveBeenCalled();
    });

    it("does nothing when a mandates event has no action at all", async () => {
      const tp = setup([{ id: "ev_1", resource_type: "mandates", links: { mandate: "MD1" } }]);
      await send("?tenantId=tenant-1&secret=abc");
      await vi.waitFor(() => expect(tp.webhookEvent.create).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 10));
      expect(tp.customer.updateMany).not.toHaveBeenCalled();
    });
  });

  it("does nothing for an unrecognised resource_type", async () => {
    const tp = setup([{ id: "ev_1", resource_type: "refunds", action: "created" }]);
    await send("?tenantId=tenant-1&secret=abc");
    await vi.waitFor(() => expect(tp.webhookEvent.create).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(tp.payment.updateMany).not.toHaveBeenCalled();
    expect(tp.customer.updateMany).not.toHaveBeenCalled();
  });
});
