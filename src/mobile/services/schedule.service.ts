import { VisitStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";
import { grossOf, vatOn } from "../../lib/vat";
import { getCachedBusinessSettings } from "../../services/settings.service";
import { tenantToday, tenantTimeZone } from "../../services/business-time";
import type { MobileVisitRow } from "../types";
import { toRow, visitMobileInclude } from "./home.service";

// GET /mobile/schedule - the signed-in technician's visits over a date range
// (upcoming and past days). Dates are tenant-local calendar days (same helper
// as "today"); only the caller's own visits are ever read.

export const SCHEDULE_DEFAULT_DAYS = 14; // from = today, to = today + 13
export const SCHEDULE_MAX_SPAN_DAYS = 62; // inclusive
export const SCHEDULE_DEFAULT_PAGE_SIZE = 100;
export const SCHEDULE_MAX_PAGE_SIZE = 200;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface ScheduleRow extends MobileVisitRow {
  date: string; // YYYY-MM-DD (tenant-local calendar day)
  paymentHold: boolean;
  vatAmount: number;
  grossTotal: number;
}

export interface ScheduleDaySummary {
  date: string;
  count: number;
  completedCount: number;
}

export interface ScheduleResult {
  from: string;
  to: string;
  timeZone: string;
  rows: ScheduleRow[];
  summary: ScheduleDaySummary[]; // every day in the range that has visits, whole range (not paginated)
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

function parseDay(v: unknown, field: string): Date | undefined {
  if (v === undefined || v === "") return undefined;
  const d = typeof v === "string" && DATE_RE.test(v) ? new Date(`${v}T00:00:00.000Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || iso(d) !== v) {
    throw new AppError(400, `${field} must be a valid date in YYYY-MM-DD format`, "INVALID_DATE_RANGE");
  }
  return d;
}

export function createScheduleService(prisma: TenantPrismaClient) {
  return {
    async getSchedule(
      technicianId: string,
      q: { from?: unknown; to?: unknown; page: number; pageSize: number },
      now: Date = new Date()
    ): Promise<ScheduleResult> {
      const today = await tenantToday(prisma, now);
      const from = parseDay(q.from, "from") ?? today;
      const to = parseDay(q.to, "to") ?? new Date(from.getTime() + (SCHEDULE_DEFAULT_DAYS - 1) * DAY_MS);
      if (from > to) throw new AppError(400, "from must not be after to", "INVALID_DATE_RANGE");
      const span = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
      if (span > SCHEDULE_MAX_SPAN_DAYS) {
        throw new AppError(400, `The range may span at most ${SCHEDULE_MAX_SPAN_DAYS} days (got ${span})`, "RANGE_TOO_LARGE");
      }

      // Light pass over the whole range: ordering, per-round position, summary, total.
      const light = await prisma.visit.findMany({
        where: {
          technicianId,
          date: { gte: from, lt: new Date(to.getTime() + DAY_MS) },
          status: { not: VisitStatus.CANCELLED },
        },
        orderBy: [{ date: "asc" }, { roundId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, date: true, roundId: true, status: true },
      });

      const position = new Map<string, number | null>();
      const counters = new Map<string, number>();
      const days = new Map<string, ScheduleDaySummary>();
      for (const v of light) {
        const day = iso(v.date);
        const s = days.get(day) ?? { date: day, count: 0, completedCount: 0 };
        s.count++;
        if (v.status === VisitStatus.COMPLETED) s.completedCount++;
        days.set(day, s);
        if (v.roundId) {
          const key = `${day}|${v.roundId}`;
          const n = (counters.get(key) ?? 0) + 1;
          counters.set(key, n);
          position.set(v.id, n);
        } else {
          position.set(v.id, null);
        }
      }

      const total = light.length;
      const pageIds = light.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((v) => v.id);
      const details = pageIds.length
        ? await prisma.visit.findMany({
            where: { id: { in: pageIds }, technicianId },
            include: { ...visitMobileInclude },
          })
        : [];
      const byId = new Map(details.map((d) => [d.id, d]));
      const settings = await getCachedBusinessSettings(prisma);

      const rows: ScheduleRow[] = [];
      for (const id of pageIds) {
        const v = byId.get(id);
        if (!v) continue; // changed between the two reads
        const net = v.price.toNumber();
        rows.push({
          ...toRow(v, position.get(id) ?? null),
          date: iso(v.date),
          paymentHold: v.paymentHold,
          vatAmount: vatOn(net, settings),
          grossTotal: grossOf(net, settings),
        });
      }

      return {
        from: iso(from),
        to: iso(to),
        timeZone: await tenantTimeZone(prisma),
        rows,
        summary: [...days.values()],
        pagination: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) },
      };
    },
  };
}
