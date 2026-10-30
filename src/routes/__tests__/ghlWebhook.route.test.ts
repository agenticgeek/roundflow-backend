import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { Prisma } from "../../generated/tenant-client";

const tenantFindUnique = vi.fn();
const tenantUpdateMany = vi.fn().mockResolvedValue({});
vi.mock("../../lib/prisma", () => ({
  prisma: {
    tenant: {
      findUnique: (...args: unknown[]) => tenantFindUnique(...args),
      updateMany: (...args: unknown[]) => tenantUpdateMany(...args),
    },
  },
}));

const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...args: unknown[]) => getTenantPrismaForSchema(...args),
}));

const decrypt = vi.fn((v: string) => v);
vi.mock("../../lib/crypto", () => ({
  decrypt: (...args: [string]) => decrypt(...args),
}));

const invalidateCachedBusinessSettings = vi.fn();
vi.mock("../../services/settings.service", () => ({
  invalidateCachedBusinessSettings: (...args: unknown[]) => invalidateCachedBusinessSettings(...args),
}));

import { ghlWebhookRouter } from "../ghlWebhook";

function makeTenantPrisma() {
  const tx = {
    customer: { create: vi.fn().mockResolvedValue({ id: "new-cust" }) },
    property: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    businessSettings: { findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({}) },
    webhookEvent: { create: vi.fn().mockResolvedValue({}) },
    customer: { findFirst: vi.fn().mockResolvedValue(null) },
    message: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    __tx: tx,
  };
}

function makeApp() {
  const app = express();
  app.use("/webhooks/ghl", express.raw({ type: "application/json" }), ghlWebhookRouter);
  return app;
}

function send(query: string, body: unknown) {
  return request(makeApp())
    .post(`/webhooks/ghl${query}`)
    .set("Content-Type", "application/json")
    .send(typeof body === "string" ? body : JSON.stringify(body));
}

function setup() {
  tenantFindUnique.mockResolvedValue({ schemaName: "t_1" });
  const tp = makeTenantPrisma();
  tp.businessSettings.findFirst.mockResolvedValue({ ghlWebhookSecretEncrypted: "enc" });
  decrypt.mockReturnValue("abc");
  getTenantPrismaForSchema.mockReturnValue(tp);
  return tp;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /webhooks/ghl — auth", () => {
  it("401s when tenantId is missing", async () => {
    const res = await send("?secret=abc", {});
    expect(res.status).toBe(401);
  });

  it("401s when secret is missing", async () => {
    const res = await send("?tenantId=t1", {});
    expect(res.status).toBe(401);
  });

  it("401s when the tenant does not exist", async () => {
    tenantFindUnique.mockResolvedValue(null);
    const res = await send("?tenantId=t1&secret=abc", {});
    expect(res.status).toBe(401);
  });

  it("401s when the tenant has no ghl webhook secret configured", async () => {
    tenantFindUnique.mockResolvedValue({ schemaName: "t_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ ghlWebhookSecretEncrypted: null });
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send("?tenantId=t1&secret=abc", {});
    expect(res.status).toBe(401);
  });

  it("401s when the secret doesn't match (same length)", async () => {
    tenantFindUnique.mockResolvedValue({ schemaName: "t_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ ghlWebhookSecretEncrypted: "enc" });
    decrypt.mockReturnValue("real-secret");
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send("?tenantId=t1&secret=wrong-secre", {});
    expect(res.status).toBe(401);
  });

  it("401s when the secret has a different length (timingSafeEqual throws)", async () => {
    tenantFindUnique.mockResolvedValue({ schemaName: "t_1" });
    const tp = makeTenantPrisma();
    tp.businessSettings.findFirst.mockResolvedValue({ ghlWebhookSecretEncrypted: "enc" });
    decrypt.mockReturnValue("a-much-longer-real-secret");
    getTenantPrismaForSchema.mockReturnValue(tp);

    const res = await send("?tenantId=t1&secret=short", {});
    expect(res.status).toBe(401);
  });

  it("400s on malformed JSON", async () => {
    setup();
    const res = await send("?tenantId=t1&secret=abc", "not json");
    expect(res.status).toBe(400);
  });

  it("200s immediately on a valid, authenticated request", async () => {
    setup();
    const res = await send("?tenantId=t1&secret=abc", { type: "Uninstall" });
    expect(res.status).toBe(200);
  });
});

describe("POST /webhooks/ghl — event processing", () => {
  it("skips processing when the event id is a duplicate (unique-constraint violation)", async () => {
    const tp = setup();
    tp.webhookEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" })
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await send("?tenantId=t1&secret=abc", { id: "ev1", contactId: "c1" });

    await vi.waitFor(() => expect(tp.webhookEvent.create).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(tp.customer.findFirst).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("D-8: any other dedup error is logged, not swallowed as 'already processed'", async () => {
    const tp = setup();
    tp.webhookEvent.create.mockRejectedValue(new Error("connection reset"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await send("?tenantId=t1&secret=abc", { id: "ev1", contactId: "c1" });

    await vi.waitFor(() => expect(err).toHaveBeenCalledWith(expect.stringContaining("[ghlWebhook]"), expect.any(Error)));
    expect(tp.customer.findFirst).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("no-ops for ContactCreate / ContactUpdate (RoundFlow stays master)", async () => {
    const tp = setup();
    await send("?tenantId=t1&secret=abc", { type: "ContactUpdate", contactId: "c1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(tp.customer.findFirst).not.toHaveBeenCalled();
    expect(tp.$transaction).not.toHaveBeenCalled();
  });

  describe("lead handoff (no type field — GHL Workflow 5)", () => {
    it("creates a Customer and Property for a brand-new contact", async () => {
      const tp = setup();

      await send("?tenantId=t1&secret=abc", {
        contactId: "ghl-1", firstName: "John", lastName: "Smith",
        email: "john@example.com", phone: "+447700123456",
        address1: "123 High Street", postalCode: "SW1A 1AA",
      });

      await vi.waitFor(() => expect(tp.__tx.customer.create).toHaveBeenCalledWith({
        data: { name: "John Smith", email: "john@example.com", phone: "+447700123456", ghlContactId: "ghl-1" },
      }));
      expect(tp.__tx.property.create).toHaveBeenCalledWith({
        data: { customerId: "new-cust", addressLine: "123 High Street", postcode: "SW1A 1AA" },
      });
    });

    it("creates just the Customer when address fields are missing", async () => {
      const tp = setup();

      await send("?tenantId=t1&secret=abc", { contactId: "ghl-2", firstName: "Jane" });

      await vi.waitFor(() => expect(tp.__tx.customer.create).toHaveBeenCalled());
      expect(tp.__tx.property.create).not.toHaveBeenCalled();
    });

    it("falls back to 'Unknown' when no name is given", async () => {
      const tp = setup();

      await send("?tenantId=t1&secret=abc", { contactId: "ghl-3" });

      await vi.waitFor(() => expect(tp.__tx.customer.create).toHaveBeenCalledWith({
        data: { name: "Unknown", email: null, phone: null, ghlContactId: "ghl-3" },
      }));
    });

    it("skips entirely when a Customer is already linked to this contactId", async () => {
      const tp = setup();
      tp.customer.findFirst.mockResolvedValue({ id: "existing" });

      await send("?tenantId=t1&secret=abc", { contactId: "ghl-1", firstName: "John" });

      await vi.waitFor(() => expect(tp.customer.findFirst).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 10));
      expect(tp.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("InboundMessage", () => {
    it("creates a linked Message when the contact is known", async () => {
      const tp = setup();
      tp.customer.findFirst.mockResolvedValue({ id: "cust-1" });

      await send("?tenantId=t1&secret=abc", {
        type: "InboundMessage", contactId: "ghl-1", message: { body: "hello", type: "SMS" },
      });

      await vi.waitFor(() => expect(tp.message.create).toHaveBeenCalledWith({
        data: { channel: "SMS", direction: "INBOUND", body: "hello", customerId: "cust-1", sentAt: expect.any(Date) },
      }));
    });

    it("creates an unlinked Message when no contact matches", async () => {
      const tp = setup();
      tp.customer.findFirst.mockResolvedValue(null);

      await send("?tenantId=t1&secret=abc", {
        type: "InboundMessage", contactId: "ghl-1", message: { body: "hello", type: "EMAIL" },
      });

      await vi.waitFor(() => expect(tp.message.create).toHaveBeenCalledWith({
        data: { channel: "EMAIL", direction: "INBOUND", body: "hello", sentAt: expect.any(Date) },
      }));
    });

    it("maps WHATSAPP and defaults unrecognised types to SMS", async () => {
      const tp = setup();

      await send("?tenantId=t1&secret=abc", { type: "InboundMessage", message: { body: "hi", type: "WHATSAPP" } });
      await vi.waitFor(() => expect(tp.message.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ channel: "WHATSAPP" }) })
      ));
    });

    it("does nothing when the message has no body", async () => {
      const tp = setup();
      await send("?tenantId=t1&secret=abc", { type: "InboundMessage", message: {} });
      await new Promise((r) => setTimeout(r, 10));
      expect(tp.message.create).not.toHaveBeenCalled();
    });

    it("does nothing when there is no message object at all", async () => {
      const tp = setup();
      await send("?tenantId=t1&secret=abc", { type: "InboundMessage" });
      await new Promise((r) => setTimeout(r, 10));
      expect(tp.message.create).not.toHaveBeenCalled();
    });

    it("defaults to SMS when the message has a body but no type", async () => {
      const tp = setup();
      await send("?tenantId=t1&secret=abc", { type: "InboundMessage", message: { body: "hi" } });
      await vi.waitFor(() => expect(tp.message.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ channel: "SMS" }) })
      ));
    });
  });

  it("disconnects the tenant on Uninstall", async () => {
    const tp = setup();

    await send("?tenantId=t1&secret=abc", { type: "Uninstall", id: "ev-ok" });

    await vi.waitFor(() => expect(tp.businessSettings.updateMany).toHaveBeenCalledWith({
      data: {
        ghlConnected: false, ghlLocationId: null, ghlAccessTokenEncrypted: null,
        ghlRefreshTokenEncrypted: null, ghlTokenExpiresAt: null, ghlWebhookSecretEncrypted: null,
      },
    }));
    expect(invalidateCachedBusinessSettings).toHaveBeenCalledWith(tp);
    expect(tenantUpdateMany).toHaveBeenCalledWith({ where: { schemaName: "t_1" }, data: { ghlLocationId: null } });
  });

  it("does nothing for a recognised-but-unhandled type with no contactId", async () => {
    const tp = setup();
    await send("?tenantId=t1&secret=abc", { type: "SomeOtherEventType" });
    await new Promise((r) => setTimeout(r, 10));
    expect(tp.customer.findFirst).not.toHaveBeenCalled();
    expect(tp.message.create).not.toHaveBeenCalled();
    expect(tp.businessSettings.updateMany).not.toHaveBeenCalled();
  });

  it("logs when processEvent throws outside the dedup guard", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = setup();
    tp.customer.findFirst.mockRejectedValue(new Error("db down"));

    await send("?tenantId=t1&secret=abc", { contactId: "ghl-1" });

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("t1/undefined failed:"),
      expect.any(Error)
    ));
    errorSpy.mockRestore();
  });
});
