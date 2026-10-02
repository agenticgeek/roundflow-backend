import { Prisma, VisitStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import type { CompletionsSummary, MobileVisitRow, RoundSummary } from "../types";
import { todayRange } from "./utils";

const visitMobileInclude = {
  property: {
    select: {
      id: true, addressLine: true, postcode: true,
      customer: { select: { id: true, name: true, badDebt: true } },
      notes: { select: { id: true, type: true, body: true } },
    },
  },
  round: { select: { id: true, name: true } },
  service: { select: { id: true, name: true } },
  _count: { select: { issues: true } },
} satisfies Prisma.VisitInclude;

type VisitMobile = Prisma.VisitGetPayload<{ include: typeof visitMobileInclude }>;

function toRow(v: VisitMobile, position: number | null = null): MobileVisitRow {
  return {
    visitId: v.id,
    status: v.status,
    price: v.price.toNumber(),
    paymentMethod: v.paymentMethod ?? null,
    customerName: v.property.customer.name,
    addressLine: v.property.addressLine,
    postcode: v.property.postcode,
    roundId: v.roundId,
    roundName: v.round?.name ?? null,
    serviceName: v.service?.name ?? null,
    notes: v.notes,
    issueCount: v._count.issues,
    propertyNotes: v.property.notes.map((n) => ({ type: n.type, body: n.body })),
    completedAt: v.completedAt ?? null,
    hasDebt: v.property.customer.badDebt,
    position,
  };
}

export interface IHomeService {
  getTodayVisits(technicianProfileId: string): Promise<MobileVisitRow[]>;
  getCompletions(technicianProfileId: string): Promise<CompletionsSummary>;
  getRoundsSummary(technicianProfileId: string): Promise<RoundSummary[]>;
}

class HomeService implements IHomeService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async getTodayVisits(technicianProfileId: string): Promise<MobileVisitRow[]> {
    const tech = await this.prisma.technician.findUnique({
      where: { profileId: technicianProfileId },
      select: { id: true },
    });
    if (!tech) return [];

    const { start, end } = todayRange();
    const visits = await this.prisma.visit.findMany({
      where: { technicianId: tech.id, date: { gte: start, lt: end } },
      include: visitMobileInclude,
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    });
    const roundCounters = new Map<string, number>();
    return visits.map(v => {
      let position: number | null = null;
      if (v.roundId) {
        const n = (roundCounters.get(v.roundId) ?? 0) + 1;
        roundCounters.set(v.roundId, n);
        position = n;
      }
      return toRow(v, position);
    });
  }

  async getCompletions(technicianProfileId: string): Promise<CompletionsSummary> {
    const tech = await this.prisma.technician.findUnique({
      where: { profileId: technicianProfileId },
      select: { id: true },
    });
    if (!tech) return { revenueToday: 0, revenueChangePercent: null, completedCount: 0, skippedCount: 0, totalCount: 0, roundName: null, visits: [] };

    const { start, end } = todayRange();
    const visits = await this.prisma.visit.findMany({
      where: { technicianId: tech.id, date: { gte: start, lt: end } },
      include: visitMobileInclude,
      orderBy: { completedAt: "desc" },
    });

    const completed = visits.filter(v => v.status === VisitStatus.COMPLETED);
    const skipped = visits.filter(v => v.status === VisitStatus.SKIPPED);
    const revenueToday = completed.reduce((sum, v) => sum + v.price.toNumber(), 0);

    const lastWeekStart = new Date(start.getTime() - 7 * 86_400_000);
    const lastWeekEnd = new Date(end.getTime() - 7 * 86_400_000);
    const lastWeekVisits = await this.prisma.visit.findMany({
      where: { technicianId: tech.id, date: { gte: lastWeekStart, lt: lastWeekEnd }, status: VisitStatus.COMPLETED },
      select: { price: true },
    });
    const revenueLast = lastWeekVisits.reduce((sum, v) => sum + v.price.toNumber(), 0);
    const revenueChangePercent = revenueLast > 0
      ? Math.round(((revenueToday - revenueLast) / revenueLast) * 100)
      : null;

    return {
      revenueToday,
      revenueChangePercent,
      completedCount: completed.length,
      skippedCount: skipped.length,
      totalCount: visits.length,
      roundName: visits[0]?.round?.name ?? null,
      visits: completed.map(toRow),
    };
  }

  async getRoundsSummary(technicianProfileId: string): Promise<RoundSummary[]> {
    const tech = await this.prisma.technician.findUnique({
      where: { profileId: technicianProfileId },
      select: { id: true },
    });
    if (!tech) return [];

    const { start, end } = todayRange();
    const visits = await this.prisma.visit.findMany({
      where: { technicianId: tech.id, date: { gte: start, lt: end } },
      select: { roundId: true, date: true, status: true, round: { select: { name: true } } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    });

    const roundMap = new Map<string, RoundSummary>();
    for (const v of visits) {
      if (!v.roundId || !v.round) continue;
      const existing = roundMap.get(v.roundId);
      if (!existing) {
        roundMap.set(v.roundId, {
          roundId: v.roundId,
          roundName: v.round.name,
          totalCount: 1,
          completedCount: v.status === VisitStatus.COMPLETED ? 1 : 0,
          date: v.date,
        });
      } else {
        existing.totalCount++;
        if (v.status === VisitStatus.COMPLETED) existing.completedCount++;
      }
    }
    return Array.from(roundMap.values());
  }
}

export function createHomeService(prisma: TenantPrismaClient): IHomeService {
  return new HomeService(prisma);
}
