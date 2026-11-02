import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

const listInbox = vi.fn();
const markInboxRead = vi.fn();
vi.mock("../../services/message.service", async (orig) => ({
  ...(await orig<typeof import("../../services/message.service")>()),
  createMessageService: vi.fn(() => ({ listInbox, markInboxRead })),
}));

import { messagesRouter } from "../messages";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.tenantPrisma = {}; next(); });
  app.use("/messages", messagesRouter);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ error: err.message }));
  return app;
}

beforeEach(() => vi.clearAllMocks());

it("GET /messages/inbox forwards filters and paging", async () => {
  listInbox.mockResolvedValue({ rows: [], unreadCount: 0, pagination: {} });
  expect((await request(makeApp()).get("/messages/inbox?customerId=c1&unreadOnly=true&page=3&pageSize=10")).status).toBe(200);
  expect(listInbox).toHaveBeenLastCalledWith({ customerId: "c1", unreadOnly: true, page: 3, pageSize: 10 });
  await request(makeApp()).get("/messages/inbox");
  expect(listInbox).toHaveBeenLastCalledWith({ customerId: undefined, unreadOnly: false, page: 1, pageSize: 50 });
  expect((await request(makeApp()).get("/messages/inbox?page=0")).status).toBe(400);
});

it("POST /messages/inbox/read forwards ids and customerId", async () => {
  markInboxRead.mockResolvedValue({ updated: 2 });
  const res = await request(makeApp()).post("/messages/inbox/read").send({ ids: ["m1", "m2"], customerId: "c1" });
  expect(res.body).toEqual({ updated: 2 });
  expect(markInboxRead).toHaveBeenCalledWith({ ids: ["m1", "m2"], customerId: "c1" });
  await request(makeApp()).post("/messages/inbox/read").send({});
  expect(markInboxRead).toHaveBeenLastCalledWith({ ids: undefined, customerId: undefined });
});
