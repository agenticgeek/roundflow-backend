import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { outboundSignal } from "../../lib/outbound";

// Best-effort push via Expo's push API (the common React Native path). Only
// ExponentPushToken[...] tokens are sent; anything else is skipped. No-op when
// the recipient has no registered Expo devices. Failures are the caller's to log.
// ponytail: Expo assumed; swap endpoint/payload for raw FCM/APNs if the app isn't Expo.
/** Android notification channels the app registers (Wave 2B-1). */
export type PushChannelId = "schedule" | "chat" | "payments" | "alerts";

const CHANNEL_BY_TYPE: Record<string, PushChannelId> = {
  SCHEDULE: "schedule",
  ROUND_UPDATE: "schedule",
  DAY_CLOSED: "schedule",
  CHAT: "chat",
  PAYMENT: "payments",
};

/** Notification type -> channel; everything else (complaints, access issues, invites, KPI, integrations) is an alert. */
export const channelForType = (type?: string): PushChannelId => (type && CHANNEL_BY_TYPE[type]) || "alerts";

export async function pushToProfile(
  prisma: TenantPrismaClient,
  profileId: string,
  title: string,
  body?: string,
  data?: object,
  type?: string
): Promise<void> {
  const devices = await prisma.device.findMany({ where: { profileId }, select: { pushToken: true } });
  const tokens = devices.map((d) => d.pushToken).filter((t) => t.startsWith("ExponentPushToken["));
  if (tokens.length === 0) return;

  // `type` and `channelId` let the app route the tap and pick the Android channel (BE: Wave 2B-1).
  const payloadData = data || type ? { ...(data ?? {}), ...(type ? { type } : {}) } : undefined;
  const messages = tokens.map((to) => ({
    to,
    title,
    body: body ?? "",
    sound: "default",
    channelId: channelForType(type),
    ...(payloadData ? { data: payloadData } : {}),
  }));
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    signal: outboundSignal(),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`Expo push ${res.status}: ${await res.text()}`);
}
