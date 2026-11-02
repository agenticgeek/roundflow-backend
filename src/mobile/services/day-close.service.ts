import { VisitStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";
import { tenantTodayRange } from "../../services/business-time";

// Technician end-of-day sign-off. Separate from the office's POST /today/close
// (BusinessSettings.lastClosedDate, which closes the whole business day and
// moves/skips unfinished visits): this only records that THIS technician has
// nothing left open, and never changes a visit.

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RemainingVisit {
  visitId: string;
  status: "SCHEDULED" | "IN_PROGRESS";
  customerName: string;
  addressLine: string;
  roundName: string | null;
}

export interface DayStatus {
  date: string;
  closed: boolean;
  closedAt: Date | null;
  completedCount: number;
  skippedCount: number;
  remaining: RemainingVisit[];
}

export type CloseDayResult =
  | { ok: true; alreadyClosed: boolean; day: DayStatus }
  | { ok: false; day: DayStatus };

const visitSelect = {
  id: true,
  status: true,
  roundId: true,
  round: { select: { name: true } },
  property: { select: { addressLine: true, customer: { select: { name: true } } } },
} as const;

class DayCloseService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  // `date` = YYYY-MM-DD tenant-local day; omitted = today. Future days are rejected.
  private async resolveDay(date?: string | null): Promise<{ key: string; start: Date; end: Date }> {
    const today = await tenantTodayRange(this.prisma);
    const todayKey = today.start.toISOString().slice(0, 10);
    if (date === undefined || date === null || date === todayKey) {
      return { key: todayKey, start: today.start, end: today.end };
    }
    const start = new Date(`${date}T00:00:00.000Z`);
    if (!DATE_RE.test(date) || Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== date) {
      throw new AppError(400, "date must be a valid YYYY-MM-DD day", "INVALID_DATE");
    }
    if (date > todayKey) throw new AppError(400, "A day that has not started cannot be closed", "FUTURE_DATE");
    return { key: date, start, end: new Date(start.getTime() + DAY_MS) };
  }

  async getStatus(technicianId: string, date?: string | null): Promise<DayStatus> {
    const day = await this.resolveDay(date);
    const [visits, closed] = await Promise.all([
      this.prisma.visit.findMany({
        where: { technicianId, date: { gte: day.start, lt: day.end }, status: { not: VisitStatus.CANCELLED } },
        select: visitSelect,
        orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      }),
      this.prisma.technicianDayClose.findUnique({
        where: { technicianId_date: { technicianId, date: day.key } },
      }),
    ]);
    const remaining: RemainingVisit[] = visits
      .filter((v) => v.status === VisitStatus.SCHEDULED || v.status === VisitStatus.IN_PROGRESS)
      .map((v) => ({
        visitId: v.id,
        status: v.status as "SCHEDULED" | "IN_PROGRESS",
        customerName: v.property.customer.name,
        addressLine: v.property.addressLine,
        roundName: v.round?.name ?? null,
      }));
    return {
      date: day.key,
      closed: closed !== null,
      closedAt: closed?.closedAt ?? null,
      completedCount: closed?.completedCount ?? visits.filter((v) => v.status === VisitStatus.COMPLETED).length,
      skippedCount: closed?.skippedCount ?? visits.filter((v) => v.status === VisitStatus.SKIPPED).length,
      remaining,
    };
  }

  // Idempotent: closing an already-closed day returns the stored sign-off.
  async close(technicianId: string, date?: string | null): Promise<CloseDayResult> {
    const day = await this.getStatus(technicianId, date);
    if (day.closed) return { ok: true, alreadyClosed: true, day };
    if (day.remaining.length > 0) return { ok: false, day };
    const key = day.date;
    try {
      const row = await this.prisma.technicianDayClose.create({
        data: { technicianId, date: key, completedCount: day.completedCount, skippedCount: day.skippedCount },
      });
      return { ok: true, alreadyClosed: false, day: { ...day, closed: true, closedAt: row.closedAt } };
    } catch (err) {
      // A concurrent close won the unique (technicianId, date) race: return its row.
      if ((err as { code?: string }).code === "P2002") {
        return { ok: true, alreadyClosed: true, day: await this.getStatus(technicianId, key) };
      }
      throw err;
    }
  }
}

export function createDayCloseService(prisma: TenantPrismaClient) {
  return new DayCloseService(prisma);
}
