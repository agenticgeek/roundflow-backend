import { prisma } from "./prisma";

// Wave 1 (item 10): per-category push preference. A profile opts a category out
// with `preferences.notifications.categories.<TYPE> === false`; anything else
// (missing key, true, malformed JSON) keeps push on. The in-app row is always
// stored; only the push is skipped.
export function categoryPushEnabled(preferences: unknown, type: string): boolean {
  if (!preferences || typeof preferences !== "object") return true;
  const notifications = (preferences as Record<string, unknown>).notifications;
  if (!notifications || typeof notifications !== "object") return true;
  const categories = (notifications as Record<string, unknown>).categories;
  if (!categories || typeof categories !== "object") return true;
  return (categories as Record<string, unknown>)[type] !== false;
}

/** Looks the profile up and applies categoryPushEnabled; fails open (push on). */
export async function isPushEnabledFor(profileId: string, type: string): Promise<boolean> {
  try {
    const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { preferences: true } });
    return categoryPushEnabled(profile?.preferences, type);
  } catch (err) {
    console.error("[notifications] preference lookup failed, defaulting to push on:", err);
    return true;
  }
}
