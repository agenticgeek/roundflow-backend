import { VisitStatus, Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { tenantTodayRange } from "./business-time";
import { getCachedBusinessSettings, invalidateCachedBusinessSettings } from "./settings.service";
import { carryOverVisits, notifyCarryoverCustomers, notifyCarryoverTechnicians, pickTarget, type MovedVisit } from "./carryover.service";

// ---------------------------------------------------------------------------
// M4 — Today's Work (BE-M4-01, BE-M4-05).
// ---------------------------------------------------------------------------

export const DEFAULT_CLOSE_DAY_SKIP_REASON = "Not completed - day closed";

function deriveRoundStatus(
  total: number,
  completed: number,
  skipped: number,
  inProgress: number
): "not_started" | "in_progress" | "completed" {
  if (total === 0) return "not_started";
  if (completed + skipped === total) return "completed";
  if (inProgress > 0 || completed > 0) return "in_progress";
  return "not_started";
}

// ---- output types -----------------------------------------------------------

export interface TodayKpi {
  totalStops: number;
  inProgress: number;
  completed: number;
  skipped: number;
  issues: number;
  paymentHolds: number;
  carriedOver: number;
  valueCompleted: number;
}

export interface TodayRoundRow {
  roundId: string;
  roundName: string;
  technicianId: string | null;
  technicianName: string | null;
  status: "not_started" | "in_progress" | "completed";
  total: number;
  completed: number;
  skipped: number;
  issueCount: number;
  paymentHolds: number;
  /** Visits on this round today that were carried over from an earlier day. */
  carriedOver: number;
  scheduledValue: number; // every (non-cancelled) stop today
  completedValue: number; // COMPLETED stops only
  /** @deprecated same as completedValue; kept for one release (GAP-035). */
  value: number;
  etaMinutes: null;       // no real estimate yet
}

export interface TodayTechnicianCard {
  technicianId: string;
  technicianName: string | null;
  completed: number;
  remaining: number;
  roundName: string | null;
  issueCount: number;
  onTrack: boolean;
}

export interface TodaysWorkAggregate {
  date: string;
  generatedAt: string; // ISO timestamp, for "Updated HH:mm"
  dayClosed: boolean;
  kpi: TodayKpi;
  rounds: TodayRoundRow[];
  technicians: TodayTechnicianCard[];
}

export interface CloseDaySummary {
  completedJobs: number;
  skippedJobs: number;
  outstanding: number;
  issues: number;
  paymentHolds: number;
  revenue: number;
  /** YYYY-MM-DD the unfinished visits were carried to; null for mark_as_skipped or when nothing was left. */
  carriedToDate: string | null;
  /** Customers messaged about the carryover (notifyCustomers); 0 otherwise. */
  notifiedCustomers: number;
  /** Set when notifyCustomers was requested but the message step failed (the close itself succeeded). */
  customerNotificationError?: string;
}

// ---- Prisma payload ---------------------------------------------------------

const visitTodayInclude = {
  round: { select: { id: true, name: true } },
  technician: { select: { id: true, name: true } },
  _count: { select: { issues: true } },
} satisfies Prisma.VisitInclude;

type VisitToday = Prisma.VisitGetPayload<{ include: typeof visitTodayInclude }>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class TodayService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  // ---- GET /today (Screen 12 aggregate) ----

  async getTodaysWork(): Promise<TodaysWorkAggregate> {
    const { start, end } = await tenantTodayRange(this.prisma);
    const today = start.toISOString().slice(0, 10);

    const [settings, visits] = await Promise.all([
      getCachedBusinessSettings(this.prisma),
      this.prisma.visit.findMany({
        where: { date: { gte: start, lt: end }, status: { not: VisitStatus.CANCELLED } },
        include: visitTodayInclude,
        orderBy: { property: { addressLine: "asc" } },
      }),
    ]);

    return {
      date: today,
      generatedAt: new Date().toISOString(),
      dayClosed: settings?.lastClosedDate === today,
      kpi: this.computeKpi(visits),
      rounds: this.buildRoundRows(visits),
      technicians: this.buildTechnicianCards(visits),
    };
  }

  // ---- POST /today/close (M21) ----

  async closeDay(
    unfinishedAction: "push_to_tomorrow" | "mark_as_skipped",
    skipReason?: string | null,
    /** ACT-02..04: CarryoverKey for the push (default: the option flagged default for today). */
    target?: string,
    actor?: { id?: string | null; role?: string | null },
    /** Also message the customers of the carried visits (push_to_tomorrow only; best effort). */
    opts: { notifyCustomers?: boolean } = {}
  ): Promise<CloseDaySummary> {
    const { start, end } = await tenantTodayRange(this.prisma);
    let carried: { moved: MovedVisit[]; targetDate: Date } | null = null;

    const result = await this.prisma.$transaction(async (tx) => {
      const today = start.toISOString().slice(0, 10);

      const settings = await tx.businessSettings.findFirst({
        select: { lastClosedDate: true },
      });
      if (!settings) {
        throw new AppError(409, "Business settings not configured — complete setup first");
      }
      if (settings.lastClosedDate === today) {
        throw new AppError(409, "Operational day has already been closed");
      }

      const visits = await tx.visit.findMany({
        where: { date: { gte: start, lt: end }, status: { not: VisitStatus.CANCELLED } },
        select: {
          id: true,
          status: true,
          paymentHold: true,
          price: true,
          _count: { select: { issues: true } },
        },
      });

      // Unfinished = SCHEDULED or IN_PROGRESS (technician started but didn't finish)
      const unfinishedIds = visits
        .filter(
          (v) =>
            v.status === VisitStatus.SCHEDULED || v.status === VisitStatus.IN_PROGRESS
        )
        .map((v) => v.id);

      if (unfinishedIds.length > 0) {
        if (unfinishedAction === "push_to_tomorrow") {
          // Same service as POST /visits/carryover: IN_PROGRESS goes back to SCHEDULED, start/arrival
          // and reminder markers reset, queued reminders cancelled, carryover recorded.
          const settings = await getCachedBusinessSettings(this.prisma);
          const targetDate = pickTarget(start, target, {
            workingDays: settings?.defaultWorkingDays ?? [],
            tz: settings?.timezone ?? undefined,
          });
          const core = await carryOverVisits(tx, {
            fromDate: start, targetDate, visitIds: unfinishedIds, actor, via: "close-day",
          });
          carried = { moved: core.moved, targetDate };
        } else {
          await tx.visit.updateMany({
            where: { id: { in: unfinishedIds } },
            // B6: the close-of-day reason is stored on each visit (default text when none given).
            data: { status: VisitStatus.SKIPPED, skipReason: skipReason?.trim() || DEFAULT_CLOSE_DAY_SKIP_REASON },
          });
        }
      }

      const preCompleted = visits.filter((v) => v.status === VisitStatus.COMPLETED);
      const preSkipped = visits.filter((v) => v.status === VisitStatus.SKIPPED);
      const newlySkipped =
        unfinishedAction === "mark_as_skipped" ? unfinishedIds.length : 0;

      await tx.businessSettings.updateMany({ data: { lastClosedDate: today } });

      return {
        completedJobs: preCompleted.length,
        // Include visits just marked as skipped — not just the pre-existing ones.
        skippedJobs: preSkipped.length + newlySkipped,
        // outstanding = how many were pushed to tomorrow (0 if mark_as_skipped).
        outstanding: unfinishedAction === "push_to_tomorrow" ? unfinishedIds.length : 0,
        issues: visits.reduce((acc, v) => acc + v._count.issues, 0),
        paymentHolds: visits.filter((v) => v.paymentHold).length,
        revenue: preCompleted.reduce((acc, v) => acc.add(v.price), new Prisma.Decimal(0)).toNumber(),
        carriedToDate: null as string | null,
        notifiedCustomers: 0,
        customerNotificationError: undefined as string | undefined,
      };
    });
    if (carried) {
      const { moved, targetDate } = carried as { moved: MovedVisit[]; targetDate: Date };
      result.carriedToDate = targetDate.toISOString().slice(0, 10);
      await notifyCarryoverTechnicians(this.prisma, moved, start, targetDate);
      if (opts.notifyCustomers) {
        const sent = await notifyCarryoverCustomers(this.prisma, moved, start, targetDate);
        result.notifiedCustomers = sent.notified;
        if (sent.error) result.customerNotificationError = sent.error;
      }
    }
    // Invalidate after the transaction commits (not inside the tx callback —
    // the cache is keyed by this outer long-lived client, not the short-lived
    // `tx` object). Without this, getTodaysWork()'s cached read of
    // lastClosedDate can report dayClosed:false for up to the cache TTL right
    // after a successful close.
    invalidateCachedBusinessSettings(this.prisma);
    return result;
  }

  // ---- private helpers ----

  private computeKpi(visits: VisitToday[]): TodayKpi {
    return {
      totalStops: visits.length,
      inProgress: visits.filter((v) => v.status === VisitStatus.IN_PROGRESS).length,
      completed: visits.filter((v) => v.status === VisitStatus.COMPLETED).length,
      skipped: visits.filter((v) => v.status === VisitStatus.SKIPPED).length,
      issues: visits.filter((v) => v._count.issues > 0).length,
      paymentHolds: visits.filter((v) => v.paymentHold).length,
      carriedOver: visits.filter((v) => v.carriedOverFromDate != null).length,
      valueCompleted: visits
        .filter((v) => v.status === VisitStatus.COMPLETED)
        .reduce((acc, v) => acc.add(v.price), new Prisma.Decimal(0))
        .toNumber(),
    };
  }

  private buildRoundRows(visits: VisitToday[]): TodayRoundRow[] {
    const byRound = new Map<string, VisitToday[]>();
    for (const v of visits) {
      if (!v.roundId || !v.round) continue;
      const bucket = byRound.get(v.roundId) ?? [];
      bucket.push(v);
      byRound.set(v.roundId, bucket);
    }

    return Array.from(byRound.entries()).map(([roundId, vs]) => {
      const round = vs[0].round!;
      // Primary technician: prefer IN_PROGRESS visit, then SCHEDULED, then any
      const primaryVisit =
        vs.find((v) => v.status === VisitStatus.IN_PROGRESS) ??
        vs.find((v) => v.status === VisitStatus.SCHEDULED) ??
        vs[0];

      const completed = vs.filter((v) => v.status === VisitStatus.COMPLETED).length;
      const skipped = vs.filter((v) => v.status === VisitStatus.SKIPPED).length;
      const inProgress = vs.filter((v) => v.status === VisitStatus.IN_PROGRESS).length;
      const completedValue = vs
        .filter((v) => v.status === VisitStatus.COMPLETED)
        .reduce((acc, v) => acc + v.price.toNumber(), 0);

      return {
        roundId,
        roundName: round.name,
        technicianId: primaryVisit.technicianId,
        technicianName: primaryVisit.technician?.name ?? null,
        status: deriveRoundStatus(vs.length, completed, skipped, inProgress),
        total: vs.length,
        completed,
        skipped,
        issueCount: vs.reduce((acc, v) => acc + v._count.issues, 0),
        paymentHolds: vs.filter((v) => v.paymentHold).length,
        carriedOver: vs.filter((v) => v.carriedOverFromDate != null).length,
        scheduledValue: vs.reduce((acc, v) => acc + v.price.toNumber(), 0),
        completedValue,
        value: completedValue,
        etaMinutes: null,
      };
    });
  }

  private buildTechnicianCards(visits: VisitToday[]): TodayTechnicianCard[] {
    const byTech = new Map<string, VisitToday[]>();
    for (const v of visits) {
      if (!v.technicianId) continue;
      const bucket = byTech.get(v.technicianId) ?? [];
      bucket.push(v);
      byTech.set(v.technicianId, bucket);
    }

    return Array.from(byTech.entries()).map(([technicianId, vs]) => {
      const tech = vs[0].technician!;
      const completed = vs.filter((v) => v.status === VisitStatus.COMPLETED).length;
      const remaining = vs.filter(
        (v) =>
          v.status === VisitStatus.SCHEDULED || v.status === VisitStatus.IN_PROGRESS
      ).length;
      const issueCount = vs.reduce((acc, v) => acc + v._count.issues, 0);

      return {
        technicianId,
        technicianName: tech.name ?? null,
        completed,
        remaining,
        roundName: vs.find((v) => v.round)?.round?.name ?? null,
        issueCount,
        onTrack: issueCount === 0,
      };
    });
  }
}

export function createTodayService(prisma: TenantPrismaClient) {
  return new TodayService(prisma);
}
