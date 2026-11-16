import { VisitStatus } from "../../../generated/tenant-client";
import type { TenantPrismaClient } from "../../../lib/tenant-prisma-manager";
import type { ToolName } from "../types";
import { type Args, dateToDay, round2, SCAN_CAP, ToolInputError, visitDateWhere } from "./shared";

// Helpers private to the E1 tools (shared.ts belongs to another owner and is read-only for us).

/** Prisma Decimal / number / null -> number (null and undefined become 0). */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** Optional boolean argument; anything else is a ToolInputError the model can act on. */
export function optBool(obj: Args, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ToolInputError(`"${key}" must be true or false`);
  return v;
}

/** groupBy/aggregate `_count` is a number or `{ _all: n }` depending on how it was requested. */
export const countOf = (c: unknown): number => (typeof c === "number" ? c : num((c as { _all?: unknown } | null | undefined)?._all));

/** part / whole * 100, 2 dp; null when the whole is zero. */
export const pct = (part: number, whole: number): number | null => (whole === 0 ? null : round2((part / whole) * 100));

/** First day (YYYY-MM-DD) of the month containing `day`. */
export const monthStartOf = (day: string): string => `${day.slice(0, 8)}01`;

/**
 * The same part of the previous calendar month as [first of this month .. day]: e.g. 1 to 17 Nov -> 1 to 17 Oct;
 * 1 to 31 Mar -> 1 to 28 Feb (clamped to the previous month's last day).
 */
export function previousMonthPeriod(day: string): { from: string; to: string } {
  const [y, m, d] = day.split("-").map(Number);
  const prevMonthIndex = m - 2; // 0-based month of the previous month (may be -1)
  const first = new Date(Date.UTC(y, prevMonthIndex, 1));
  const lastDay = new Date(Date.UTC(y, prevMonthIndex + 1, 0)).getUTCDate();
  const to = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay)));
  return { from: dateToDay(first), to: dateToDay(to) };
}

export const DEFAULT_SKIP_LOOKBACK_DAYS = 180;

export interface PropertyStreak {
  propertyId: string;
  customerId: string;
  customer: string;
  address: string;
  skips: number;
  lastSkipped: string;
  reason: string | null;
}

/**
 * Consecutive-skip streaks per property over [from, to]: COMPLETED and SKIPPED visits, newest first, a COMPLETED
 * visit ends the streak (the same rule list_at_risk_customers has always used). Properties with 0 skips are included.
 */
export async function skipStreaks(tp: TenantPrismaClient, from: string, to: string): Promise<{ streaks: PropertyStreak[]; truncated: boolean }> {
  const visits = await tp.visit.findMany({
    where: { date: visitDateWhere(from, to), status: { in: [VisitStatus.COMPLETED, VisitStatus.SKIPPED] } },
    select: {
      propertyId: true,
      date: true,
      status: true,
      skipReason: true,
      property: { select: { customerId: true, addressLine: true, customer: { select: { name: true } } } },
    },
    orderBy: [{ propertyId: "asc" }, { date: "desc" }],
    take: SCAN_CAP + 1,
  });
  const scanned = visits.slice(0, SCAN_CAP);
  const map = new Map<string, PropertyStreak & { open: boolean }>();
  for (const v of scanned) {
    let s = map.get(v.propertyId);
    if (!s) {
      s = {
        propertyId: v.propertyId,
        customerId: v.property.customerId ?? v.propertyId,
        customer: v.property.customer.name,
        address: v.property.addressLine,
        skips: 0,
        lastSkipped: dateToDay(v.date),
        reason: v.skipReason,
        open: true,
      };
      map.set(v.propertyId, s);
    }
    if (!s.open) continue;
    if (v.status === VisitStatus.SKIPPED) s.skips += 1;
    else s.open = false;
  }
  return { streaks: [...map.values()].map(({ open: _open, ...rest }) => rest), truncated: visits.length > SCAN_CAP };
}
