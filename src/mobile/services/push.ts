import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";

// Best-effort push via Expo's push API (the common React Native path). Only
// ExponentPushToken[...] tokens are sent; anything else is skipped. No-op when
// the recipient has no registered Expo devices. Failures are the caller's to log.
// ponytail: Expo assumed; swap endpoint/payload for raw FCM/APNs if the app isn't Expo.
export async function pushToProfile(
  prisma: TenantPrismaClient,
  profileId: string,
  title: string,
  body?: string
): Promise<void> {
  const devices = await prisma.device.findMany({ where: { profileId }, select: { pushToken: true } });
  const tokens = devices.map((d) => d.pushToken).filter((t) => t.startsWith("ExponentPushToken["));
  if (tokens.length === 0) return;

  const messages = tokens.map((to) => ({ to, title, body: body ?? "", sound: "default" }));
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`Expo push ${res.status}: ${await res.text()}`);
}
