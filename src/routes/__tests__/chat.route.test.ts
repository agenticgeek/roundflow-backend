import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { makeChatTenant } from "../../test/chat-fake";

// Real chat.ts router + real requireBusinessAccess (technicians must be refused)
// over an in-memory tenant; only auth/tenant resolution and the public Profile
// lookup / notifications are faked.

const profileFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { profile: { findMany: (...a: unknown[]) => profileFindMany(...a) } } }));
const notificationCreate = vi.fn();
vi.mock("../../mobile/services/notification.service", () => ({
  createNotificationService: () => ({ create: (...a: unknown[]) => notificationCreate(...a) }),
}));
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { supabaseUserId: `sb-${req.header("x-profile") ?? "admin1"}` };
    next();
  },
}));
vi.mock("../../mobile/media-urls", () => ({
  signChatRows: async (_t: string, rows: Array<{ photoUrls?: string[] }>) =>
    rows.map((r) => ({ ...r, photoSignedUrls: (r.photoUrls ?? []).map((u) => `${u}?signed`) })),
}));

let tenants: Record<string, ReturnType<typeof makeChatTenant>>;

vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    const id = req.header("x-profile") ?? "admin1";
    const role = id.startsWith("tech") ? "TECHNICIAN" : id.startsWith("mgr") ? "MANAGER" : "ADMIN";
    const tenantId = req.header("x-tenant") ?? "tenant-1";
    req.profile = { id, role, tenantId, name: `Name ${id}` };
    req.tenantPrisma = tenants[tenantId].tp;
    next();
  },
}));

import { chatRouter } from "../chat";
import { errorHandler } from "../../lib/error-handler";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/chat", chatRouter);
  app.use(errorHandler);
  return app;
}

const tech = { technician: { id: "t1", name: "Sam", active: true, profileId: "tech1" } };

beforeEach(() => {
  vi.clearAllMocks();
  profileFindMany.mockResolvedValue([{ id: "admin1", name: "Office Olive" }, { id: "tech1", name: "Sam" }]);
  notificationCreate.mockResolvedValue({});
  tenants = {
    "tenant-1": makeChatTenant({
      rounds: [{ id: "r1", name: "Alnwick Mon" }, { id: "r2", name: "Alnwick Tue" }],
      roundTechnicians: [{ roundId: "r1", technicianId: "t1", ...tech }],
    }),
    "tenant-2": makeChatTenant({ rounds: [{ id: "r9", name: "Other tenant round" }] }),
  };
});

const as = (profile: string, tenant = "tenant-1") => ({ "x-profile": profile, "x-tenant": tenant });
const post = (path: string, body: object, profile = "admin1", tenant = "tenant-1") =>
  request(makeApp()).post(path).set(as(profile, tenant)).send(body);
const get = (path: string, profile = "admin1", tenant = "tenant-1") => request(makeApp()).get(path).set(as(profile, tenant));

it("technicians cannot reach any /chat endpoint (403) and nothing is written", async () => {
  for (const [method, path] of [
    ["get", "/chat/threads"],
    ["get", "/chat/unread-count"],
    ["get", "/chat/rounds/r1/messages"],
    ["post", "/chat/rounds/r1/messages"],
    ["post", "/chat/rounds/r1/read"],
  ] as const) {
    const res = await (request(makeApp()) as any)[method](path).set(as("tech1")).send({ text: "hi" });
    expect(res.status).toBe(403);
  }
  expect(tenants["tenant-1"].messages).toHaveLength(0);
});

it("managers and admins can use the chat", async () => {
  expect((await get("/chat/threads", "mgr1")).status).toBe(200);
  expect((await post("/chat/rounds/r1/messages", { text: "hi" }, "mgr1")).status).toBe(201);
});

it("office send: senderRole OFFICE, trimmed text, notifies the round's technicians, listed oldest first", async () => {
  const sent = await post("/chat/rounds/r1/messages", { text: "  Gate is open today  " });
  expect(sent.status).toBe(201);
  expect(sent.body).toMatchObject({ roundId: "r1", senderRole: "OFFICE", body: "Gate is open today", type: "TEXT", isMine: true, senderName: "Name admin1", photoSignedUrls: [] });
  expect(notificationCreate).toHaveBeenCalledWith("tech1", "CHAT", "New message from the office", "Gate is open today");

  await post("/chat/rounds/r1/messages", { text: "second" });
  const list = await get("/chat/rounds/r1/messages");
  expect(list.status).toBe(200);
  expect(list.body.messages.map((m: any) => m.body)).toEqual(["Gate is open today", "second"]);
  expect(list.body.hasMore).toBe(false);
  expect(list.body.messages[0]).toMatchObject({ senderName: "Office Olive", senderRole: "OFFICE", isMine: true });
});

it("technician reply is visible to the office, and the technician sees the office reply via since", async () => {
  const { tp } = tenants["tenant-1"];
  await tp.chatMessage.create({ data: { roundId: "r1", senderProfileId: "tech1", senderRole: "TECHNICIAN", type: "TEXT", body: "Dog loose", photoUrls: [] } });
  const first = await get("/chat/rounds/r1/messages");
  expect(first.body.messages).toHaveLength(1);
  expect(first.body.messages[0]).toMatchObject({ senderRole: "TECHNICIAN", senderName: "Sam", isMine: false });
  const cursor = first.body.messages[0].createdAt;

  await post("/chat/rounds/r1/messages", { text: "Skip the back garden" });
  const newer = await get(`/chat/rounds/r1/messages?since=${encodeURIComponent(cursor)}`);
  expect(newer.body.messages.map((m: any) => m.body)).toEqual(["Skip the back garden"]);
});

it("pages with limit/before and reports hasMore; invalid query params are 400", async () => {
  for (let i = 1; i <= 5; i++) await post("/chat/rounds/r1/messages", { text: `m${i}` });
  const newest = await get("/chat/rounds/r1/messages?limit=2");
  expect(newest.body.messages.map((m: any) => m.body)).toEqual(["m4", "m5"]);
  expect(newest.body.hasMore).toBe(true);
  const older = await get(`/chat/rounds/r1/messages?limit=2&before=${encodeURIComponent(newest.body.messages[0].createdAt)}`);
  expect(older.body.messages.map((m: any) => m.body)).toEqual(["m2", "m3"]);
  const oldest = await get(`/chat/rounds/r1/messages?limit=2&before=${encodeURIComponent(older.body.messages[0].createdAt)}`);
  expect(oldest.body).toMatchObject({ hasMore: false });
  expect(oldest.body.messages.map((m: any) => m.body)).toEqual(["m1"]);
  const forward = await get(`/chat/rounds/r1/messages?limit=2&since=${encodeURIComponent(oldest.body.messages[0].createdAt)}`);
  expect(forward.body.messages.map((m: any) => m.body)).toEqual(["m2", "m3"]);
  expect(forward.body.hasMore).toBe(true);

  for (const qs of ["limit=0", "limit=abc", "since=nope", "before=nope", "since=2026-01-01T00:00:00Z&before=2026-01-02T00:00:00Z"]) {
    expect((await get(`/chat/rounds/r1/messages?${qs}`)).status).toBe(400);
  }
  expect((await get("/chat/rounds/r1/messages?limit=9999")).status).toBe(200); // capped at 200, not rejected
});

it("duplicate clientMsgId returns the existing message (200) and does not notify twice", async () => {
  const a = await post("/chat/rounds/r1/messages", { text: "once", clientMsgId: "c-1" });
  const b = await post("/chat/rounds/r1/messages", { text: "once", clientMsgId: "c-1" });
  expect(a.status).toBe(201);
  expect(b.status).toBe(200);
  expect(b.body.id).toBe(a.body.id);
  expect(tenants["tenant-1"].messages).toHaveLength(1);
  expect(notificationCreate).toHaveBeenCalledTimes(1);
  // same id from a different sender is a different message
  const c = await post("/chat/rounds/r1/messages", { text: "once", clientMsgId: "c-1" }, "mgr1");
  expect(c.status).toBe(201);
});

it("validates the body: text required/2000 max, photo prefix, clientMsgId length, unknown round", async () => {
  expect((await post("/chat/rounds/r1/messages", {})).status).toBe(400);
  expect((await post("/chat/rounds/r1/messages", { text: "   " })).status).toBe(400);
  const long = await post("/chat/rounds/r1/messages", { text: "x".repeat(2001) });
  expect(long.status).toBe(400);
  expect(long.body.code).toBe("CHAT_TEXT_TOO_LONG");
  expect((await post("/chat/rounds/r1/messages", { text: "x".repeat(2000) })).status).toBe(201);
  expect((await post("/chat/rounds/r1/messages", { text: "hi", clientMsgId: "c".repeat(101) })).status).toBe(400);
  expect((await post("/chat/rounds/r1/messages", { text: "hi", clientMsgId: 5 })).status).toBe(400);
  expect((await post("/chat/rounds/r1/messages", { photoUrls: ["tenant-2/chat/r1/a.jpg"] })).status).toBe(400);
  expect((await post("/chat/rounds/r1/messages", { photoUrls: ["tenant-1/chat/r2/a.jpg"] })).status).toBe(400);
  expect((await post("/chat/rounds/r1/messages", { photoUrls: ["tenant-1/chat/r1/../r2/a.jpg"] })).status).toBe(400);
  expect((await post("/chat/rounds/r1/messages", { photoUrls: Array.from({ length: 11 }, (_, i) => `tenant-1/chat/r1/${i}.jpg`) })).status).toBe(400);
  expect((await post("/chat/rounds/nope/messages", { text: "hi" })).status).toBe(404);
  expect((await get("/chat/rounds/nope/messages")).status).toBe(404);
  expect((await post("/chat/rounds/nope/read", {})).status).toBe(404);
});

it("photo-only messages are allowed when the urls belong to this tenant's round chat", async () => {
  const res = await post("/chat/rounds/r1/messages", { photoUrls: ["tenant-1/chat/r1/a.jpg"] });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ type: "PHOTOS", body: null, photoUrls: ["tenant-1/chat/r1/a.jpg"], photoSignedUrls: ["tenant-1/chat/r1/a.jpg?signed"] });
  expect(notificationCreate.mock.calls[0][3]).toBe("Sent you photos");
  const withText = await post("/chat/rounds/r1/messages", { text: "look", photoUrls: ["tenant-1/chat/r1/b.jpg"] });
  expect(withText.body.body).toBe("look");
});

it("tenant isolation: another tenant's round is 404 and its messages never leak", async () => {
  await post("/chat/rounds/r9/messages", { text: "hello tenant 2" }, "admin2", "tenant-2");
  expect((await get("/chat/rounds/r9/messages")).status).toBe(404);
  expect((await post("/chat/rounds/r9/messages", { text: "x" })).status).toBe(404);
  expect(tenants["tenant-1"].messages).toHaveLength(0);
  expect((await get("/chat/threads")).body.threads).toEqual([]);
  expect((await get("/chat/rounds/r9/messages", "admin2", "tenant-2")).body.messages).toHaveLength(1);
});

it("threads: only rounds with messages, newest activity first, with technicians, last message and unread", async () => {
  const { tp } = tenants["tenant-1"];
  expect((await get("/chat/threads")).body).toEqual({ threads: [] });
  await tp.chatMessage.create({ data: { roundId: "r1", senderProfileId: "tech1", senderRole: "TECHNICIAN", type: "TEXT", body: "t1", photoUrls: [] } });
  await tp.chatMessage.create({ data: { roundId: "r2", senderProfileId: "tech9", senderRole: "TECHNICIAN", type: "TEXT", body: "r2 first", photoUrls: [] } });
  await tp.chatMessage.create({ data: { roundId: "r2", senderProfileId: "tech9", senderRole: "TECHNICIAN", type: "TEXT", body: "r2 last", photoUrls: [] } });
  const res = await get("/chat/threads");
  expect(res.body.threads.map((t: any) => [t.roundId, t.unreadCount, t.lastMessage.body])).toEqual([
    ["r2", 2, "r2 last"],
    ["r1", 1, "t1"],
  ]);
  expect(res.body.threads[1]).toMatchObject({ roundName: "Alnwick Mon", technicians: [{ id: "t1", name: "Sam", active: true }] });
  expect(res.body.threads[0].technicians).toEqual([]);
});

it("unread counts are per user: read clears yours only; own messages never count", async () => {
  const { tp } = tenants["tenant-1"];
  await tp.chatMessage.create({ data: { roundId: "r1", senderProfileId: "tech1", senderRole: "TECHNICIAN", type: "TEXT", body: "a", photoUrls: [] } });
  await tp.chatMessage.create({ data: { roundId: "r2", senderProfileId: "tech1", senderRole: "TECHNICIAN", type: "TEXT", body: "b", photoUrls: [] } });
  await post("/chat/rounds/r1/messages", { text: "my own reply" }); // admin1's own message: not unread for admin1
  expect((await get("/chat/unread-count")).body).toEqual({
    total: 2,
    rounds: [{ roundId: "r1", unread: 1 }, { roundId: "r2", unread: 1 }],
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(tenants["tenant-1"].lastTs() + 5000));
  const read = await post("/chat/rounds/r1/read", {});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({ roundId: "r1" });
  expect((await get("/chat/unread-count")).body).toEqual({ total: 1, rounds: [{ roundId: "r2", unread: 1 }] });
  // another office user still has both unread
  expect((await get("/chat/unread-count", "mgr1")).body.total).toBe(3);
  // a new technician message after the read marker shows up again; re-reading updates the marker
  vi.setSystemTime(new Date(Date.now() + 1000));
  await tp.chatMessage.create({ data: { roundId: "r1", senderProfileId: "tech1", senderRole: "TECHNICIAN", type: "TEXT", body: "c", photoUrls: [] } });
  expect((await get("/chat/unread-count")).body.total).toBe(2);
  vi.setSystemTime(new Date(Date.now() + 5000));
  await post("/chat/rounds/r1/read", {});
  expect((await get("/chat/unread-count")).body.total).toBe(1);
  vi.useRealTimers();
});

it("a failing notification never fails the send", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  notificationCreate.mockRejectedValue(new Error("push down"));
  const res = await post("/chat/rounds/r1/messages", { text: "still sent" });
  expect(res.status).toBe(201);
  expect(err).toHaveBeenCalled();
  // a thrown lookup (e.g. DB) is also swallowed
  const broken = tenants["tenant-1"].tp;
  broken.roundTechnician.findMany = async () => {
    throw new Error("db");
  };
  expect((await post("/chat/rounds/r1/messages", { text: "again" })).status).toBe(201);
  err.mockRestore();
});

it("notifies technicians holding an open visit on the round, once each", async () => {
  tenants["tenant-1"].tp.visit.findMany = async () => [{ technician: { profileId: "tech1" } }, { technician: { profileId: "tech7" } }, { technician: null }];
  await post("/chat/rounds/r1/messages", { text: "hi" });
  expect(notificationCreate.mock.calls.map((c) => c[0]).sort()).toEqual(["tech1", "tech7"]);
});
