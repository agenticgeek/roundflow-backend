import { it, expect, vi, beforeEach, describe } from "vitest";

vi.mock("../../integrations/ghl/api", () => ({
  getGhlToken: vi.fn(),
  createGhlContact: vi.fn(),
  sendGhlMessage: vi.fn(),
}));

import { getGhlToken, createGhlContact, sendGhlMessage } from "../../integrations/ghl/api";
import { createMessageService, optOutboundChannel, resolveChannel } from "../message.service";

function makePrisma() {
  return {
    property: { findUnique: vi.fn(), findMany: vi.fn() },
    customer: { findUnique: vi.fn(), update: vi.fn() },
    message: { create: vi.fn().mockResolvedValue({ id: "msg-1" }) },
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

describe("sendToRound", () => {
  it("409s when GHL is not connected", async () => {
    asMock(getGhlToken).mockResolvedValue(null);
    await expect(createMessageService(makePrisma()).sendToRound({ roundId: "r1", channel: "sms", body: "hi", excludePaymentHold: false }))
      .rejects.toMatchObject({ statusCode: 409, code: "GHL_NOT_CONNECTED" });
  });

  it("dedupes customers across properties and counts successes", async () => {
    const prisma = makePrisma();
    const c1 = { id: "c1", name: "A", phone: null, email: null, ghlContactId: "g1" };
    asMock(prisma.property.findMany).mockResolvedValue([
      { customer: c1, visits: [] },
      { customer: c1, visits: [] }, // same customer, second property
      { customer: { id: "c2", name: "B", phone: null, email: null, ghlContactId: "g2" }, visits: [] },
    ]);
    const res = await createMessageService(prisma).sendToRound({ roundId: "r1", channel: "sms", body: "hi", excludePaymentHold: false });
    expect(res).toEqual({ queued: 2 });
    expect(sendGhlMessage).toHaveBeenCalledTimes(2);
  });

  it("skips customers whose round properties are all on payment hold", async () => {
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([
      { customer: { id: "c1", name: "A", phone: null, email: null, ghlContactId: "g1" }, visits: [{ id: "v1" }] },
      { customer: { id: "c2", name: "B", phone: null, email: null, ghlContactId: "g2" }, visits: [] },
    ]);
    const res = await createMessageService(prisma).sendToRound({ roundId: "r1", channel: "sms", body: "hi", excludePaymentHold: true });
    expect(res).toEqual({ queued: 1 });
    expect(sendGhlMessage).toHaveBeenCalledWith(expect.anything(), "g2", "hi", "SMS");
  });

  it("logs and skips a per-recipient failure", async () => {
    asMock(sendGhlMessage).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(null);
    const prisma = makePrisma();
    asMock(prisma.property.findMany).mockResolvedValue([
      { customer: { id: "c1", name: "A", phone: null, email: null, ghlContactId: "g1" }, visits: [] },
      { customer: { id: "c2", name: "B", phone: null, email: null, ghlContactId: "g2" }, visits: [] },
    ]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await createMessageService(prisma).sendToRound({ roundId: "r1", channel: "sms", body: "hi", excludePaymentHold: false });
    expect(res).toEqual({ queued: 1 });
    err.mockRestore();
  });
});
