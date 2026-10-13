import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { pushToProfile } from "./push";

const PAGE_SIZE = 30;

class NotificationService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async list(profileId: string, cursor?: string) {
    const rows = await this.prisma.notification.findMany({
      where: { profileId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > PAGE_SIZE;
    const notifications = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const unreadCount = await this.prisma.notification.count({ where: { profileId, read: false } });
    return {
      notifications,
      unreadCount,
      nextCursor: hasMore ? notifications[notifications.length - 1].id : null,
    };
  }

  async markRead(profileId: string, id: string): Promise<void> {
    await this.prisma.notification.updateMany({ where: { id, profileId }, data: { read: true } });
  }

  async markAllRead(profileId: string): Promise<void> {
    await this.prisma.notification.updateMany({ where: { profileId, read: false }, data: { read: true } });
  }

  async registerDevice(profileId: string, pushToken: string, platform: string): Promise<void> {
    await this.prisma.device.upsert({
      where: { pushToken },
      create: { profileId, pushToken, platform },
      update: { profileId, platform },
    });
  }

  async unregisterDevice(profileId: string, pushToken: string): Promise<void> {
    await this.prisma.device.deleteMany({ where: { pushToken, profileId } });
  }

  // Producer hook — call from anywhere to notify a technician. Fires a push best-effort.
  // ponytail: no event producers wired yet; this is the single entry point for them.
  async create(profileId: string, type: string, title: string, body?: string) {
    const notification = await this.prisma.notification.create({
      data: { profileId, type, title, body: body ?? null },
    });
    pushToProfile(this.prisma, profileId, title, body).catch((e) => console.error("[push] failed:", e));
    return notification;
  }
}

export function createNotificationService(prisma: TenantPrismaClient) {
  return new NotificationService(prisma);
}
