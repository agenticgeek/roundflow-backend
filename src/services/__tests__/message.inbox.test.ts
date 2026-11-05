import { it, expect, vi } from "vitest";

vi.mock("../../integrations/ghl/api", () => ({
  getGhlToken: vi.fn(),
  createGhlContact: vi.fn(),
  sendGhlMessage: vi.fn(),
}));

import { createMessageService } from "../message.service";

function makePrisma() {
  return {
    message: {
      count: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2),
      findMany: vi.fn().mockResolvedValue([
        { id: "m1", customerId: "c1", customer: { id: "c1", name: "Jo" }, channel: "SMS", body: "Yes please", sentAt: new Date("2026-11-03T09:00:00Z"), createdAt: new Date("2026-11-03T09:00:01Z"), readAt: null },
        { id: "m2", customerId: null, customer: null, channel: "EMAIL", body: "Hello", sentAt: null, createdAt: new Date("2026-11-02T09:00:00Z"), readAt: new Date("2026-11-02T10:00:00Z") },
      ]),
      updateMany: vi.fn().mockResolvedValue({ count: 4 }),
    },
  } as any;
}

it("listInbox returns inbound replies with an unread flag, counts and pagination", async () => {
  const prisma = makePrisma();
  const out = await createMessageService(prisma).listInbox({ customerId: "c1", page: 2, pageSize: 2 });
  expect(prisma.message.findMany.mock.calls[0][0]).toMatchObject({
    where: { direction: "INBOUND", customerId: "c1" },
    skip: 2,
    take: 2,
  });
  expect(out.rows).toEqual([
    { id: "m1", customerId: "c1", customerName: "Jo", channel: "SMS", body: "Yes please", receivedAt: new Date("2026-11-03T09:00:00Z"), unread: true },
    { id: "m2", customerId: null, customerName: null, channel: "EMAIL", body: "Hello", receivedAt: new Date("2026-11-02T09:00:00Z"), unread: false },
  ]);
  expect(out.unreadCount).toBe(2);
  expect(out.pagination).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
});

it("listInbox unreadOnly filters on readAt and works without a customer filter", async () => {
  const prisma = makePrisma();
  await createMessageService(prisma).listInbox({ unreadOnly: true, page: 1, pageSize: 50 });
  expect(prisma.message.findMany.mock.calls[0][0].where).toEqual({ direction: "INBOUND", readAt: null });
});

it("markInboxRead marks by ids and/or customer, and needs one of them", async () => {
  const prisma = makePrisma();
  const svc = createMessageService(prisma);
  expect(await svc.markInboxRead({ ids: ["m1"] })).toEqual({ updated: 4 });
  expect(prisma.message.updateMany.mock.calls[0][0].where).toEqual({ direction: "INBOUND", readAt: null, id: { in: ["m1"] } });
  await svc.markInboxRead({ customerId: "c1" });
  expect(prisma.message.updateMany.mock.calls[1][0].where).toEqual({ direction: "INBOUND", readAt: null, customerId: "c1" });
  await expect(svc.markInboxRead({})).rejects.toMatchObject({ statusCode: 400 });
  await expect(svc.markInboxRead({ ids: [] })).rejects.toMatchObject({ statusCode: 400 });
});
