import { VisitStatus, Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

// ---------------------------------------------------------------------------
// M4 — Today's Work (BE-M4-01, BE-M4-05).
// ---------------------------------------------------------------------------

// ---- helpers ----------------------------------------------------------------

function todayRange(): { start: Date; end: Date } {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

// Returns the next Mon–Fri date after `date` (UTC). Skips Sat → Mon, Sun → Mon.
function nextWorkingDay(date: Date): Date {
  const next = new Date(date.getTime() + 86_400_000);
  const dow = next.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 6) return new Date(next.getTime() + 2 * 86_400_000); // Sat → Mon
  if (dow === 0) return new Date(next.getTime() + 86_400_000);     // Sun → Mon
  return next;
}

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
  value: number;
  etaMinutes: number | null;
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
}

// ---- Prisma payload ---------------------------------------------------------

const visitTodayInclude = {
  round: { select: { id: true, name: true } },
  technician: { select: { id: true, name: true } },
  _count: { select: { issues: true } },
} satisfies Prisma.VisitInclude;

type VisitToday = Prisma.VisitGetPayload<{ include: typeof visitTodayInclude }>;

// ---- contract ---------------------------------------------------------------

export interface ITodayService {
  getTodaysWork(profileId: string): Promise<TodaysWorkAggregate>;
  closeDay(
    profileId: string,
    unfinishedAction: "push_to_tomorrow" | "mark_as_skipped"
  ): Promise<CloseDaySummary>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class TodayService implements ITodayService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  // ---- GET /today (Screen 12 aggregate) ----

  async getTodaysWork(_profileId: string): Promise<TodaysWorkAggregate> {
    const { start, end } = todayRange();
    const today = start.toISOString().slice(0, 10);

    const [settings, visits] = await Promise.all([
      this.prisma.businessSettings.findFirst({ select: { lastClosedDate: true } }),
      this.prisma.visit.findMany({
        where: { date: { gte: start, lt: end } },
        include: visitTodayInclude,
        orderBy: { property: { addressLine: "asc" } },
      }),
    ]);

    return {
      date: today,
      dayClosed: settings?.lastClosedDate === today,
      kpi: this.computeKpi(visits),
      rounds: this.buildRoundRows(visits),
      technicians: this.buildTechnicianCards(visits),
    };
  }

  // ---- POST /today/close (M21) ----

  async closeDay(
    _profileId: string,
    unfinishedAction: "push_to_tomorrow" | "mark_as_skipped"
  ): Promise<CloseDaySummary> {
    const { start, end } = todayRange();

    return this.prisma.$transaction(async (tx) => {
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
        where: { date: { gte: start, lt: end } },
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
          const nextDay = nextWorkingDay(start);
          // Reset IN_PROGRESS back to SCHEDULED so the next working day starts fresh.
          await tx.visit.updateMany({
            where: { id: { in: unfinishedIds } },
            data: { date: nextDay, status: VisitStatus.SCHEDULED },
          });
        } else {
          await tx.visit.updateMany({
            where: { id: { in: unfinishedIds } },
            data: { status: VisitStatus.SKIPPED },
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
      };
    });
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
      const remaining = vs.filter(
        (v) =>
          v.status === VisitStatus.SCHEDULED || v.status === VisitStatus.IN_PROGRESS
      ).length;

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
        value: completed > 0
          ? vs
              .filter((v) => v.status === VisitStatus.COMPLETED)
              .reduce((acc, v) => acc + v.price.toNumber(), 0)
          : 0,
        etaMinutes: remaining > 0 ? remaining * 20 : null,
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

export function createTodayService(prisma: TenantPrismaClient): ITodayService {
  return new TodayService(prisma);
}
