import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { localDateTime, resolveTimeZone } from "../../lib/dates";
import { tenantTimeZone } from "../business-time";

// Platform-owned cost control (D6). The caps are env vars owned by RoundFlow; nothing here is tenant-editable.
// The daily cap is counted from FloMessage rows (ASSISTANT + OK) in the tenant-local day, so there is no counter
// table to drift. The decline cap counts DECLINED rows per admin per day.

function posInt(raw: string | undefined, fallback: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export function dailyLimitPerTenant(env: NodeJS.ProcessEnv = process.env): number {
  return posInt(env.FLO_DAILY_LIMIT_PER_TENANT, 100);
}

export function declineLimitPerDay(env: NodeJS.ProcessEnv = process.env): number {
  return posInt(env.FLO_DECLINE_LIMIT_PER_DAY, 30);
}

export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return posInt(env.FLO_RETENTION_DAYS, 90);
}

export function floEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.ANTHROPIC_API_KEY?.trim() && env.FLO_ENABLED?.trim().toLowerCase() !== "false";
}

/** Per-admin limiter config. The route keys it on the profile id (never the IP, so an office behind one NAT is fine). */
export function floLimiterConfig(env: NodeJS.ProcessEnv = process.env): { windowMs: number; max: number; keyBy: "profile" } {
  return { windowMs: 60_000, max: posInt(env.RATE_LIMIT_FLO_PER_MIN, 20), keyBy: "profile" };
}

const MIN_MS = 60_000;

/** The tenant-local calendar day containing `now` as the instants [start, end) (DST days are 23 or 25 hours). */
export function tenantDayWindow(timeZone: string, now: Date): { start: Date; end: Date; date: string } {
  const tz = resolveTimeZone(timeZone);
  const date = localDateTime(now, tz).date;
  const anchor = Math.floor(now.getTime() / MIN_MS) * MIN_MS;
  const span = 26 * 60 * MIN_MS; // longer than any local day
  const start = firstInstant(anchor - span, anchor, (t) => localDateTime(new Date(t), tz).date >= date);
  const end = firstInstant(anchor, anchor + span, (t) => localDateTime(new Date(t), tz).date > date);
  return { start: new Date(start), end: new Date(end), date };
}

// Smallest minute-aligned instant in (lo, hi] where `pred` is true. pred(lo) is false and pred(hi) is true.
function firstInstant(lo: number, hi: number, pred: (t: number) => boolean): number {
  while (hi - lo > MIN_MS) {
    const mid = lo + Math.floor((hi - lo) / MIN_MS / 2) * MIN_MS;
    if (pred(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export interface DailyUsage {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: Date;
}

/** Answered questions today (tenant-local day) across the whole tenant. */
export async function getDailyUsage(tp: TenantPrismaClient, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<DailyUsage> {
  const tz = await tenantTimeZone(tp);
  const { start, end } = tenantDayWindow(tz, now);
  const used = await tp.floMessage.count({ where: { role: "ASSISTANT", status: "OK", createdAt: { gte: start, lt: end } } });
  const limit = dailyLimitPerTenant(env);
  return { used, limit, remaining: Math.max(0, limit - used), resetsAt: end };
}

/** Declined messages by this admin today (tenant-local day). A CAPABILITY reply ("what can you do?") is not a refusal and does not count. */
export async function getDeclineCount(tp: TenantPrismaClient, profileId: string, now: Date = new Date()): Promise<number> {
  const tz = await tenantTimeZone(tp);
  const { start, end } = tenantDayWindow(tz, now);
  return tp.floMessage.count({
    where: { role: "ASSISTANT", status: "DECLINED", declineReason: { not: "CAPABILITY" }, createdAt: { gte: start, lt: end }, conversation: { profileId } },
  });
}
