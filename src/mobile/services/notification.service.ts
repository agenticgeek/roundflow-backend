import type { Prisma } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { isPushEnabledFor } from "../../lib/notification-prefs";
import { pushToProfile } from "./push";

/** Deep-link payload stored on a notification (and sent with the push). */
export interface NotificationData {
  visitId?: string;
  roundId?: string;
  customerId?: string;
  invoiceId?: string;
  propertyId?: string;
  date?: string; // YYYY-MM-DD
}

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
    const notifications = (hasMore ? rows.slice(0, PAGE_SIZE) : rows).map(
      ({ id, profileId: owner, type, title, body, read, data, createdAt }) => ({ id, profileId: owner, type, title, body, read, data, createdAt })
    );
    const unreadCount = await this.unreadCount(profileId);
    return {
      notifications,
      unreadCount,
      nextCursor: hasMore ? notifications[notifications.length - 1].id : null,
    };
  }

  async unreadCount(profileId: string): Promise<number> {
    return this.prisma.notification.count({ where: { profileId, read: false } });
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

  // Producer hook — call from anywhere to notify a profile. Stores the row and
  // fires a push best-effort. The push is skipped (row still stored) when the
  // profile opted the category out (preferences.notifications.categories.<type>
  // === false). `opts.push` lets a caller that already resolved preferences
  // (notifyEvent) skip the lookup. Most producers should use notifyEvent
  // (services/notify.ts), which also resolves/dedupes recipients.
  async create(
    profileId: string,
    type: string,
    title: string,
    body?: string,
    data?: NotificationData,
    opts: { push?: boolean } = {}
  ) {
    const notification = await this.prisma.notification.create({
      data: {
        profileId,
        type,
        title,
        body: body ?? null,
        category: type,
        ...(data ? { data: data as Prisma.InputJsonObject } : {}),
      },
    });
    const push = opts.push ?? (await isPushEnabledFor(profileId, type));
    // Fire and forget: a push failure never fails the create.
    void (push ? pushToProfile(this.prisma, profileId, title, body, data, type).catch((e) => console.error("[push] failed:", e)) : null);
    return notification;
  }
}

export function createNotificationService(prisma: TenantPrismaClient) {
  return new NotificationService(prisma);
}
