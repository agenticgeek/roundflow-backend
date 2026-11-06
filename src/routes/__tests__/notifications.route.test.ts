import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const list = vi.fn();
const unreadCount = vi.fn();
const markRead = vi.fn();
const markAllRead = vi.fn();
vi.mock("../../mobile/services/notification.service", () => ({
  createNotificationService: vi.fn(() => ({ list, unreadCount, markRead, markAllRead })),
}));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: "admin-1", tenantId: "tenant-1", role: "ADMIN" };
    req.tenantPrisma = {};
    next();
  },
}));
const businessAccess = vi.fn((_req: any, _res: any, next: any) => next());
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  requireBusinessAccess: () => (req: any, res: any, next: any) => businessAccess(req, res, next),
}));

import { notificationsRouter } from "../notifications";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/notifications", notificationsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "Internal error" });
  });
  return app;
}

const row = {
  id: "n1", profileId: "admin-1", type: "PAYMENT", title: "Payment failed", body: "x", read: false,
  data: { invoiceId: "inv1" }, createdAt: new Date("2026-11-06T10:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  businessAccess.mockImplementation((_req, _res, next) => next());
  list.mockResolvedValue({ notifications: [row], unreadCount: 3, nextCursor: "n1" });
  unreadCount.mockResolvedValue(3);
  markRead.mockResolvedValue(undefined);
  markAllRead.mockResolvedValue(undefined);
});

describe("notifications router", () => {
  it("is guarded by requireBusinessAccess", async () => {
    businessAccess.mockImplementation((_req, res) => res.status(403).json({ error: "Forbidden" }));
    for (const [method, path] of [["get", "/notifications"], ["get", "/notifications/unread-count"], ["post", "/notifications/n1/read"], ["post", "/notifications/read-all"]] as const) {
      expect((await request(makeApp())[method](path)).status).toBe(403);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("GET /notifications lists only the caller's own rows with the documented shape (no profileId)", async () => {
    const res = await request(makeApp()).get("/notifications?cursor=abc");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith("admin-1", "abc");
    expect(res.body).toEqual({
      notifications: [{ id: "n1", type: "PAYMENT", title: "Payment failed", body: "x", read: false, createdAt: "2026-11-06T10:00:00.000Z", data: { invoiceId: "inv1" } }],
      unreadCount: 3,
      nextCursor: "n1",
    });
  });

  it("GET /notifications without a cursor passes undefined", async () => {
    await request(makeApp()).get("/notifications");
    expect(list).toHaveBeenCalledWith("admin-1", undefined);
  });

  it("GET /notifications/unread-count returns the caller's count", async () => {
    const res = await request(makeApp()).get("/notifications/unread-count");
    expect(res.body).toEqual({ unreadCount: 3 });
    expect(unreadCount).toHaveBeenCalledWith("admin-1");
  });

  it("POST /notifications/:id/read marks only the caller's row and answers {ok:true}", async () => {
    const res = await request(makeApp()).post("/notifications/n1/read");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(markRead).toHaveBeenCalledWith("admin-1", "n1");
  });

  it("POST /notifications/read-all marks all of the caller's rows", async () => {
    const res = await request(makeApp()).post("/notifications/read-all");
    expect(res.body).toEqual({ ok: true });
    expect(markAllRead).toHaveBeenCalledWith("admin-1");
  });

  it("forwards service errors to the error handler", async () => {
    list.mockRejectedValue(new Error("db"));
    expect((await request(makeApp()).get("/notifications")).status).toBe(500);
  });
});
