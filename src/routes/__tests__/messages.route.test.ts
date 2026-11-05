import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

const send = vi.fn();
const sendToRound = vi.fn();
const listRoundRecipients = vi.fn();
vi.mock("../../services/message.service", async (orig) => ({
  ...(await orig<typeof import("../../services/message.service")>()),
  createMessageService: vi.fn(() => ({ send, sendToRound, listRoundRecipients })),
}));

import { messagesRouter } from "../messages";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.tenantPrisma = {}; next(); });
  app.use("/messages", messagesRouter);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ error: err.message, code: err.code }));
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe("POST /messages/send", () => {
  it("channel is optional (auto) and normalised when given", async () => {
    send.mockResolvedValue({ status: "sent", messageId: "m1", channel: "SMS" });
    const res = await request(makeApp()).post("/messages/send").send({ customerId: "c1", body: "hi" });
    expect(res.status).toBe(201);
    expect(send).toHaveBeenCalledWith({ propertyId: undefined, customerId: "c1", channel: undefined, body: "hi" });
    await request(makeApp()).post("/messages/send").send({ propertyId: "p1", channel: "email", body: "hi" });
    expect(send).toHaveBeenLastCalledWith({ propertyId: "p1", customerId: undefined, channel: "EMAIL", body: "hi" });
  });

  it("400s on an unknown channel", async () => {
    const res = await request(makeApp()).post("/messages/send").send({ customerId: "c1", channel: "fax", body: "hi" });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("GET /messages/bulk/recipients", () => {
  it("lists the server-confirmed recipients for the round and channel", async () => {
    listRoundRecipients.mockResolvedValue({ total: 1, reachable: 1, recipients: [] });
    const res = await request(makeApp()).get("/messages/bulk/recipients?roundId=r1&channel=whatsapp&excludePaymentHold=true");
    expect(res.status).toBe(200);
    expect(listRoundRecipients).toHaveBeenCalledWith({ roundId: "r1", channel: "whatsapp", excludePaymentHold: true });
    await request(makeApp()).get("/messages/bulk/recipients?roundId=r1");
    expect(listRoundRecipients).toHaveBeenLastCalledWith({ roundId: "r1", channel: undefined, excludePaymentHold: false });
  });

  it("requires roundId", async () => {
    expect((await request(makeApp()).get("/messages/bulk/recipients")).status).toBe(400);
  });
});

describe("POST /messages/bulk", () => {
  it("passes an explicit customerIds subset, and validates it", async () => {
    sendToRound.mockResolvedValue({ queued: 1 });
    await request(makeApp()).post("/messages/bulk").send({ roundId: "r1", channel: "SMS", body: "hi", customerIds: ["c1", "c2"] });
    expect(sendToRound).toHaveBeenCalledWith(expect.objectContaining({ customerIds: ["c1", "c2"] }));
    const bad = await request(makeApp()).post("/messages/bulk").send({ roundId: "r1", channel: "SMS", body: "hi", customerIds: "c1" });
    expect(bad.status).toBe(400);
  });

  it("broadcasts to a round now, passing the optional template", async () => {
    sendToRound.mockResolvedValue({ queued: 2, sent: 2 });
    const res = await request(makeApp()).post("/messages/bulk").send({ roundId: "r1", channel: "SMS", body: "hi", templateId: "t1" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ queued: 2, sent: 2 });
    expect(sendToRound).toHaveBeenCalledWith({ roundId: "r1", channel: "SMS", body: "hi", excludePaymentHold: false, templateId: "t1", scheduledFor: undefined });
  });

  it("passes a future scheduledFor through as a Date", async () => {
    sendToRound.mockResolvedValue({ queued: 1 });
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await request(makeApp()).post("/messages/bulk").send({ roundId: "r1", channel: "SMS", body: "hi", scheduledFor: at });
    expect(sendToRound).toHaveBeenCalledWith(expect.objectContaining({ templateId: null, scheduledFor: new Date(at) }));
  });

  it("rejects an unparseable, past or too-distant scheduledFor", async () => {
    const send = (scheduledFor: unknown) =>
      request(makeApp()).post("/messages/bulk").send({ roundId: "r1", channel: "SMS", body: "hi", scheduledFor });
    expect((await send("tomorrow-ish")).status).toBe(400);
    expect((await send(12345)).status).toBe(400);
    expect((await send(new Date(Date.now() - 1000).toISOString())).body.error).toMatch(/in the future/);
    expect((await send(new Date(Date.now() + 200 * 86_400_000).toISOString())).body.error).toMatch(/within 90 days/);
    expect(sendToRound).not.toHaveBeenCalled();
  });
});
