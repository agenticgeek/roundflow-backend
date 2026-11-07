import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isPushEnabledFor = vi.fn();
vi.mock("../../lib/notification-prefs", () => ({ isPushEnabledFor: (...a: unknown[]) => isPushEnabledFor(...a) }));
const pushToProfile = vi.fn();
vi.mock("../services/push", () => ({ pushToProfile: (...a: unknown[]) => pushToProfile(...a) }));

import { createNotificationService } from "../services/notification.service";

function makePrisma() {
  return {
    notification: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: "n1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isPushEnabledFor.mockResolvedValue(true);
  pushToProfile.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("NotificationService.create", () => {
  it("stays backward compatible: type/title/body only, category = type, no data", async () => {
    const prisma = makePrisma();
    await createNotificationService(prisma as never).create("p1", "CHAT", "Hi", "there");
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: { profileId: "p1", type: "CHAT", title: "Hi", body: "there", category: "CHAT" },
    });
    expect(pushToProfile).toHaveBeenCalledWith(prisma, "p1", "Hi", "there", undefined, expect.any(String));
  });

  it("stores data, null body, and forwards data to the push", async () => {
    const prisma = makePrisma();
    await createNotificationService(prisma as never).create("p1", "SCHEDULE", "Visits", undefined, { roundId: "r1", date: "2026-11-09" });
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: { profileId: "p1", type: "SCHEDULE", title: "Visits", body: null, category: "SCHEDULE", data: { roundId: "r1", date: "2026-11-09" } },
    });
    expect(pushToProfile).toHaveBeenCalledWith(prisma, "p1", "Visits", undefined, { roundId: "r1", date: "2026-11-09" }, expect.any(String));
  });

  it("skips the push (row still stored) when the category is opted out", async () => {
    isPushEnabledFor.mockResolvedValue(false);
    const prisma = makePrisma();
    await createNotificationService(prisma as never).create("p1", "CHAT", "Hi");
    expect(isPushEnabledFor).toHaveBeenCalledWith("p1", "CHAT");
    expect(prisma.notification.create).toHaveBeenCalled();
    expect(pushToProfile).not.toHaveBeenCalled();
  });

  it("opts.push bypasses the preference lookup", async () => {
    const prisma = makePrisma();
    const svc = createNotificationService(prisma as never);
    await svc.create("p1", "CHAT", "Hi", undefined, undefined, { push: false });
    expect(isPushEnabledFor).not.toHaveBeenCalled();
    expect(pushToProfile).not.toHaveBeenCalled();
    await svc.create("p1", "CHAT", "Hi", undefined, undefined, { push: true });
    expect(pushToProfile).toHaveBeenCalledTimes(1);
  });

  it("logs a failed push without failing the create", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    pushToProfile.mockRejectedValue(new Error("expo down"));
    const prisma = makePrisma();
    await expect(createNotificationService(prisma as never).create("p1", "CHAT", "Hi")).resolves.toEqual({ id: "n1" });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("[push] failed:", expect.any(Error)));
  });
});

describe("NotificationService.list / unreadCount", () => {
  it("returns data on every row and counts unread for the profile", async () => {
    const prisma = makePrisma();
    prisma.notification.findMany.mockResolvedValue([
      { id: "n1", profileId: "p1", type: "SCHEDULE", title: "t", body: null, read: false, data: { visitId: "v1" }, category: "SCHEDULE", createdAt: new Date(0) },
    ]);
    prisma.notification.count.mockResolvedValue(4);
    const res = await createNotificationService(prisma as never).list("p1");
    expect(res.notifications).toEqual([
      { id: "n1", profileId: "p1", type: "SCHEDULE", title: "t", body: null, read: false, data: { visitId: "v1" }, createdAt: new Date(0) },
    ]);
    expect(res.unreadCount).toBe(4);
    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { profileId: "p1", read: false } });
  });

  it("continues after a cursor and reports nextCursor when more rows exist", async () => {
    const prisma = makePrisma();
    const rows = Array.from({ length: 31 }, (_, i) => ({ id: `n${i}`, profileId: "p1", type: "CHAT", title: "t", body: null, read: false, data: null, createdAt: new Date(0) }));
    prisma.notification.findMany.mockResolvedValue(rows);
    const res = await createNotificationService(prisma as never).list("p1", "n-prev");
    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ cursor: { id: "n-prev" }, skip: 1, take: 31 }));
    expect(res.notifications).toHaveLength(30);
    expect(res.nextCursor).toBe("n29");
  });

  it("unreadCount is scoped to the profile", async () => {
    const prisma = makePrisma();
    prisma.notification.count.mockResolvedValue(2);
    expect(await createNotificationService(prisma as never).unreadCount("p9")).toBe(2);
  });
});

describe("NotificationService read state and devices", () => {
  it("markRead and markAllRead only touch the caller's rows", async () => {
    const prisma = makePrisma();
    const svc = createNotificationService(prisma as never);
    await svc.markRead("p1", "n1");
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({ where: { id: "n1", profileId: "p1" }, data: { read: true } });
    await svc.markAllRead("p1");
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({ where: { profileId: "p1", read: false }, data: { read: true } });
  });

  it("registers (upsert) and unregisters a push device for the caller", async () => {
    const prisma = { ...makePrisma(), device: { upsert: vi.fn(), deleteMany: vi.fn() } };
    const svc = createNotificationService(prisma as never);
    await svc.registerDevice("p1", "ExponentPushToken[a]", "ios");
    expect(prisma.device.upsert).toHaveBeenCalledWith({
      where: { pushToken: "ExponentPushToken[a]" },
      create: { profileId: "p1", pushToken: "ExponentPushToken[a]", platform: "ios" },
      update: { profileId: "p1", platform: "ios" },
    });
    await svc.unregisterDevice("p1", "ExponentPushToken[a]");
    expect(prisma.device.deleteMany).toHaveBeenCalledWith({ where: { pushToken: "ExponentPushToken[a]", profileId: "p1" } });
  });
});
