import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, res: any, next: any) => (req.headers["x-role"] ? next() : res.status(401).json({ error: "Unauthorized" })),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: req.headers["x-profile"] ?? "p1", role: req.headers["x-role"], tenantId: "t1" };
    req.tenantPrisma = (globalThis as any).__flo_tp;
    next();
  },
}));

import { createFloRouter, floRouter } from "../flo";
import { errorHandler } from "../../lib/error-handler";
import { requestId } from "../../lib/request-id";
import { fakeFloDb, skip, type FakeFloDb } from "../../services/flo/__tests__/fake-flo-db";
import { answerTurn, failTurn, hangTurn, scripted, toolTurn, type Turn } from "../../services/flo/__tests__/orchestrator.helpers";
import { ProviderError } from "../../integrations/anthropic/client";
import { SUGGESTION_GROUPS } from "../../services/flo/declines";
import type { FloRouterOptions } from "../flo";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const ENV = { ANTHROPIC_API_KEY: "test-key", RATE_LIMIT_DISABLED: "true" } as unknown as NodeJS.ProcessEnv;
const GOOD: Turn[] = [
  toolTurn({ id: "t1", name: "list_skipped_visits" }),
  answerTurn('<intro>You have 2 skipped visits.</intro><block>{"type":"table","sourceId":"r1","columns":["date","reason"]}</block><insight>Round 7 had skips.</insight><follow_up>Show complaints</follow_up>'),
];

let db: FakeFloDb;
beforeEach(() => {
  db = fakeFloDb();
  db.visits = [skip("2026-11-05", "No access"), skip("2026-11-03", "Dog in garden")];
  (globalThis as any).__flo_tp = db.tp;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function appWith(turns: Turn[] = GOOD, over: Partial<FloRouterOptions> & { verdict?: string } = {}) {
  const s = scripted(turns, over.verdict ?? "IN_SCOPE");
  const app = express();
  app.use(requestId());
  app.use(express.json());
  app.use("/flo", createFloRouter({ env: ENV, deps: { provider: s.provider, now: () => NOW }, ...over }));
  app.use(errorHandler);
  return { app, s };
}

interface Frame {
  event: string;
  data: any;
}
function parseSse(text: string): { frames: Frame[]; comments: string[] } {
  const frames: Frame[] = [];
  const comments: string[] = [];
  for (const block of text.split("\n\n").filter(Boolean)) {
    if (block.startsWith(":")) {
      comments.push(block);
      continue;
    }
    const event = /^event: (.+)$/m.exec(block)![1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)![1]);
    frames.push({ event, data });
  }
  return { frames, comments };
}

const as = (role: string, profile = "p1") => ({ "x-role": role, "x-profile": profile });
const post = (app: express.Express, body: unknown, role = "ADMIN", extra: Record<string, string> = {}) =>
  request(app).post("/flo/chat").set({ ...as(role), ...extra }).send(body as object);

describe("access control: ADMIN only", () => {
  const six: Array<[string, string, string]> = [
    ["get", "/flo/status", ""],
    ["get", "/flo/suggestions", ""],
    ["post", "/flo/chat", "x"],
    ["get", "/flo/conversations", ""],
    ["get", "/flo/conversations/c1", ""],
    ["delete", "/flo/conversations/c1", ""],
  ];

  it.each(six)("%s %s: anonymous 401, TECHNICIAN 403, MANAGER 403 ADMIN_ONLY", async (method, path) => {
    const { app } = appWith();
    const call = (headers: Record<string, string>) => (request(app) as any)[method](path).set(headers).send({ message: "hi" });
    expect((await call({})).status).toBe(401);
    const tech = await call(as("TECHNICIAN"));
    expect(tech.status).toBe(403);
    const manager = await call(as("MANAGER"));
    expect(manager.status).toBe(403);
    expect(manager.body.code).toBe("ADMIN_ONLY");
    expect(db.conversations).toHaveLength(0);
    expect(db.calls).toEqual([]);
  });
});

describe("GET /flo/status and /flo/suggestions", () => {
  it("status for an ADMIN, and enabled=false when the key is unset or the kill switch is on", async () => {
    const { app } = appWith();
    const res = await request(app).get("/flo/status").set(as("ADMIN"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      modes: [
        { key: "THOROUGH", label: "Thorough", description: expect.any(String) },
        { key: "BALANCED", label: "Balanced", description: expect.any(String) },
        { key: "QUICK", label: "Quick", description: expect.any(String) },
      ],
      dailyRemaining: 100,
    });
    const off = appWith(GOOD, { env: { RATE_LIMIT_DISABLED: "true" } as never });
    expect((await request(off.app).get("/flo/status").set(as("ADMIN"))).body.enabled).toBe(false);
    const killed = appWith(GOOD, { env: { ANTHROPIC_API_KEY: "k", FLO_ENABLED: "false" } as never });
    expect((await request(killed.app).get("/flo/status").set(as("ADMIN"))).body.enabled).toBe(false);
  });

  it("suggestions are { groups: [{ area, questions }] }", async () => {
    const res = await request(appWith().app).get("/flo/suggestions").set(as("ADMIN"));
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(SUGGESTION_GROUPS.length);
    expect(res.body.groups[0]).toEqual({ area: "Today", questions: expect.arrayContaining([expect.any(String)]) });
  });
});

describe("POST /flo/chat: the stream", () => {
  it("ADMIN gets 200 text/event-stream with the proxy-safe headers and the events in order", async () => {
    const { app } = appWith();
    const res = await post(app, { message: "Show the skipped visits this month", mode: "BALANCED" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(res.headers.connection).toBe("keep-alive");
    expect(res.headers["idempotent-replay"]).toBeUndefined();
    const { frames, comments } = parseSse(res.text);
    expect(comments[0]).toBe(": ping");
    expect(frames.map((f) => f.event)).toEqual(["start", "status", "status", "text", "block", "text", "follow_ups", "done"]);
    const start = frames[0].data;
    expect(start.mode).toBe("BALANCED");
    expect(frames[3].data).toEqual({ target: "intro", index: 0, text: "You have 2 skipped visits." });
    expect(frames[4].data.block).toMatchObject({ type: "table", sourceId: "r1", rows: [{ date: "2026-11-05", reason: "No access" }, { date: "2026-11-03", reason: "Dog in garden" }] });
    expect(frames[5].data).toEqual({ target: "insight", index: 0, text: "Round 7 had skips." });
    const message = frames[7].data.message;
    expect(message.id).toBe(start.messageId);
    expect(message).toMatchObject({ role: "ASSISTANT", status: "OK", declined: null, warnings: [] });

    // GET /flo/conversations/{id} returns the same final message, and the USER message with text.
    const got = await request(app).get(`/flo/conversations/${start.conversationId}`).set(as("ADMIN"));
    expect(got.status).toBe(200);
    expect(got.body.title).toBe("Show the skipped visits this month");
    expect(got.body.messages[0]).toMatchObject({ role: "USER", text: "Show the skipped visits this month" });
    expect(got.body.messages[1]).toEqual(message);
  });

  it("an out-of-scope question is a normal 200 stream with declined + done, not an error", async () => {
    const { app, s } = appWith(GOOD, { verdict: "OUT_OF_SCOPE" });
    const res = await post(app, { message: "What is the capital of France?" });
    expect(res.status).toBe(200);
    const { frames } = parseSse(res.text);
    expect(frames.map((f) => f.event)).toEqual(["start", "declined", "done"]);
    expect(frames[1].data).toEqual({ reason: "OUT_OF_SCOPE", text: expect.stringContaining("only answer questions about your own RoundFlow data"), suggestions: expect.any(Array) });
    expect(frames[2].data.message).toMatchObject({ status: "DECLINED", answer: null });
    expect(s.streamCalls).toHaveLength(0);
  });

  it("Idempotency-Key: a repeat replays start + done with Idempotent-Replay: true (X-Idempotency-Key accepted too)", async () => {
    const { app, s } = appWith();
    const first = await post(app, { message: "Show skips" }, "ADMIN", { "Idempotency-Key": "k-1" });
    const again = await post(app, { message: "Show skips" }, "ADMIN", { "X-Idempotency-Key": "k-1" });
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replay"]).toBe("true");
    const a = parseSse(first.text).frames;
    const b = parseSse(again.text).frames;
    expect(b.map((f) => f.event)).toEqual(["start", "done"]);
    expect(b[1].data.message).toEqual(a[a.length - 1].data.message);
    expect(s.streamCalls).toHaveLength(2);
  });

  it("failures after the stream started are error events with a retryable flag (502 / 504 / 422 equivalents)", async () => {
    const provider = appWith([toolTurn({ id: "t", name: "list_skipped_visits" }), failTurn(new ProviderError("PROVIDER_UNAVAILABLE", "x", 529, true))]);
    const r1 = parseSse((await post(provider.app, { message: "Show skips" })).text).frames;
    expect(r1[r1.length - 1]).toEqual({ event: "error", data: { code: "FLO_PROVIDER_ERROR", message: expect.any(String), retryable: true } });

    const timeout = appWith([hangTurn], { deps: { timeoutMs: 40, now: () => NOW, provider: scripted([hangTurn]).provider } });
    const r2 = parseSse((await post(timeout.app, { message: "Show skips" })).text).frames;
    expect(r2[r2.length - 1].data).toMatchObject({ code: "FLO_TIMEOUT", retryable: true });

    const noAnswer = appWith([toolTurn({ id: "t", name: "list_skipped_visits" })]);
    const r3 = parseSse((await post(noAnswer.app, { message: "Show skips", mode: "QUICK" })).text).frames;
    expect(r3[r3.length - 1].data).toMatchObject({ code: "FLO_NO_ANSWER", retryable: false });
    expect(r3.map((f) => f.event)).not.toContain("done");
  });

  it("a client that disconnects mid-stream aborts the provider call and the message is stored as ABORTED", async () => {
    const s = scripted([hangTurn]);
    const { app } = appWith(GOOD, { deps: { provider: s.provider, now: () => NOW } });
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({ message: "Show skips" });
      const req = http.request({ port, method: "POST", path: "/flo/chat", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-role": "ADMIN" } });
      req.on("error", () => {});
      const gotData = new Promise<void>((resolve) => req.on("response", (res) => res.once("data", () => resolve())));
      req.end(body);
      await gotData;
      await vi.waitFor(() => expect(s.streamCalls).toHaveLength(1));
      req.destroy();
      await vi.waitFor(() => expect(db.messages.find((m) => m.role === "ASSISTANT")?.status).toBe("ABORTED"), { timeout: 3000 });
      expect(s.streamCalls[0].signal?.aborted).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("POST /flo/chat: errors before the first byte are plain JSON", () => {
  it.each([
    ["message missing", {}],
    ["blank message", { message: "   " }],
    ["over 2000 characters", { message: "x".repeat(2001) }],
    ["bad mode", { message: "hi", mode: "FAST" }],
  ] as Array<[string, object]>)("400 INVALID_MESSAGE: %s", async (_name, body) => {
    const res = await post(appWith().app, body);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.code).toBe("INVALID_MESSAGE");
    expect(db.conversations).toHaveLength(0);
  });

  it("400 for a bad Idempotency-Key", async () => {
    const res = await post(appWith().app, { message: "hi" }, "ADMIN", { "Idempotency-Key": " " });
    expect(res.body).toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
  });

  it("404 FLO_CONVERSATION_NOT_FOUND for another admin's conversation", async () => {
    const theirs = db.seed.conversation({ profileId: "other-admin" });
    const res = await post(appWith().app, { message: "hi", conversationId: theirs.id });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("FLO_CONVERSATION_NOT_FOUND");
  });

  it("409 FLO_REQUEST_IN_PROGRESS while the same Idempotency-Key is still running", async () => {
    db.idempotency.push({ key: "flo:p1:busy", actorId: "p1", route: "POST /flo/chat", state: "IN_PROGRESS", createdAt: new Date() });
    const res = await post(appWith().app, { message: "hi" }, "ADMIN", { "Idempotency-Key": "busy" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FLO_REQUEST_IN_PROGRESS");
  });

  it("429 FLO_DAILY_LIMIT with resetsAt at tenant midnight (cap from the platform env)", async () => {
    const conv = db.seed.conversation({ profileId: "someone" });
    db.seed.message({ conversationId: conv.id, createdAt: new Date("2026-11-10T08:00:00Z") });
    const { app } = appWith(GOOD, { env: { ...ENV, FLO_DAILY_LIMIT_PER_TENANT: "1" } as never });
    const res = await post(app, { message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "FLO_DAILY_LIMIT", resetsAt: "2026-11-11T00:00:00.000Z", error: expect.stringContaining("reached today's limit") });
    expect(res.body.requestId).toBeTruthy();
  });

  it("429 FLO_DECLINE_LIMIT after too many declined messages", async () => {
    const conv = db.seed.conversation({ profileId: "p1" });
    db.seed.message({ conversationId: conv.id, status: "DECLINED", declineReason: "OUT_OF_SCOPE", createdAt: new Date("2026-11-10T08:00:00Z") });
    const { app } = appWith(GOOD, { env: { ...ENV, FLO_DECLINE_LIMIT_PER_DAY: "1" } as never });
    const res = await post(app, { message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("FLO_DECLINE_LIMIT");
  });

  it("429 RATE_LIMITED is per admin profile, not per IP", async () => {
    const { app } = appWith(GOOD, { env: { ANTHROPIC_API_KEY: "k", RATE_LIMIT_FLO_PER_MIN: "1" } as never });
    expect((await post(app, { message: "one" }, "ADMIN", as("ADMIN", "p1"))).status).toBe(200);
    const limited = await post(app, { message: "two" }, "ADMIN", as("ADMIN", "p1"));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Same IP, different admin: still allowed.
    expect((await post(app, { message: "three" }, "ADMIN", as("ADMIN", "p2"))).status).toBe(200);
  });

  it("503 FLO_UNAVAILABLE when the key is unset", async () => {
    const res = await post(appWith(GOOD, { env: { RATE_LIMIT_DISABLED: "true" } as never }).app, { message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("FLO_UNAVAILABLE");
  });
});

describe("conversations", () => {
  it("lists only the caller's own, newest first, with a cursor; validates the query", async () => {
    const { app } = appWith();
    db.seed.conversation({ title: "A" });
    db.seed.conversation({ title: "B" });
    db.seed.conversation({ profileId: "p2", title: "Other admin's" });
    const res = await request(app).get("/flo/conversations?limit=1").set(as("ADMIN"));
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([{ id: expect.any(String), title: "B", updatedAt: expect.any(String) }]);
    expect(res.body.nextCursor).toBe(res.body.conversations[0].id);
    const page2 = await request(app).get(`/flo/conversations?limit=1&cursor=${res.body.nextCursor}`).set(as("ADMIN"));
    expect(page2.body.conversations.map((c: any) => c.title)).toEqual(["A"]);
    expect(page2.body.nextCursor).toBeNull();
    expect((await request(app).get("/flo/conversations?limit=5000").set(as("ADMIN"))).body.conversations).toHaveLength(2);
    expect((await request(app).get("/flo/conversations").set(as("ADMIN"))).body.conversations).toHaveLength(2);
    expect((await request(app).get("/flo/conversations?limit=0").set(as("ADMIN"))).body.code).toBe("INVALID_LIMIT");
    expect((await request(app).get("/flo/conversations?limit=x").set(as("ADMIN"))).status).toBe(400);
    expect((await request(app).get("/flo/conversations?cursor=").set(as("ADMIN"))).body.code).toBe("INVALID_CURSOR");
    expect((await request(app).get(`/flo/conversations?cursor=${"c".repeat(65)}`).set(as("ADMIN"))).status).toBe(400);
    expect((await request(app).get("/flo/conversations?cursor=a&cursor=b").set(as("ADMIN"))).status).toBe(400);
  });

  it("GET and DELETE of another admin's conversation are 404; DELETE of your own is 204", async () => {
    const { app } = appWith();
    const mine = db.seed.conversation();
    const theirs = db.seed.conversation({ profileId: "p2" });
    for (const method of ["get", "delete"] as const) {
      const res = await (request(app) as any)[method](`/flo/conversations/${theirs.id}`).set(as("ADMIN"));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("FLO_CONVERSATION_NOT_FOUND");
    }
    expect(db.conversations).toHaveLength(2);
    const del = await request(app).delete(`/flo/conversations/${mine.id}`).set(as("ADMIN"));
    expect(del.status).toBe(204);
    expect(del.text).toBe("");
    expect(db.conversations.map((c) => c.id)).toEqual([theirs.id]);
  });
});

describe("module wiring", () => {
  it("exports a default router and builds one with default options", () => {
    expect(typeof floRouter).toBe("function");
    expect(typeof createFloRouter()).toBe("function");
  });
});
