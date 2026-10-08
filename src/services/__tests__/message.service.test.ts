import { it, expect, vi, beforeEach } from "vitest";

vi.mock("../../integrations/ghl/api", () => ({
  getGhlToken: vi.fn(),
  createGhlContact: vi.fn(),
  sendGhlMessage: vi.fn(),
}));

import { getGhlToken, createGhlContact, sendGhlMessage } from "../../integrations/ghl/api";
import { createMessageService } from "../message.service";

function makePrisma() {
  return {
    property: { findUnique: vi.fn(), findMany: vi.fn() },
    customer: { findUnique: vi.fn(), update: vi.fn() },
  } as unknown as Parameters<typeof createMessageService>[0];
}

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

it("rejects an unknown channel with 400", async () => {
  const svc = createMessageService(makePrisma());
  await expect(svc.send({ customerId: "c1", channel: "fax", body: "hi" }))
    .rejects.toMatchObject({ statusCode: 400 });
});

it("throws 409 when GHL is not connected", async () => {
  (getGhlToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  const svc = createMessageService(makePrisma());
  await expect(svc.send({ customerId: "c1", channel: "sms", body: "hi" }))
    .rejects.toMatchObject({ statusCode: 409 });
});

it("sends via an existing contact without creating one", async () => {
  (getGhlToken as ReturnType<typeof vi.fn>).mockResolvedValue({ accessToken: "t", locationId: "l" });
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "c1", name: "Jane", phone: null, email: null, ghlContactId: "gc1",
  });
  const res = await createMessageService(prisma).send({ customerId: "c1", channel: "sms", body: "hi" });
  expect(res).toEqual({ status: "sent" });
  expect(sendGhlMessage).toHaveBeenCalledWith({ accessToken: "t", locationId: "l" }, "gc1", "hi", "SMS");
  expect(createGhlContact).not.toHaveBeenCalled();
});

it("creates and persists a contact when the customer has none, then sends", async () => {
  (getGhlToken as ReturnType<typeof vi.fn>).mockResolvedValue({ accessToken: "t", locationId: "l" });
  (createGhlContact as ReturnType<typeof vi.fn>).mockResolvedValue("newC");
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "c1", name: "Jane", phone: null, email: null, ghlContactId: null,
  });
  await createMessageService(prisma).send({ customerId: "c1", channel: "email", body: "yo" });
  expect(createGhlContact).toHaveBeenCalled();
  expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { ghlContactId: "newC" } });
  expect(sendGhlMessage).toHaveBeenCalledWith(expect.anything(), "newC", "yo", "EMAIL");
});

it("resolves customer from propertyId", async () => {
  (getGhlToken as ReturnType<typeof vi.fn>).mockResolvedValue({ accessToken: "t", locationId: "l" });
  const prisma = makePrisma();
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ customerId: "c9" });
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "c9", name: "Al", phone: null, email: null, ghlContactId: "gc9",
  });
  await createMessageService(prisma).send({ propertyId: "p1", channel: "sms", body: "hey" });
  expect(prisma.property.findUnique).toHaveBeenCalledWith({ where: { id: "p1" }, select: { customerId: true } });
  expect(sendGhlMessage).toHaveBeenCalledWith(expect.anything(), "gc9", "hey", "SMS");
});

it("sendToRound dedupes customers across properties and counts successes", async () => {
  (getGhlToken as ReturnType<typeof vi.fn>).mockResolvedValue({ accessToken: "t", locationId: "l" });
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

it("sendToRound skips customers whose round properties are all on payment hold", async () => {
  (getGhlToken as ReturnType<typeof vi.fn>).mockResolvedValue({ accessToken: "t", locationId: "l" });
  const prisma = makePrisma();
  asMock(prisma.property.findMany).mockResolvedValue([
    { customer: { id: "c1", name: "A", phone: null, email: null, ghlContactId: "g1" }, visits: [{ id: "v1" }] },
    { customer: { id: "c2", name: "B", phone: null, email: null, ghlContactId: "g2" }, visits: [] },
  ]);
  const res = await createMessageService(prisma).sendToRound({ roundId: "r1", channel: "sms", body: "hi", excludePaymentHold: true });
  expect(res).toEqual({ queued: 1 });
  expect(sendGhlMessage).toHaveBeenCalledWith(expect.anything(), "g2", "hi", "SMS");
});
