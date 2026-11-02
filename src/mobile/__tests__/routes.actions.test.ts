import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { Prisma } from "../../generated/tenant-client";

// Route-level tests for the A8 / D-3 / D-4 / B6 hardening of /mobile:
// role + technician guard, NOT_YOUR_VISIT on every visit action, payment
// bodies, idempotent replay, chat scoping and upsells. Services are mocked;
// ownership, idempotency and the upsell service run for real against a fake
// tenant client.

let role = "TECHNICIAN";
let tp: ReturnType<typeof makeTp>;

vi.mock("../../lib/prisma", () => ({ prisma: { profile: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { supabaseUserId: "sb-user-1", email: "sam@x.co" };
    next();
  },
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: "profile-1", tenantId: "tenant-1", name: "Sam", role };
    req.tenantPrisma = tp;
    next();
  },
}));

const tracker = {
  startVisit: vi.fn(), markArrived: vi.fn(), skipVisit: vi.fn(), adjustPrice: vi.fn(), reportAccessIssue: vi.fn().mockResolvedValue({ id: "iss-1" }),
};
vi.mock("../services/job-tracker.service", () => ({ createJobTrackerService: () => tracker }));
const media = {
  addVisitNote: vi.fn(), addVisitPhoto: vi.fn(),
  getPhotoUploadUrl: vi.fn().mockResolvedValue({ signedUrl: "https://u", path: "p" }),
  getAvatarUploadUrl: vi.fn(), getChatAttachmentUploadUrl: vi.fn().mockResolvedValue({ signedUrl: "https://c", path: "c" }),
};
vi.mock("../services/media.service", () => ({ createMediaService: () => media }));
const detail = { getVisitDetail: vi.fn().mockResolvedValue({ id: "v1", property: { id: "pr1", photos: [] }, photos: [] }), collectDebtPayment: vi.fn() };
vi.mock("../services/job-detail.service", () => ({ createJobDetailService: () => detail }));
const schedule = { getSchedule: vi.fn().mockResolvedValue({ rows: [] }) };
vi.mock("../services/schedule.service", async (orig) => ({ ...(await orig<typeof import("../services/schedule.service")>()), createScheduleService: () => schedule }));
const chat = {
  getChatMessages: vi.fn().mockResolvedValue([]),
  send: vi.fn().mockResolvedValue({ row: { id: "m1" }, duplicate: false }),
  unread: vi.fn().mockResolvedValue({ total: 0, rounds: [] }),
  markRead: vi.fn().mockResolvedValue({ roundId: "r1", lastReadAt: "2026-11-03T00:00:00.000Z" }),
};
vi.mock("../services/chat.service", () => ({ createChatService: () => chat }));
// Fake signer: stored value → "<value>?signed" (media-urls has its own tests).
vi.mock("../media-urls", () => ({
  signAvatar: async () => null,
  signChatRows: async (_t: string, rows: Array<{ photoUrls?: string[] }>) =>
    rows.map((r) => ({ ...r, photoSignedUrls: (r.photoUrls ?? []).map((u) => `${u}?signed`) })),
  signPhotos: async (_t: string, photos: Array<{ url: string }>) => photos.map((p) => ({ ...p, signedUrl: `${p.url}?signed` })),
}));
const completeVisit = vi.fn();
vi.mock("../../services/visit-completion", async (orig) => {
  const actual = await orig<typeof import("../../services/visit-completion")>();
  return { ...actual, createVisitCompletionService: () => ({ completeVisit: (...a: unknown[]) => completeVisit(...a) }) };
});

import { mobileRouter } from "../routes";
import { AppError } from "../../lib/app-error";

function makeTp() {
  return {
    technician: { findUnique: vi.fn().mockResolvedValue({ id: "tech-1", active: true }) },
    visit: { findUnique: vi.fn().mockResolvedValue({ technicianId: "tech-1" }), findFirst: vi.fn().mockResolvedValue(null) },
    roundTechnician: { findFirst: vi.fn().mockResolvedValue({ roundId: "r1" }) },
    idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    technicianIncident: { create: vi.fn() },
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/mobile", mobileRouter);
  app.use((err: unknown, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  role = "TECHNICIAN";
  tp = makeTp();
  completeVisit.mockResolvedValue({ id: "v1", status: "COMPLETED", payment: null });
  detail.collectDebtPayment.mockResolvedValue({ cleared: true, amountPaid: 10, amountPending: 0, method: "CASH" });
});

// [method, path, body] for every /mobile/visits/:id action.
const VISIT_ACTIONS: [string, string, Record<string, unknown>][] = [
  ["get", "/mobile/visits/v1", {}],
  ["patch", "/mobile/visits/v1/start", {}],
  ["patch", "/mobile/visits/v1/arrive", {}],
  ["patch", "/mobile/visits/v1/skip", { reason: "Gate locked" }],
  ["patch", "/mobile/visits/v1/price", { price: 20 }],
  ["post", "/mobile/visits/v1/access-issues", { type: "GATE_LOCKED", description: "locked" }],
  ["post", "/mobile/visits/v1/notes", { text: "hi" }],
  ["post", "/mobile/visits/v1/photos/upload-url", { type: "BEFORE" }],
  ["post", "/mobile/visits/v1/photos", { type: "BEFORE", url: "https://x" }],
  ["post", "/mobile/visits/v1/debt-payment", { method: "CASH" }],
  ["patch", "/mobile/visits/v1/complete", {}],
  ["post", "/mobile/visits/v1/upsells", { description: "Gutters", amount: 15 }],
];

const send = (method: string, path: string, body: Record<string, unknown>) =>
  (request(makeApp()) as any)[method](path).send(body);

describe("D-3 router guard", () => {
  it.each(["ADMIN", "MANAGER"])("403 TECHNICIAN_ONLY for %s", async (r) => {
    role = r;
    const res = await request(makeApp()).get("/mobile/visits/today");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("TECHNICIAN_ONLY");
  });

  it("403 NO_TECHNICIAN when the profile has no Technician row", async () => {
    tp.technician.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).get("/mobile/rounds/today");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NO_TECHNICIAN");
  });
});

describe("A8 ownership", () => {
  it.each(VISIT_ACTIONS)("%s %s → 403 NOT_YOUR_VISIT for another technician's visit", async (method, path, body) => {
    tp.visit.findUnique.mockResolvedValue({ technicianId: "tech-2" });
    const res = await send(method, path, body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_YOUR_VISIT");
  });

  it.each(VISIT_ACTIONS)("%s %s → 2xx for the owner", async (method, path, body) => {
    tp.technicianIncident.create.mockResolvedValue({ id: "i1", type: "UPSELL", amount: new Prisma.Decimal(15), note: "Gutters", visitId: "v1", createdAt: new Date() });
    const res = await send(method, path, body);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it("404 for an unknown visit", async () => {
    tp.visit.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).patch("/mobile/visits/v1/start");
    expect(res.status).toBe(404);
  });
});

describe("idempotency on visit writes", () => {
  it("replays a stored response without re-running the action", async () => {
    tp.idempotencyRecord.findUnique.mockResolvedValue({
      key: "k1", technicianId: "tech-1", route: "PATCH /mobile/visits/v1/complete", responseStatus: 200,
      responseBody: { id: "v1", status: "COMPLETED", payment: null },
    });
    const res = await request(makeApp()).patch("/mobile/visits/v1/complete").set("X-Idempotency-Key", "k1").send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COMPLETED");
    expect(completeVisit).not.toHaveBeenCalled();
  });

  it("stores the first response for the key", async () => {
    await request(makeApp()).patch("/mobile/visits/v1/start").set("X-Idempotency-Key", "k2");
    expect(tp.idempotencyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: "k2", technicianId: "tech-1", route: "PATCH /mobile/visits/v1/start", responseStatus: 200 }),
    });
  });

  it("403 IDEMPOTENCY_KEY_CONFLICT for another technician's key", async () => {
    tp.idempotencyRecord.findUnique.mockResolvedValue({ key: "k1", technicianId: "tech-9", route: "x", responseStatus: 200, responseBody: {} });
    const res = await request(makeApp()).patch("/mobile/visits/v1/start").set("X-Idempotency-Key", "k1");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });
});

describe("PATCH /mobile/visits/:id/complete", () => {
  it("passes payment, trimmed note and the technician actor", async () => {
    const res = await request(makeApp()).patch("/mobile/visits/v1/complete")
      .send({ payment: { method: "CASH", amount: 30 }, note: "  all good  " });
    expect(res.status).toBe(200);
    expect(completeVisit).toHaveBeenCalledWith("v1", {
      payment: { method: "CASH", amount: 30, chequeNumber: undefined },
      note: "all good",
      actorProfileId: "profile-1",
      actorRole: "TECHNICIAN",
    });
  });

  it("drops a blank note and maps cashConfirmed to CASH", async () => {
    await request(makeApp()).patch("/mobile/visits/v1/complete").send({ cashConfirmed: true, note: "  " });
    expect(completeVisit.mock.calls[0][1]).toMatchObject({ payment: { method: "CASH" }, note: undefined });
  });

  it("400 CHEQUE_NUMBER_REQUIRED before touching the visit", async () => {
    const res = await request(makeApp()).patch("/mobile/visits/v1/complete").send({ payment: { method: "CHEQUE" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CHEQUE_NUMBER_REQUIRED");
    expect(completeVisit).not.toHaveBeenCalled();
  });
});

describe("POST /mobile/visits/:id/debt-payment", () => {
  it("accepts cashConfirmed as the CASH alias", async () => {
    await request(makeApp()).post("/mobile/visits/v1/debt-payment").send({ cashConfirmed: true });
    expect(detail.collectDebtPayment).toHaveBeenCalledWith("v1", { method: "CASH", chequeNumber: undefined, actorProfileId: "profile-1" });
  });

  it("accepts a cheque with its number", async () => {
    await request(makeApp()).post("/mobile/visits/v1/debt-payment").send({ method: "CHEQUE", chequeNumber: " 77 " });
    expect(detail.collectDebtPayment).toHaveBeenCalledWith("v1", { method: "CHEQUE", chequeNumber: "77", actorProfileId: "profile-1" });
  });

  it("400 when a cheque has no number", async () => {
    const res = await request(makeApp()).post("/mobile/visits/v1/debt-payment").send({ method: "CHEQUE" });
    expect(res.status).toBe(400);
  });

  it.each([{}, { method: "CARD" }, { cashConfirmed: false }])("400 INVALID_PAYMENT for %j", async (body) => {
    const res = await request(makeApp()).post("/mobile/visits/v1/debt-payment").send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYMENT");
  });
});

describe("access-issue photos", () => {
  const PATH = "tenant-1/visits/v1/access_issue-1.jpg";

  it("upload-url accepts type ACCESS_ISSUE", async () => {
    const res = await request(makeApp()).post("/mobile/visits/v1/photos/upload-url").send({ type: "ACCESS_ISSUE" });
    expect(res.status).toBe(200);
    expect(media.getPhotoUploadUrl).toHaveBeenCalledWith("v1", "ACCESS_ISSUE", "image/jpeg", "tenant-1");
  });

  it("upload-url 400 for an unknown type", async () => {
    const res = await request(makeApp()).post("/mobile/visits/v1/photos/upload-url").send({ type: "PROPERTY" });
    expect(res.status).toBe(400);
  });

  it("access-issues stores photoPaths on the issue and returns its id", async () => {
    const res = await request(makeApp()).post("/mobile/visits/v1/access-issues").send({ type: "DOG_LOOSE", description: "Dog", photoPaths: [PATH] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ recorded: true, id: "iss-1", photoCount: 1 });
    expect(tracker.reportAccessIssue).toHaveBeenCalledWith("v1", "DOG_LOOSE", "Dog", [PATH], { technicianName: expect.anything(), profileId: expect.anything() });
  });

  it("access-issues without photos passes []", async () => {
    const res = await request(makeApp()).post("/mobile/visits/v1/access-issues").send({ type: "OTHER", description: "x" });
    expect(res.body.photoCount).toBe(0);
    expect(tracker.reportAccessIssue).toHaveBeenCalledWith("v1", "OTHER", "x", [], expect.objectContaining({ profileId: expect.anything() }));
  });

  it.each([
    [["tenant-2/visits/v1/a.jpg"]],
    [["tenant-1/visits/v2/a.jpg"]],
    [["tenant-1/visits/v1/../../v2/a.jpg"]],
    [Array.from({ length: 11 }, (_, i) => `tenant-1/visits/v1/${i}.jpg`)],
  ])("access-issues 400 for photoPaths %j", async (photoPaths) => {
    const res = await request(makeApp()).post("/mobile/visits/v1/access-issues").send({ type: "OTHER", description: "x", photoPaths });
    expect(res.status).toBe(400);
    expect(tracker.reportAccessIssue).not.toHaveBeenCalled();
  });

  it("access-issues 400 for an unknown issue type", async () => {
    const res = await request(makeApp()).post("/mobile/visits/v1/access-issues").send({ type: "NOPE", description: "x" });
    expect(res.status).toBe(400);
  });
});

describe("signed read urls", () => {
  it("GET /mobile/visits/:id adds signedUrl to each photo, keeping the stored url", async () => {
    detail.getVisitDetail.mockResolvedValueOnce({
      id: "v1",
      property: { id: "pr1", photos: [{ id: "pp1", url: "tenant-1/properties/pr1/h.jpg" }] },
      photos: [{ id: "p1", type: "BEFORE", url: "tenant-1/visits/v1/b.jpg" }],
    });
    const res = await request(makeApp()).get("/mobile/visits/v1");
    expect(res.body.photos).toEqual([{ id: "p1", type: "BEFORE", url: "tenant-1/visits/v1/b.jpg", signedUrl: "tenant-1/visits/v1/b.jpg?signed" }]);
    expect(res.body.property.photos).toEqual([{ id: "pp1", url: "tenant-1/properties/pr1/h.jpg", signedUrl: "tenant-1/properties/pr1/h.jpg?signed" }]);
  });

  it("chat GET and POST responses carry photoSignedUrls", async () => {
    chat.getChatMessages.mockResolvedValueOnce([{ id: "m1", photoUrls: ["tenant-1/chat/r1/a.jpg"] }]);
    const list = await request(makeApp()).get("/mobile/chat/messages?roundId=r1");
    expect(list.body[0].photoSignedUrls).toEqual(["tenant-1/chat/r1/a.jpg?signed"]);

    chat.send.mockResolvedValueOnce({ row: { id: "m3", photoUrls: ["tenant-1/chat/r1/b.jpg"] }, duplicate: false });
    const sent = await request(makeApp()).post("/mobile/chat/messages").send({ roundId: "r1", type: "PHOTOS", photoUrls: ["tenant-1/chat/r1/b.jpg"] });
    expect(sent.status).toBe(201);
    expect(sent.body.photoSignedUrls).toEqual(["tenant-1/chat/r1/b.jpg?signed"]);

    const text = await request(makeApp()).post("/mobile/chat/messages").send({ roundId: "r1", text: "hi" });
    expect(text.body.photoSignedUrls).toEqual([]);
  });
});

describe("POST /mobile/visits/:id/photos", () => {
  it("accepts `path` as an alias for `url`", async () => {
    await request(makeApp()).post("/mobile/visits/v1/photos").send({ type: "AFTER", path: "t/visits/v1/after.jpg" });
    expect(media.addVisitPhoto).toHaveBeenCalledWith("v1", "t/visits/v1/after.jpg", "AFTER");
  });

  it("400 when neither url nor path is sent", async () => {
    const res = await request(makeApp()).post("/mobile/visits/v1/photos").send({ type: "AFTER" });
    expect(res.status).toBe(400);
  });
});

describe("POST /mobile/visits/:id/upsells", () => {
  it("records an UPSELL incident and returns 201", async () => {
    const createdAt = new Date("2026-10-30T10:00:00Z");
    tp.technicianIncident.create.mockResolvedValue({ id: "i1", type: "UPSELL", amount: new Prisma.Decimal("15.5"), note: "Gutters", visitId: "v1", createdAt });

    const res = await request(makeApp()).post("/mobile/visits/v1/upsells").send({ description: " Gutters ", amount: 15.499 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "i1", type: "UPSELL", amount: 15.5, note: "Gutters", visitId: "v1", createdAt: createdAt.toISOString() });
    expect(tp.technicianIncident.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { technicianId: "tech-1", visitId: "v1", type: "UPSELL", amount: 15.5, note: "Gutters", createdById: "profile-1" },
    }));
  });

  it.each([
    [{ amount: 10 }],
    [{ description: "x" }],
    [{ description: "x", amount: 0 }],
    [{ description: "x", amount: 10000 }],
    [{ description: "x", amount: "10" }],
  ])("400 for %j", async (body) => {
    const res = await request(makeApp()).post("/mobile/visits/v1/upsells").send(body);
    expect(res.status).toBe(400);
    expect(tp.technicianIncident.create).not.toHaveBeenCalled();
  });
});

describe("chat scoping (A8) and sender id (D-4)", () => {
  it("GET 403 NOT_YOUR_ROUND for a round the technician is not on", async () => {
    tp.roundTechnician.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get("/mobile/chat/messages?roundId=r9");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_YOUR_ROUND");
  });

  it("GET passes the viewer ids", async () => {
    const res = await request(makeApp()).get("/mobile/chat/messages?roundId=r1");
    expect(res.status).toBe(200);
    expect(chat.getChatMessages).toHaveBeenCalledWith("r1", { profileId: "profile-1", supabaseUserId: "sb-user-1" }, undefined, { before: undefined, limit: 100 });
  });

  it("POST TEXT stores the Profile id as sender", async () => {
    await request(makeApp()).post("/mobile/chat/messages").send({ roundId: "r1", text: "hi" });
    expect(chat.send).toHaveBeenCalledWith("r1", "profile-1", { type: "TEXT", text: "hi", clientMsgId: null });
  });

  it("POST PHOTOS stores the Profile id as sender", async () => {
    await request(makeApp()).post("/mobile/chat/messages").send({ roundId: "r1", type: "PHOTOS", photoUrls: ["tenant-1/chat/r1/a.jpg"] });
    expect(chat.send).toHaveBeenCalledWith("r1", "profile-1", { type: "PHOTOS", photoUrls: ["tenant-1/chat/r1/a.jpg"], text: null, clientMsgId: null });
  });

  it("POST WORK_PHOTOS requires owning the visit", async () => {
    await request(makeApp()).post("/mobile/chat/messages").send({ roundId: "r1", type: "WORK_PHOTOS", visitId: "v1" });
    expect(chat.send).toHaveBeenCalledWith("r1", "profile-1", { type: "WORK_PHOTOS", visitId: "v1", clientMsgId: null });

    tp.visit.findUnique.mockResolvedValue({ technicianId: "tech-2" });
    const res = await request(makeApp()).post("/mobile/chat/messages").send({ roundId: "r1", type: "WORK_PHOTOS", visitId: "v1" });
    expect(res.body.code).toBe("NOT_YOUR_VISIT");
  });

  it("POST 403 for a round the technician is not on", async () => {
    tp.roundTechnician.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post("/mobile/chat/messages").send({ roundId: "r9", text: "hi" });
    expect(res.status).toBe(403);
    expect(chat.send).not.toHaveBeenCalled();
  });

  it("attachment upload-url is scoped to the technician's rounds", async () => {
    const ok = await request(makeApp()).post("/mobile/messages/attachments/upload-url").send({ roundId: "r1" });
    expect(ok.status).toBe(200);
    tp.roundTechnician.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post("/mobile/messages/attachments/upload-url").send({ roundId: "r9" });
    expect(res.status).toBe(403);
  });
});

describe("chat additions (limit/before, clientMsgId, caps, unread, read)", () => {
  it("GET parses limit and before, rejects bad values and since+before together", async () => {
    const before = "2026-11-03T10:00:00.000Z";
    await request(makeApp()).get(`/mobile/chat/messages?roundId=r1&limit=20&before=${before}`);
    expect(chat.getChatMessages).toHaveBeenLastCalledWith("r1", expect.anything(), undefined, { before: new Date(before), limit: 20 });
    for (const qs of ["limit=0", "before=nope", "since=nope", "since=2026-01-01T00:00:00Z&before=2026-01-02T00:00:00Z"]) {
      expect((await request(makeApp()).get(`/mobile/chat/messages?roundId=r1&${qs}`)).status).toBe(400);
    }
  });

  it("POST passes clientMsgId; a duplicate answers 200 with the existing message", async () => {
    chat.send.mockResolvedValueOnce({ row: { id: "m1" }, duplicate: true });
    const res = await request(makeApp()).post("/mobile/chat/messages").send({ roundId: "r1", text: "hi", clientMsgId: "c1" });
    expect(res.status).toBe(200);
    expect(chat.send).toHaveBeenLastCalledWith("r1", "profile-1", { type: "TEXT", text: "hi", clientMsgId: "c1" });
  });

  it("POST rejects text over 2000 chars, empty text, bad photo paths, unknown types", async () => {
    const post = (b: Record<string, unknown>) => request(makeApp()).post("/mobile/chat/messages").send({ roundId: "r1", ...b });
    const long = await post({ text: "x".repeat(2001) });
    expect(long.status).toBe(400);
    expect(long.body.code).toBe("CHAT_TEXT_TOO_LONG");
    expect((await post({ text: "x".repeat(2000) })).status).toBe(201);
    expect((await post({ text: " " })).status).toBe(400);
    expect((await post({ type: "PHOTOS", photoUrls: [] })).status).toBe(400);
    expect((await post({ type: "PHOTOS", photoUrls: ["tenant-2/chat/r1/a.jpg"] })).status).toBe(400);
    expect((await post({ type: "PHOTOS", photoUrls: ["tenant-1/chat/r2/a.jpg"] })).status).toBe(400);
    const withText = await post({ type: "PHOTOS", photoUrls: ["tenant-1/chat/r1/a.jpg"], text: " look " });
    expect(withText.status).toBe(201);
    expect(chat.send).toHaveBeenLastCalledWith("r1", "profile-1", { type: "PHOTOS", photoUrls: ["tenant-1/chat/r1/a.jpg"], text: "look", clientMsgId: null });
    expect((await post({ type: "VIDEO" })).status).toBe(400);
  });

  it("GET /chat/unread works with and without roundId and enforces round membership", async () => {
    chat.unread.mockResolvedValueOnce({ total: 2, rounds: [{ roundId: "r1", unread: 2 }] });
    const all = await request(makeApp()).get("/mobile/chat/unread");
    expect(all.body.total).toBe(2);
    expect(chat.unread).toHaveBeenLastCalledWith("tech-1", { profileId: "profile-1", supabaseUserId: "sb-user-1" }, undefined);
    await request(makeApp()).get("/mobile/chat/unread?roundId=r1");
    expect(chat.unread).toHaveBeenLastCalledWith("tech-1", expect.anything(), "r1");
    tp.roundTechnician.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get("/mobile/chat/unread?roundId=r9");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_YOUR_ROUND");
  });

  it("POST /chat/read marks the thread read and enforces round membership", async () => {
    const ok = await request(makeApp()).post("/mobile/chat/read").send({ roundId: "r1" });
    expect(ok.status).toBe(200);
    expect(chat.markRead).toHaveBeenCalledWith("r1", { profileId: "profile-1", supabaseUserId: "sb-user-1" });
    expect((await request(makeApp()).post("/mobile/chat/read").send({})).status).toBe(400);
    tp.roundTechnician.findFirst.mockResolvedValue(null);
    expect((await request(makeApp()).post("/mobile/chat/read").send({ roundId: "r9" })).status).toBe(403);
  });
});

describe("GET /mobile/schedule", () => {
  it("is scoped to the caller's technician id and parses range + paging", async () => {
    const res = await request(makeApp()).get("/mobile/schedule?from=2026-11-04&to=2026-11-10&page=2&pageSize=500");
    expect(res.status).toBe(200);
    expect(schedule.getSchedule).toHaveBeenLastCalledWith("tech-1", { from: "2026-11-04", to: "2026-11-10", page: 2, pageSize: 200 });
    await request(makeApp()).get("/mobile/schedule");
    expect(schedule.getSchedule).toHaveBeenLastCalledWith("tech-1", { from: undefined, to: undefined, page: 1, pageSize: 100 });
    expect((await request(makeApp()).get("/mobile/schedule?page=0")).status).toBe(400);
  });

  it("is refused for non-technicians", async () => {
    role = "ADMIN";
    expect((await request(makeApp()).get("/mobile/schedule")).status).toBe(403);
  });
});
