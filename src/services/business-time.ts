import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { localDay, resolveTimeZone, todayRange } from "../lib/dates";
import { getCachedBusinessSettings } from "./settings.service";

// EMU-6: "today" for scheduling, jobs and Today's Work follows the tenant's
// BusinessSettings.timezone (Europe/London when unset or invalid). A settings
// read failure falls back to the default zone rather than breaking the
// request that only needed the date.

export async function tenantTimeZone(tp: TenantPrismaClient): Promise<string> {
  try {
    return resolveTimeZone((await getCachedBusinessSettings(tp))?.timezone);
  } catch {
    return resolveTimeZone(null);
  }
}

export async function tenantTodayRange(tp: TenantPrismaClient, now: Date = new Date()): Promise<{ start: Date; end: Date }> {
  return todayRange(await tenantTimeZone(tp), now);
}

/** UTC-midnight Date of the tenant-local "today". */
export async function tenantToday(tp: TenantPrismaClient, now: Date = new Date()): Promise<Date> {
  return localDay(await tenantTimeZone(tp), now);
}
