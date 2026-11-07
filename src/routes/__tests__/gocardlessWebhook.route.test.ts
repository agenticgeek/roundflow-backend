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

// Identity decrypt — lets fixtures set the "encrypted" field directly to the
// plaintext value a test wants to assert against (e.g. the route token
// equal to the query ?secret=, or the signing secret passed to parse()).
const decrypt = vi.fn((v: string) => v);
vi.mock("../../lib/crypto", () => ({
  decrypt: (...args: [string]) => decrypt(...args),
  safeEqual: (a: string, b: string) => a === b,
}));

const parse = vi.fn();
vi.mock("gocardless-nodejs", () => ({
  parse: (...args: unknown[]) => parse(...args),
  InvalidSignatureError: class InvalidSignatureError extends Error {},
}));

const transition = vi.fn().mockResolvedValue({ changed: true });
vi.mock("../../services/payment.service", () => ({
  createPaymentService: () => ({ transition: (...args: unknown[]) => transition(...args) }),
}));

function makeTenantPrisma() {
  return {
    businessSettings: { findFirst: vi.fn() },
    webhookEvent: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    payment: {
      updateMany: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    invoice: { updateMany: vi.fn().mockResolvedValue({}) },
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

  it("200s (without verifying signatures) when the ?secret= query param doesn't match the stored route token", async () => {
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({
      gocardlessWebhookSecretEncrypted: "the-real-route-token",
      gocardlessWebhookSigningSecretEncrypted: "real-signing-secret",
    });
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send("?tenantId=tenant-1&secret=wrong-guess");

    expect(res.status).toBe(200);
    expect(parse).not.toHaveBeenCalled();
  });

  it("200s when the real signing secret hasn't been pasted in yet", async () => {
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({
      gocardlessWebhookSecretEncrypted: "abc",
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
      gocardlessWebhookSecretEncrypted: "abc",
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
    expect(parse).toHaveBeenCalledWith(expect.anything(), "real-signing-secret", "sig_test");
  });

  it("falls back to an empty-string signature when the webhook-signature header is missing", async () => {
    setup();
    parse.mockReturnValue([]);
    await request(makeApp())
      .post("/webhooks/gocardless?tenantId=tenant-1&secret=abc")
      .set("Content-Type", "application/json")
      .send(JSON.stringify([]));
    expect(parse).toHaveBeenCalledWith(expect.anything(), "real-signing-secret", "");
  });
});

describe("POST /webhooks/gocardless — event processing", () => {
  function setup(events: unknown[]) {
    tenantFindUnique.mockResolvedValue({ id: "tenant-1", schemaName: "tenant_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({
      gocardlessWebhookSecretEncrypted: "abc",
      gocardlessWebhookSigningSecretEncrypted: "real-signing-secret",
    });
    getTenantPrismaForSchema.mockReturnValue(tp);
    parse.mockReturnValue(events);
    return tp;
  }
  const pay = (action: string, extra: Record<string, unknown> = {}) => ({
    id: "ev_1",
    resource_type: "payments",
    action,
    links: { payment: "PM1" },
    ...extra,
  });
  const dup = () => new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });

  it("BE-03: records each event RECEIVED with its payload, processes it, marks DONE and answers 200", async () => {
    const tp = setup([pay("paid_out")]);
    tp.payment.findUnique.mockResolvedValue({ id: "pay-1" });

    const res = await send("?tenantId=tenant-1&secret=abc");

    expect(res.status).toBe(200);
    expect(tp.webhookEvent.create).toHaveBeenCalledWith({
      data: { source: "gocardless", externalId: "ev_1", status: "RECEIVED", payload: pay("paid_out") },
    });
    expect(transition).toHaveBeenCalledWith("pay-1", "PAID", { note: undefined });
    expect(tp.webhookEvent.updateMany).toHaveBeenLastCalledWith({
      where: { source: "gocardless", externalId: "ev_1" },
      data: expect.objectContaining({ status: "DONE" }),
    });
  });

  it("skips an event with no id", async () => {
    const tp = setup([{ resource_type: "payments", action: "paid_out" }]);
    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(200);
    expect(tp.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("skips a duplicate whose row is DONE without processing it", async () => {
    const tp = setup([pay("paid_out")]);
    tp.webhookEvent.create.mockRejectedValue(dup());
    tp.webhookEvent.findUnique.mockResolvedValue({ status: "DONE" });
    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(200);
    expect(transition).not.toHaveBeenCalled();
  });

  it("BE-03: a failing effect answers 500 (provider redelivers), leaves the event FAILED, and the redelivery reconciles it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = setup([pay("paid_out")]);
    tp.payment.findUnique.mockResolvedValue({ id: "pay-1" });
    transition.mockRejectedValueOnce(new Error("db blip"));

    const first = await send("?tenantId=tenant-1&secret=abc");
    expect(first.status).toBe(500);
    expect(tp.webhookEvent.updateMany).toHaveBeenLastCalledWith({
      where: { source: "gocardless", externalId: "ev_1" },
      data: expect.objectContaining({ status: "FAILED", attempts: { increment: 1 } }),
    });

    tp.webhookEvent.create.mockRejectedValue(dup());
    tp.webhookEvent.findUnique.mockImplementation(async (args: { where: { source_externalId?: unknown } }) =>
      args.where.source_externalId ? { status: "FAILED" } : { id: "pay-1" }
    );
    const second = await send("?tenantId=tenant-1&secret=abc");
    expect(second.status).toBe(200);
    expect(transition).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it("one failing event in a batch still processes the others, then answers 500", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = setup([pay("paid_out", { id: "ev_a" }), pay("failed", { id: "ev_b", links: { payment: "PM2" } })]);
    tp.payment.findUnique.mockResolvedValue({ id: "pay-x" });
    transition.mockRejectedValueOnce(new Error("first fails"));
    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(500);
    expect(transition).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it("500s when recording the event fails for a non-duplicate reason (nothing was recorded, the provider retries)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = setup([pay("paid_out")]);
    tp.webhookEvent.create.mockRejectedValue(new Error("connection reset"));
    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(500);
    expect(transition).not.toHaveBeenCalled();
    err.mockRestore();
  });

  describe("payments resource", () => {
    it.each([
      ["confirmed", "PROCESSING", undefined],
      ["paid_out", "PAID", undefined],
      ["failed", "FAILED", undefined],
      ["cancelled", "CANCELLED", undefined],
      ["charged_back", "DISPUTED", "GoCardless chargeback"],
      ["chargeback_cancelled", "PAID", "GoCardless chargeback reversed"],
      ["refunded", "REFUNDED", "GoCardless refund"],
    ])("action '%s' moves the payment to %s through the state machine", async (action, target, note) => {
      const tp = setup([pay(action)]);
      tp.payment.findUnique.mockResolvedValue({ id: "pay-1" });
      const res = await send("?tenantId=tenant-1&secret=abc");
      expect(res.status).toBe(200);
      expect(tp.payment.findUnique).toHaveBeenCalledWith({ where: { gocardlessId: "PM1" } });
      expect(transition).toHaveBeenCalledWith("pay-1", target, { note });
    });

    it("'confirmed' is collecting, NOT paid: it never reaches PAID", async () => {
      const tp = setup([pay("confirmed")]);
      tp.payment.findUnique.mockResolvedValue({ id: "pay-1" });
      await send("?tenantId=tenant-1&secret=abc");
      expect(transition).not.toHaveBeenCalledWith("pay-1", "PAID", expect.anything());
    });

    it("ignores an event for a payment we do not know, an unmapped action, a missing action and a missing link", async () => {
      const tp = setup([pay("paid_out")]);
      tp.payment.findUnique.mockResolvedValue(null);
      expect((await send("?tenantId=tenant-1&secret=abc")).status).toBe(200);

      setup([pay("created")]);
      await send("?tenantId=tenant-1&secret=abc");
      setup([{ id: "ev_1", resource_type: "payments", links: { payment: "PM1" } }]);
      await send("?tenantId=tenant-1&secret=abc");
      setup([{ id: "ev_1", resource_type: "payments", action: "paid_out", links: {} }]);
      await send("?tenantId=tenant-1&secret=abc");
      expect(transition).not.toHaveBeenCalled();
    });
  });

  describe("refunds resource (BE-08)", () => {
    const refund = (action?: string, links: Record<string, string> = { payment: "PM1" }) => ({
      id: "ev_r",
      resource_type: "refunds",
      ...(action ? { action } : {}),
      links,
    });

    it.each(["paid", "refund_settled"])("a settled refund ('%s') moves the payment to REFUNDED", async (action) => {
      const tp = setup([refund(action)]);
      tp.payment.findUnique.mockResolvedValue({ id: "pay-1" });
      await send("?tenantId=tenant-1&secret=abc");
      expect(transition).toHaveBeenCalledWith("pay-1", "REFUNDED", { note: "GoCardless refund" });
    });

    it("ignores unsettled refund actions, a missing action and a refund with no payment link", async () => {
      setup([refund("created")]);
      await send("?tenantId=tenant-1&secret=abc");
      setup([refund()]);
      await send("?tenantId=tenant-1&secret=abc");
      setup([refund("paid", {})]);
      await send("?tenantId=tenant-1&secret=abc");
      expect(transition).not.toHaveBeenCalled();
    });
  });

  describe("mandates resource", () => {
    function setupMandate(action: string) {
      return setup([{ id: "ev_1", resource_type: "mandates", action, links: { mandate: "MD1" } }]);
    }

    it("does nothing when a mandates event has no mandate link", async () => {
      const tp = setup([{ id: "ev_1", resource_type: "mandates", action: "active", links: {} }]);
      await send("?tenantId=tenant-1&secret=abc");
      expect(tp.customer.updateMany).not.toHaveBeenCalled();
    });

    it.each(["active", "cancelled", "failed", "expired"])("maps action '%s' to the matching mandate status", async (action) => {
      const tp = setupMandate(action);
      await send("?tenantId=tenant-1&secret=abc");
      expect(tp.customer.updateMany).toHaveBeenCalledWith({
        where: { gocardlessMandateId: "MD1" },
        data: { gocardlessMandateStatus: action },
      });
    });

    it("does nothing for an unrecognised mandate action or a missing one", async () => {
      const tp = setupMandate("something_else");
      await send("?tenantId=tenant-1&secret=abc");
      const tp2 = setup([{ id: "ev_1", resource_type: "mandates", links: { mandate: "MD1" } }]);
      await send("?tenantId=tenant-1&secret=abc");
      expect(tp.customer.updateMany).not.toHaveBeenCalled();
      expect(tp2.customer.updateMany).not.toHaveBeenCalled();
    });
  });

  it("does nothing for an unrecognised resource_type", async () => {
    const tp = setup([{ id: "ev_1", resource_type: "payouts", action: "paid" }]);
    const res = await send("?tenantId=tenant-1&secret=abc");
    expect(res.status).toBe(200);
    expect(transition).not.toHaveBeenCalled();
    expect(tp.customer.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/gocardless — BE-02 crash safety", () => {
  it("500s (and never crashes) when the tenant lookup throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tenantFindUnique.mockRejectedValue(new Error("db down"));
    const res = await send("?tenantId=t1&secret=abc");
    expect(res.status).toBe(500);
    consoleSpy.mockRestore();
  });

  it("500s when decrypt throws on a corrupt stored secret", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tenantFindUnique.mockResolvedValue({ id: "t1", schemaName: "s1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ gocardlessWebhookSecretEncrypted: "garbage" });
    getTenantPrismaForSchema.mockReturnValue(tp);
    decrypt.mockImplementationOnce(() => { throw new Error("bad ciphertext"); });
    const res = await send("?tenantId=t1&secret=abc");
    expect(res.status).toBe(500);
    consoleSpy.mockRestore();
  });
});
