import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

const send = vi.fn();
const sendToRound = vi.fn();
vi.mock("../../services/message.service", async (orig) => ({
  ...(await orig<typeof import("../../services/message.service")>()),
  createMessageService: vi.fn(() => ({ send, sendToRound })),
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

describe("POST /messages/bulk", () => {
  it("broadcasts to a round", async () => {
    sendToRound.mockResolvedValue({ queued: 2 });
    const res = await request(makeApp()).post("/messages/bulk").send({ roundId: "r1", channel: "SMS", body: "hi" });
    expect(res.status).toBe(201);
    expect(sendToRound).toHaveBeenCalledWith({ roundId: "r1", channel: "SMS", body: "hi", excludePaymentHold: false });
  });
});
