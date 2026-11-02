import { it, expect, vi, beforeEach, describe } from "vitest";

vi.mock("../../integrations/ghl/api", () => ({
  getGhlToken: vi.fn(),
  createGhlContact: vi.fn(),
  sendGhlMessage: vi.fn(),
}));

vi.mock("../business-time", () => ({ tenantToday: vi.fn().mockResolvedValue(new Date("2026-11-03T00:00:00.000Z")) }));

import { getGhlToken, createGhlContact, sendGhlMessage } from "../../integrations/ghl/api";
import { createMessageService, optOutboundChannel, resolveChannel } from "../message.service";

function makePrisma() {
  return {
    property: { findUnique: vi.fn(), findMany: vi.fn() },
    customer: { findUnique: vi.fn(), update: vi.fn() },
    message: { create: vi.fn().mockResolvedValue({ id: "msg-1" }) },
    round: { findUnique: vi.fn().mockResolvedValue({ name: "Alnwick Fri" }) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ businessName: "Shine Ltd", currency: "£" }) },
    visit: { findMany: vi.fn().mockResolvedValue([]) },
    invoice: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 12.5 } }) },
    integrationOutbox: { create: vi.fn().mockResolvedValue({}) },
  } as unknown as Parameters<typeof createMessageService>[0];
}

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const CTX = { accessToken: "t", locationId: "l" };

beforeEach(() => {
  vi.clearAllMocks();
  asMock(getGhlToken).mockResolvedValue(CTX);
  asMock(sendGhlMessage).mockResolvedValue("ghl-msg-1");
});

describe("optOutboundChannel", () => {
  it("treats undefined, null and AUTO as 'pick the default'", () => {
    expect(optOutboundChannel(undefined)).toBeUndefined();
    expect(optOutboundChannel(null)).toBeUndefined();
    expect(optOutboundChannel("auto")).toBeUndefined();
  });
  it("normalises a channel to upper case", () => {
    expect(optOutboundChannel("whatsapp")).toBe("WHATSAPP");
  });
  it("rejects a non-string and an unknown channel", () => {
    expect(() => optOutboundChannel(5)).toThrow(/must be a string/);
    expect(() => optOutboundChannel("fax")).toThrow(/channel must be one of/);
  });
});

describe("resolveChannel", () => {
  it("defaults to SMS when the customer has a mobile, else EMAIL", () => {
    expect(resolveChannel({ phone: "07", email: "a@b.c" })).toBe("SMS");
    expect(resolveChannel({ phone: null, email: "a@b.c" })).toBe("EMAIL");
  });
  it("400 NO_CONTACT_FOR_CHANNEL when EMAIL is chosen with no email", () => {
    expect(() => resolveChannel({ phone: "07", email: null }, "EMAIL")).toThrow(
      expect.objectContaining({ statusCode: 400, code: "NO_CONTACT_FOR_CHANNEL", message: expect.stringMatching(/email/) })
    );
  });
  it("400 NO_CONTACT_FOR_CHANNEL when SMS/WhatsApp is chosen with no mobile", () => {
    expect(() => resolveChannel({ phone: null, email: "a@b.c" }, "WHATSAPP")).toThrow(
      expect.objectContaining({ code: "NO_CONTACT_FOR_CHANNEL", message: expect.stringMatching(/mobile/) })
    );
  });
  it("only requires an email for EMAIL", () => {
    expect(resolveChannel({ phone: "07", email: null }, "SMS")).toBe("SMS");
  });
});

describe("send", () => {
  it("rejects an unknown channel with 400", async () => {
    const svc = createMessageService(makePrisma());
    await expect(svc.send({ customerId: "c1", channel: "fax", body: "hi" }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("400s with neither propertyId nor customerId", async () => {
    await expect(createMessageService(makePrisma()).send({ body: "hi" }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("404s when the property does not exist", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findUnique).mockResolvedValue(null);
    await expect(createMessageService(prisma).send({ propertyId: "p1", body: "hi" }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s when the customer does not exist", async () => {
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue(null);
    await expect(createMessageService(prisma).send({ customerId: "c1", body: "hi" }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 409 GHL_NOT_CONNECTED when GHL is not connected", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue({ id: "c1", name: "J", phone: "07", email: null, ghlContactId: "g" });
    await expect(createMessageService(prisma).send({ customerId: "c1", channel: "sms", body: "hi" }))
      .rejects.toMatchObject({ statusCode: 409, code: "GHL_NOT_CONNECTED" });
  });

  it("sends via an existing contact, then records the Message", async () => {
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue({
      id: "c1", name: "Jane", phone: "07", email: null, ghlContactId: "gc1",
    });
    const res = await createMessageService(prisma).send({ customerId: "c1", channel: "sms", body: "hi", templateId: "t1" });
    expect(res).toEqual({ status: "sent", messageId: "msg-1", channel: "SMS" });
    expect(sendGhlMessage).toHaveBeenCalledWith(CTX, "gc1", "hi", "SMS");
    expect(createGhlContact).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ channel: "SMS", direction: "OUTBOUND", body: "hi", customerId: "c1", templateId: "t1", externalId: "ghl-msg-1" }),
    });
  });

  it("creates and persists a contact when the customer has none, then sends (default channel)", async () => {
    asMock(createGhlContact).mockResolvedValue("newC");
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue({
      id: "c1", name: "Jane", phone: null, email: "j@x.co", ghlContactId: null,
    });
    const res = await createMessageService(prisma).send({ customerId: "c1", body: "yo" });
    expect(res.channel).toBe("EMAIL");
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { ghlContactId: "newC" } });
    expect(sendGhlMessage).toHaveBeenCalledWith(expect.anything(), "newC", "yo", "EMAIL");
    expect(prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ templateId: null }) });
  });

  it("resolves customer from propertyId", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findUnique).mockResolvedValue({ customerId: "c9" });
    asMock(prisma.customer.findUnique).mockResolvedValue({
      id: "c9", name: "Al", phone: "07", email: null, ghlContactId: "gc9",
    });
    await createMessageService(prisma).send({ propertyId: "p1", channel: "sms", body: "hey" });
    expect(prisma.property.findUnique).toHaveBeenCalledWith({ where: { id: "p1" }, select: { customerId: true } });
    expect(sendGhlMessage).toHaveBeenCalledWith(expect.anything(), "gc9", "hey", "SMS");
  });

  it("maps a GHL failure to 502 GHL_SEND_FAILED and records no Message", async () => {
    asMock(sendGhlMessage).mockRejectedValue(new Error("GHL sendMessage failed (422): bad"));
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue({ id: "c1", name: "J", phone: "07", email: null, ghlContactId: "g" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createMessageService(prisma).send({ customerId: "c1", body: "hi" }))
      .rejects.toMatchObject({ statusCode: 502, code: "GHL_SEND_FAILED", message: expect.stringContaining("422") });
    expect(prisma.message.create).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

const prop = (id: string, over: Record<string, unknown> = {}, customerOver: Record<string, unknown> = {}) => ({
  id: `p-${id}`,
  addressLine: `${id} High St`,
  customer: { id, name: `Cust ${id}`, phone: "07", email: null, ghlContactId: `g-${id}`, messagesOptOut: false, ...customerOver },
  visits: [],
  ...over,
});
const roundInput = { roundId: "r1", channel: "sms", body: "hi", excludePaymentHold: false };

describe("sendToRound", () => {
  it("409s when GHL is not connected", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    await expect(createMessageService(makePrisma()).sendToRound(roundInput))
      .rejects.toMatchObject({ statusCode: 409, code: "GHL_NOT_CONNECTED" });
  });

  it("404s for an unknown round", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([]);
    asMock(prisma.round.findUnique).mockResolvedValue(null);
    await expect(createMessageService(prisma).sendToRound(roundInput)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("dedupes customers across properties, reports each recipient and records a Message per send", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1"), prop("c1", { id: "p-2nd" }), prop("c2")]);
    const res = await createMessageService(prisma).sendToRound({ ...roundInput, templateId: "t1" });
    expect(res).toMatchObject({ queued: 2, sent: 2, scheduled: 0, skippedOptedOut: 0, skippedNoContact: 0, failed: 0, scheduledFor: null });
    expect(res.recipients.map((r) => [r.customerId, r.status, r.channel])).toEqual([["c1", "sent", "SMS"], ["c2", "sent", "SMS"]]);
    expect(sendGhlMessage).toHaveBeenCalledTimes(2);
    expect(prisma.message.create).toHaveBeenCalledTimes(2);
    expect(prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ customerId: "c1", templateId: "t1", body: "hi" }) });
  });

  it("renders {{variables}} per customer instead of sending them literally", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1"), prop("c2")]);
    asMock(prisma.visit.findMany).mockResolvedValue([
      { propertyId: "p-c1", date: new Date("2026-11-09T00:00:00.000Z"), technician: { name: "Tom" } },
      { propertyId: "p-c1", date: new Date("2026-11-20T00:00:00.000Z"), technician: { name: "Later" } }, // only the first counts
    ]);
    await createMessageService(prisma).sendToRound({
      ...roundInput,
      body: "Hi {{firstName}} ({{customerName}}), {{technicianName}} cleans {{address}} on {{date}} for {{roundName}} - {{businessName}}. Owed {{amount}} {{unknown}}",
    });
    expect(sendGhlMessage).toHaveBeenNthCalledWith(1, CTX, "g-c1",
      "Hi Cust (Cust c1), Tom cleans c1 High St on Monday 9 November for Alnwick Fri - Shine Ltd. Owed £12.50 ", "SMS");
    expect(sendGhlMessage).toHaveBeenNthCalledWith(2, CTX, "g-c2",
      "Hi Cust (Cust c2),  cleans c2 High St on  for Alnwick Fri - Shine Ltd. Owed £12.50 ", "SMS");
  });

  it("only looks up the balance when the copy uses {{amount}}", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1")]);
    await createMessageService(prisma).sendToRound(roundInput);
    expect(prisma.invoice.aggregate).not.toHaveBeenCalled();
    await createMessageService(prisma).sendToRound({ ...roundInput, body: "owed [Amount]" });
    expect(prisma.invoice.aggregate).toHaveBeenCalledTimes(1);
  });

  it("skips customers whose round properties are all on payment hold", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1", { visits: [{ id: "v1" }] }), prop("c2")]);
    const res = await createMessageService(prisma).sendToRound({ ...roundInput, excludePaymentHold: true });
    expect(res.queued).toBe(1);
    expect(sendGhlMessage).toHaveBeenCalledWith(expect.anything(), "g-c2", "hi", "SMS");
  });

  it("skips opted-out customers and customers with no contact for the channel, without contacting GHL", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([
      prop("c1", {}, { messagesOptOut: true }),
      prop("c2", {}, { phone: null }),
      prop("c3"),
    ]);
    const res = await createMessageService(prisma).sendToRound(roundInput);
    expect(res).toMatchObject({ queued: 1, sent: 1, skippedOptedOut: 1, skippedNoContact: 1, failed: 0 });
    expect(res.recipients.map((r) => r.status)).toEqual(["skipped_opted_out", "skipped_no_contact", "sent"]);
    expect(res.recipients[1].error).toMatch(/no mobile/i);
    expect(sendGhlMessage).toHaveBeenCalledTimes(1);
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
  });

  it("reports a per-recipient failure and records no Message for it", async () => {
    asMock(sendGhlMessage).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(null);
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1"), prop("c2")]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await createMessageService(prisma).sendToRound(roundInput);
    expect(res).toMatchObject({ queued: 1, sent: 1, failed: 1 });
    expect(res.recipients[0]).toMatchObject({ customerId: "c1", status: "failed", error: expect.stringContaining("boom") });
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("queues rendered messages on the outbox for scheduledFor instead of sending", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1"), prop("c2", {}, { messagesOptOut: true })]);
    const at = new Date("2026-11-10T09:00:00.000Z");
    const res = await createMessageService(prisma).sendToRound({ ...roundInput, body: "Hi {{firstName}}", templateId: "t1", scheduledFor: at });
    expect(res).toMatchObject({ queued: 1, sent: 0, scheduled: 1, skippedOptedOut: 1, scheduledFor: at.toISOString() });
    expect(sendGhlMessage).not.toHaveBeenCalled();
    expect(prisma.integrationOutbox.create).toHaveBeenCalledTimes(1);
    expect(prisma.integrationOutbox.create).toHaveBeenCalledWith({
      data: {
        eventType: "message.send",
        runAfter: at,
        payload: { customerId: "c1", channel: "SMS", body: "Hi Cust", templateId: "t1", reason: "ROUND_MESSAGE", roundId: "r1" },
      },
    });
  });

  it("reports a scheduling failure as failed", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1")]);
    asMock(prisma.integrationOutbox.create).mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await createMessageService(prisma).sendToRound({ ...roundInput, scheduledFor: new Date("2026-11-10T09:00:00.000Z") });
    expect(res).toMatchObject({ queued: 0, failed: 1 });
    err.mockRestore();
  });
});

describe("sendToRound customerIds", () => {
  it("messages only the chosen recipients and rejects ids that are not in the round", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1"), prop("c2"), prop("c3")]);
    const res = await createMessageService(prisma).sendToRound({ ...roundInput, customerIds: ["c1", "c3"] });
    expect(res.recipients.map((r) => r.customerId)).toEqual(["c1", "c3"]);
    expect(sendGhlMessage).toHaveBeenCalledTimes(2);
    await expect(createMessageService(prisma).sendToRound({ ...roundInput, customerIds: ["c1", "nope"] }))
      .rejects.toMatchObject({ statusCode: 400, code: "UNKNOWN_RECIPIENT" });
  });
});

describe("listRoundRecipients", () => {
  it("returns the confirmed audience with a per-customer status, without needing GHL", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([
      prop("c1"), prop("c2", {}, { messagesOptOut: true }), prop("c3", {}, { phone: null }), prop("c4", { visits: [{ id: "v" }] }),
    ]);
    const all = await createMessageService(prisma).listRoundRecipients({ roundId: "r1", excludePaymentHold: false });
    expect(all).toMatchObject({ total: 4, reachable: 2 });
    expect(all.recipients.map((r) => [r.customerId, r.status, r.address])).toEqual([
      ["c1", "ok", "c1 High St"], ["c2", "opted_out", "c2 High St"], ["c3", "no_contact", "c3 High St"], ["c4", "ok", "c4 High St"],
    ]);
    const filtered = await createMessageService(prisma).listRoundRecipients({ roundId: "r1", channel: "email", excludePaymentHold: true });
    expect(filtered.total).toBe(3);
    expect(filtered.recipients.every((r) => r.status !== "ok")).toBe(true); // nobody has an email
  });
});

describe("assertGhlConnected", () => {
  it("resolves when connected and 409s when not", async () => {
    await expect(createMessageService(makePrisma()).assertGhlConnected()).resolves.toBeUndefined();
    asMock(getGhlToken).mockResolvedValue(null);
    await expect(createMessageService(makePrisma()).assertGhlConnected()).rejects.toMatchObject({ code: "GHL_NOT_CONNECTED" });
  });
});
