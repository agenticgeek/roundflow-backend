import { it, expect, vi, beforeEach, describe } from "vitest";

vi.mock("../../integrations/ghl/api", () => ({
  getGhlToken: vi.fn(),
  createGhlContact: vi.fn(),
  sendGhlMessage: vi.fn(),
}));

const { emailAvail, sendTenantEmail } = vi.hoisted(() => ({ emailAvail: vi.fn(), sendTenantEmail: vi.fn() }));
vi.mock("../email.service", async () => {
  const actual = await vi.importActual<typeof import("../email.service")>("../email.service");
  return { ...actual, getEmailAvailability: emailAvail, sendTenantEmail };
});

vi.mock("../business-time", () => ({ tenantToday: vi.fn().mockResolvedValue(new Date("2026-11-03T00:00:00.000Z")) }));

import { getGhlToken, createGhlContact, sendGhlMessage } from "../../integrations/ghl/api";
import { bestChannel, createMessageService, optOutboundChannel, pickChannel, resolveChannel } from "../message.service";

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
  emailAvail.mockResolvedValue({ available: true });
  sendTenantEmail.mockResolvedValue({ externalId: "ses-1", tier: 1, from: "x" });
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

  it("SMS without GHL is a typed 409 CHANNEL_UNAVAILABLE (reason GHL_NOT_CONNECTED)", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue({ id: "c1", name: "J", phone: "07", email: null, ghlContactId: "g" });
    await expect(createMessageService(prisma).send({ customerId: "c1", channel: "sms", body: "hi" }))
      .rejects.toMatchObject({ statusCode: 409, code: "CHANNEL_UNAVAILABLE", reason: "GHL_NOT_CONNECTED" });
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

  it("creates and persists a GHL contact when the customer has none, then sends (default channel SMS)", async () => {
    asMock(createGhlContact).mockResolvedValue("newC");
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue({
      id: "c1", name: "Jane", phone: "07", email: "j@x.co", ghlContactId: null,
    });
    const res = await createMessageService(prisma).send({ customerId: "c1", body: "yo" });
    expect(res.channel).toBe("SMS");
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { ghlContactId: "newC" } });
    expect(sendGhlMessage).toHaveBeenCalledWith(expect.anything(), "newC", "yo", "SMS");
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
  it("409 CHANNEL_UNAVAILABLE when the chosen channel (SMS) needs GHL and it is not connected", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1")]);
    await expect(createMessageService(prisma).sendToRound(roundInput))
      .rejects.toMatchObject({ statusCode: 409, code: "CHANNEL_UNAVAILABLE", reason: "GHL_NOT_CONNECTED" });
  });

  it("MSG-003b: an unknown round (404) or unknown recipients (400) are reported before the channel is judged", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    emailAvail.mockResolvedValue({ available: false, reason: "EMAIL_NOT_CONFIGURED" });
    const missing = makePrisma();
    asMock(missing.property.findMany).mockResolvedValue([]);
    asMock(missing.round.findUnique).mockResolvedValue(null);
    await expect(createMessageService(missing).sendToRound({ ...roundInput, channel: "email" })).rejects.toMatchObject({ statusCode: 404 });
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1")]);
    await expect(createMessageService(prisma).sendToRound({ ...roundInput, channel: "email", customerIds: ["nope"] })).rejects.toMatchObject({ code: "UNKNOWN_RECIPIENT" });
    // a valid round and recipients then meet the channel problem
    await expect(createMessageService(prisma).sendToRound({ ...roundInput, channel: "email" })).rejects.toMatchObject({ code: "CHANNEL_UNAVAILABLE" });
  });

  it("409 CHANNEL_UNAVAILABLE for an EMAIL round message when email is unavailable", async () => {
    emailAvail.mockResolvedValue({ available: false, reason: "EMAIL_PAUSED", detail: "bounces" });
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1")]);
    await expect(createMessageService(prisma).sendToRound({ ...roundInput, channel: "email" }))
      .rejects.toMatchObject({ statusCode: 409, code: "CHANNEL_UNAVAILABLE", reason: "EMAIL_PAUSED" });
  });

  it("sends EMAIL round messages through the native mailer, not GHL, and records delivery status", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1", {}, { email: "a@b.co" })]);
    const res = await createMessageService(prisma).sendToRound({ ...roundInput, channel: "email" });
    expect(res).toMatchObject({ sent: 1, failed: 0 });
    expect(sendGhlMessage).not.toHaveBeenCalled();
    expect(sendTenantEmail).toHaveBeenCalledWith(prisma, expect.objectContaining({ to: "a@b.co", bodyText: "hi", transactional: false, messageId: expect.any(String) }));
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: expect.any(String), channel: "EMAIL", externalId: "ses-1", deliveryStatus: "SENT", deliveryUpdatedAt: expect.any(Date) }),
    });
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

  it("treats a visit with no technician and a customer with no unpaid invoices as empty values", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1")]);
    asMock(prisma.visit.findMany).mockResolvedValue([
      { propertyId: "p-c1", date: new Date("2026-11-09T00:00:00.000Z"), technician: null },
    ]);
    asMock(prisma.invoice.aggregate).mockResolvedValue({ _sum: { amount: null } });
    await createMessageService(prisma).sendToRound({ ...roundInput, body: "[{{technicianName}}] owed {{amount}}" });
    expect(sendGhlMessage).toHaveBeenCalledWith(CTX, "g-c1", "[] owed £0.00", "SMS");
  });

  it("renders an empty business name when no settings row exists", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([prop("c1")]);
    asMock(prisma.businessSettings.findFirst).mockResolvedValue(null);
    await createMessageService(prisma).sendToRound({ ...roundInput, body: "from [{{businessName}}]" });
    expect(sendGhlMessage).toHaveBeenCalledWith(CTX, "g-c1", "from []", "SMS");
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

describe("assertAnyChannelAvailable", () => {
  it("resolves when either GHL or email works; 409 NO_AVAILABLE_CHANNEL when neither", async () => {
    await expect(createMessageService(makePrisma()).assertAnyChannelAvailable()).resolves.toBeUndefined();
    asMock(getGhlToken).mockResolvedValue(null);
    await expect(createMessageService(makePrisma()).assertAnyChannelAvailable()).resolves.toBeUndefined();
    emailAvail.mockResolvedValue({ available: false, reason: "EMAIL_NOT_CONFIGURED" });
    await expect(createMessageService(makePrisma()).assertAnyChannelAvailable()).rejects.toMatchObject({
      statusCode: 409, code: "CHANNEL_UNAVAILABLE", reason: "NO_AVAILABLE_CHANNEL",
    });
  });
});

describe("channelCaps", () => {
  it("exposes the raw GHL and email state", async () => {
    expect(await createMessageService(makePrisma()).channelCaps()).toEqual({ ghl: true, email: { available: true } });
  });
});

describe("capabilities", () => {
  it("reports email/sms/whatsapp/calls", async () => {
    expect(await createMessageService(makePrisma()).capabilities()).toEqual({ email: true, sms: true, whatsapp: true, calls: true });
    asMock(getGhlToken).mockResolvedValue(null);
    emailAvail.mockResolvedValue({ available: false, reason: "EMAIL_PAUSED" });
    expect(await createMessageService(makePrisma()).capabilities()).toEqual({ email: false, sms: false, whatsapp: false, calls: true });
  });
});

const AVAIL = { available: true } as const;
const DOWN = { available: false, reason: "EMAIL_PAUSED" } as const;
const both = { ghl: true, email: AVAIL };
const ghlOnly = { ghl: true, email: DOWN };
const emailOnly = { ghl: false, email: AVAIL };
const neither = { ghl: false, email: DOWN };
const cust = (over: Record<string, unknown> = {}) => ({ phone: "07", email: "a@b.co", emailInvalidAt: null, ...over }) as never;

describe("pickChannel (explicit and AUTO) matrix: channel x GHL x contact x email state", () => {
  it("AUTO prefers SMS when GHL is connected and there is a mobile", () => {
    expect(pickChannel(cust(), undefined, both)).toBe("SMS");
  });
  it("AUTO falls back to EMAIL without GHL, without a mobile, or on email only", () => {
    expect(pickChannel(cust(), undefined, emailOnly)).toBe("EMAIL");
    expect(pickChannel(cust({ phone: null }), undefined, both)).toBe("EMAIL");
  });
  it("AUTO with GHL but no mobile and no usable email -> typed CHANNEL_UNAVAILABLE", () => {
    expect(() => pickChannel(cust({ phone: null }), undefined, ghlOnly)).toThrow(expect.objectContaining({ code: "CHANNEL_UNAVAILABLE", reason: "EMAIL_PAUSED" }));
  });
  it("AUTO with only a mobile and no GHL -> GHL_NOT_CONNECTED reason when email is also missing", () => {
    expect(() => pickChannel(cust({ email: null }), undefined, neither)).toThrow(expect.objectContaining({ code: "CHANNEL_UNAVAILABLE", reason: "GHL_NOT_CONNECTED" }));
  });
  it("AUTO: no phone and no email -> 400 NO_CONTACT_FOR_CHANNEL", () => {
    expect(() => pickChannel(cust({ phone: null, email: null }), undefined, both)).toThrow(expect.objectContaining({ statusCode: 400, code: "NO_CONTACT_FOR_CHANNEL" }));
  });
  it("AUTO: a bounced email counts as unusable", () => {
    expect(() => pickChannel(cust({ phone: null, emailInvalidAt: new Date() }), undefined, both)).toThrow(expect.objectContaining({ reason: "EMAIL_ADDRESS_INVALID" }));
  });
  it("AUTO: email present and unusable + mobile present but no GHL -> email's reason", () => {
    expect(() => pickChannel(cust(), undefined, neither)).toThrow(expect.objectContaining({ reason: "EMAIL_PAUSED" }));
  });
  it("explicit EMAIL: ok, needs an email, refuses an invalid one, refuses when email is down", () => {
    expect(pickChannel(cust(), "EMAIL" as never, emailOnly)).toBe("EMAIL");
    expect(() => pickChannel(cust({ email: null }), "EMAIL" as never, both)).toThrow(expect.objectContaining({ code: "NO_CONTACT_FOR_CHANNEL" }));
    expect(() => pickChannel(cust({ emailInvalidAt: new Date() }), "EMAIL" as never, both)).toThrow(expect.objectContaining({ statusCode: 409, code: "CHANNEL_UNAVAILABLE", reason: "EMAIL_ADDRESS_INVALID" }));
    expect(() => pickChannel(cust(), "EMAIL" as never, ghlOnly)).toThrow(expect.objectContaining({ code: "CHANNEL_UNAVAILABLE", reason: "EMAIL_PAUSED" }));
  });
  it("explicit SMS / WHATSAPP: need a mobile and GHL", () => {
    expect(pickChannel(cust(), "SMS" as never, both)).toBe("SMS");
    expect(pickChannel(cust(), "WHATSAPP" as never, both)).toBe("WHATSAPP");
    expect(() => pickChannel(cust({ phone: null }), "SMS" as never, both)).toThrow(expect.objectContaining({ code: "NO_CONTACT_FOR_CHANNEL" }));
    expect(() => pickChannel(cust(), "SMS" as never, emailOnly)).toThrow(expect.objectContaining({ code: "CHANNEL_UNAVAILABLE", reason: "GHL_NOT_CONNECTED" }));
  });
});

describe("pickChannel preferred (invoices are EMAIL-first)", () => {
  it("AUTO with preferred EMAIL picks email when usable, else the normal order", () => {
    expect(pickChannel(cust(), undefined, both, "EMAIL" as never)).toBe("EMAIL");
    expect(pickChannel(cust(), undefined, ghlOnly, "EMAIL" as never)).toBe("SMS");
    expect(pickChannel(cust({ email: null }), undefined, both, "EMAIL" as never)).toBe("SMS");
  });
  it("prepare forwards the preference", async () => {
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue({ id: "c1", name: "J", phone: "07", email: "a@b.co", ghlContactId: "g", emailInvalidAt: null, messagesOptOut: false });
    expect((await createMessageService(prisma).prepare("c1", undefined, { preferred: "EMAIL" })).channel).toBe("EMAIL");
  });
});

describe("bestChannel (per-customer, for flows that must skip rather than fail)", () => {
  const c = (over: Record<string, unknown> = {}) => cust({ messagesOptOut: false, ...over });
  it("opt-out applies to every channel, email included", () => {
    expect(bestChannel(c({ messagesOptOut: true }), undefined, both)).toEqual({ skip: "CUSTOMER_OPTED_OUT" });
  });
  it("prefers SMS with GHL, else email, else skips with NO_AVAILABLE_CHANNEL", () => {
    expect(bestChannel(c(), undefined, both)).toEqual({ channel: "SMS" });
    expect(bestChannel(c(), undefined, emailOnly)).toEqual({ channel: "EMAIL" });
    expect(bestChannel(c({ phone: null }), undefined, both)).toEqual({ channel: "EMAIL" });
    expect(bestChannel(c(), undefined, neither)).toEqual({ skip: "NO_AVAILABLE_CHANNEL" });
    expect(bestChannel(c({ phone: null, email: null }), undefined, both)).toEqual({ skip: "NO_AVAILABLE_CHANNEL" });
    expect(bestChannel(c({ emailInvalidAt: new Date() }), undefined, emailOnly)).toEqual({ skip: "NO_AVAILABLE_CHANNEL" });
  });
  it("a preferred channel is honoured when usable and replaced by the next best when not", () => {
    expect(bestChannel(c(), "EMAIL" as never, both)).toEqual({ channel: "EMAIL" });
    expect(bestChannel(c(), "SMS" as never, emailOnly)).toEqual({ channel: "EMAIL" });
    expect(bestChannel(c(), "WHATSAPP" as never, both)).toEqual({ channel: "WHATSAPP" });
    expect(bestChannel(c({ email: null }), "EMAIL" as never, both)).toEqual({ channel: "SMS" });
  });
});

describe("sendBest (automated one-off messages: preferred channel, else best available, else skip)", () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: "c1", name: "Jane", phone: "07", email: "j@x.co", ghlContactId: "g1", emailInvalidAt: null, messagesOptOut: false, ...over });

  it("sends on the preferred channel when usable", async () => {
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue(row());
    const res = await createMessageService(prisma).sendBest({ customerId: "c1", preferred: "email", body: "hi", subject: "S", templateId: "t1", complaintId: "cmp1" });
    expect(res).toEqual({ status: "sent", messageId: "msg-1", channel: "EMAIL" });
    // reminders / visit-completed / complaint replies are non-transactional: the email carries the opt-out note
    expect(sendTenantEmail).toHaveBeenCalledWith(prisma, expect.objectContaining({ transactional: false, subject: "S" }));
    expect(prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ templateId: "t1", complaintId: "cmp1" }) });
  });
  it("falls back to email when the preferred SMS cannot be sent (GHL not connected)", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue(row());
    const res = await createMessageService(prisma).sendBest({ customerId: "c1", preferred: "SMS", body: "hi" });
    expect(res).toMatchObject({ status: "sent", channel: "EMAIL" });
    expect(sendGhlMessage).not.toHaveBeenCalled();
  });
  it("uses the default order without a preference", async () => {
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue(row());
    expect(await createMessageService(prisma).sendBest({ customerId: "c1", body: "hi" })).toMatchObject({ channel: "SMS" });
  });
  it("skips with a reason and sends nothing (opted out / nothing reachable)", async () => {
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue(row({ messagesOptOut: true }));
    expect(await createMessageService(prisma).sendBest({ customerId: "c1", body: "hi" })).toEqual({ status: "skipped", reason: "CUSTOMER_OPTED_OUT" });
    asMock(prisma.customer.findUnique).mockResolvedValue(row({ phone: null, email: null }));
    expect(await createMessageService(prisma).sendBest({ customerId: "c1", body: "hi" })).toEqual({ status: "skipped", reason: "NO_AVAILABLE_CHANNEL" });
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
  it("404s for an unknown customer", async () => {
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue(null);
    await expect(createMessageService(prisma).sendBest({ customerId: "x", body: "hi" })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("respectOptOut on prepare", () => {
  it("refuses an opted-out customer with 409 CUSTOMER_OPTED_OUT only when asked to respect it", async () => {
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue({ id: "c1", name: "J", phone: "07", email: "a@b.co", ghlContactId: "g", emailInvalidAt: null, messagesOptOut: true });
    await expect(createMessageService(prisma).prepare("c1", undefined, { respectOptOut: true })).rejects.toMatchObject({ statusCode: 409, code: "CUSTOMER_OPTED_OUT" });
    await expect(createMessageService(prisma).prepare("c1")).resolves.toMatchObject({ channel: "SMS" });
  });
});

describe("deliver() email options and explicit-channel broadcast edge cases", () => {
  it("passes cta, summary and attachments to the mailer", async () => {
    const prisma = makePrisma();
    const att = [{ filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("x") }];
    await createMessageService(prisma).deliver(
      { customer: { id: "c1", name: "J", phone: null, email: "j@x.co", ghlContactId: null }, channel: "EMAIL" as never, ctx: null },
      "body",
      { cta: { label: "Pay", url: "https://p.test" }, summary: [["A", "B"]], attachments: att, transactional: true }
    );
    expect(sendTenantEmail).toHaveBeenCalledWith(prisma, expect.objectContaining({ cta: { label: "Pay", url: "https://p.test" }, summary: [["A", "B"]], attachments: att, transactional: true }));
  });
  it("an explicit EMAIL broadcast skips a customer whose address bounced", async () => {
    const prisma = makePrisma();
    const res = await createMessageService(prisma).broadcast(
      [{ customer: { id: "c1", name: "C", phone: "07", email: "a@b.co", ghlContactId: null, emailInvalidAt: new Date(), messagesOptOut: false }, vars: {} } as never],
      { body: "hi", reason: "X", channel: "EMAIL" as never }
    );
    expect(res).toMatchObject({ skippedNoChannel: 1, sent: 0 });
    expect(res.recipients[0]).toMatchObject({ status: "skipped_no_channel", reason: "NO_AVAILABLE_CHANNEL" });
  });
});

describe("EMAIL delivery through send()", () => {
  it("never needs GHL: sends via the mailer, records SENT with the provider id, passes subject", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue({ id: "c1", name: "Jane", phone: null, email: "j@x.co", ghlContactId: null });
    const res = await createMessageService(prisma).send({ customerId: "c1", body: "hello", subject: "Hi there" });
    expect(res).toMatchObject({ status: "sent", channel: "EMAIL" });
    expect(sendGhlMessage).not.toHaveBeenCalled();
    expect(sendTenantEmail).toHaveBeenCalledWith(prisma, { to: "j@x.co", subject: "Hi there", bodyText: "hello", transactional: false, messageId: expect.any(String) });
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ channel: "EMAIL", customerId: "c1", body: "hello", externalId: "ses-1", deliveryStatus: "SENT" }),
    });
    expect(res.messageId).toBe("msg-1");
  });
  it("does not record a Message when the mailer refuses", async () => {
    sendTenantEmail.mockRejectedValue(Object.assign(new Error("paused"), { statusCode: 409, code: "CHANNEL_UNAVAILABLE" }));
    const prisma = makePrisma();
    asMock(prisma.customer.findUnique).mockResolvedValue({ id: "c1", name: "Jane", phone: null, email: "j@x.co", ghlContactId: null });
    await expect(createMessageService(prisma).send({ customerId: "c1", body: "hello" })).rejects.toMatchObject({ code: "CHANNEL_UNAVAILABLE" });
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});

describe("broadcast best-available channel", () => {
  const target = (id: string, over: Record<string, unknown> = {}) => ({
    customer: { id, name: `C ${id}`, phone: "07", email: "a@b.co", ghlContactId: `g${id}`, emailInvalidAt: null, messagesOptOut: false, ...over },
    vars: {},
  }) as never;
  const opts = { body: "Hello", reason: "WEATHER_HOLD" };

  it("without GHL: email customers get email, SMS-only customers are skipped with NO_AVAILABLE_CHANNEL, opt-outs with CUSTOMER_OPTED_OUT", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    const prisma = makePrisma();
    const res = await createMessageService(prisma).broadcast(
      [target("c1"), target("c2", { email: null }), target("c3", { messagesOptOut: true })],
      opts
    );
    expect(res).toMatchObject({ sent: 1, skippedNoChannel: 1, skippedOptedOut: 1, failed: 0 });
    expect(res.recipients).toEqual([
      expect.objectContaining({ customerId: "c1", status: "sent", channel: "EMAIL" }),
      expect.objectContaining({ customerId: "c2", status: "skipped_no_channel", reason: "NO_AVAILABLE_CHANNEL" }),
      expect.objectContaining({ customerId: "c3", status: "skipped_opted_out", reason: "CUSTOMER_OPTED_OUT" }),
    ]);
    expect(sendGhlMessage).not.toHaveBeenCalled();
  });
  it("with GHL and email both up the customer's SMS is preferred", async () => {
    const res = await createMessageService(makePrisma()).broadcast([target("c1")], opts);
    expect(res.recipients[0]).toMatchObject({ status: "sent", channel: "SMS" });
  });
  it("scheduled sends carry the resolved channel on the outbox row", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    const prisma = makePrisma();
    await createMessageService(prisma).broadcast([target("c1")], { ...opts, scheduledFor: new Date("2026-11-10T09:00:00Z") });
    expect(prisma.integrationOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: "message.send", payload: expect.objectContaining({ customerId: "c1", channel: "EMAIL", body: "Hello" }) }),
    });
  });
  it("uses the subject option for email", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    await createMessageService(makePrisma()).broadcast([target("c1")], { ...opts, subject: "Weather update" });
    expect(sendTenantEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ subject: "Weather update" }));
  });
});
