import { VisitStatus, Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import type { AppStatus } from "./settings.service";
import { todayRange } from "../lib/dates";
import { computeTechnicianKpis, emptyKpis, periodRange, type KpiPeriod } from "./technician-kpi.service";

// ---------------------------------------------------------------------------
// M9 — Technicians CRUD (BE-M9-02).
// ---------------------------------------------------------------------------

export type { AppStatus };

// Exported so settings.service.ts's /settings/technicians write path can
// derive the same appStatus and serviceAreas shape as this (newer) router,
// instead of maintaining a second, drifting copy of this logic.
export function deriveAppStatus(active: boolean, profileId: string | null): AppStatus {
  if (!active) return "INACTIVE";
  if (profileId === null) return "PENDING_INVITE";
  return "ACTIVE";
}

// ---- output types -----------------------------------------------------------

export interface TechnicianServiceAreaRow {
  serviceAreaId: string;
  serviceAreaName: string;
  assignedAt: Date;
}

export interface TechnicianListItem {
  id: string;
  name: string | null;
  phone: string | null;
  role: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  appStatus: AppStatus;
  serviceAreas: TechnicianServiceAreaRow[];
  createdAt: Date;
}

export interface WorkloadRoundRow {
  roundId: string;
  roundName: string;
  total: number;
  completed: number;
  skipped: number;
  remaining: number;
}

export interface TechnicianDetail extends TechnicianListItem {
  roundNames: string[];
  todayWorkload: WorkloadRoundRow[];
}

export interface TodayStats {
  total: number;
  completed: number;
  skipped: number;
  remaining: number;
}

// listTechnicians() — adds round names and today's job stats directly on the
// list response, so the frontend doesn't have to fan out N x
// getTechnicianDetail() calls just to show that on the technician list.
export interface TechnicianListRow extends TechnicianListItem {
  roundNames: string[];
  todayStats: TodayStats;
}

// GET /technicians/:id/performance (GAP-030).
export interface TechnicianPerformance {
  technicianId: string;
  period: KpiPeriod;
  from: Date;
  to: Date; // exclusive
  visitsCompleted: number;
  revenue: number;
  timeOnJobMinutes: number | null;
  revenuePerHour: number | null;
  strikes: number;
  damages: number;
  upsells: number;
  upsellValue: number;
  complaints: number;
}

// Alias: create/update operations return the same shape as list items.
export type TechnicianRecord = TechnicianListItem;

// ---- input types ------------------------------------------------------------

export interface CreateTechnicianInput {
  name?: string | null;
  phone?: string | null;
  role?: string | null;
  email?: string | null;
  notes?: string | null;
  // A technician can cover more than one service area (see
  // TechnicianServiceArea, a true many-to-many join table) — omitted/empty
  // means no areas assigned.
  serviceAreaIds?: string[];
}

export interface UpdateTechnicianInput {
  name?: string | null;
  phone?: string | null;
  role?: string | null;
  email?: string | null;
  notes?: string | null;
  active?: boolean;
  // undefined = no change; [] = clear all areas; non-empty = replace with these
  serviceAreaIds?: string[];
}

// ---- Prisma includes --------------------------------------------------------

export const techInclude = {
  serviceAreas: {
    select: {
      serviceAreaId: true,
      assignedAt: true,
      serviceArea: { select: { name: true } },
    },
  },
} satisfies Prisma.TechnicianInclude;

export type TechWithAreas = Prisma.TechnicianGetPayload<{ include: typeof techInclude }>;

export function mapServiceAreas(tech: TechWithAreas): TechnicianServiceAreaRow[] {
  return tech.serviceAreas.map((sa) => ({
    serviceAreaId: sa.serviceAreaId,
    serviceAreaName: sa.serviceArea.name,
    assignedAt: sa.assignedAt,
  }));
}

function toRecord(tech: TechWithAreas): TechnicianRecord {
  return {
    id: tech.id,
    name: tech.name,
    phone: tech.phone,
    role: tech.role,
    email: tech.email,
    notes: tech.notes,
    active: tech.active,
    appStatus: deriveAppStatus(tech.active, tech.profileId),
    serviceAreas: mapServiceAreas(tech),
    createdAt: tech.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class TechnicianService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async listTechnicians(): Promise<TechnicianListRow[]> {
    const { start, end } = todayRange();

    const [technicians, todayGroups] = await Promise.all([
      this.prisma.technician.findMany({
        include: {
          ...techInclude,
          roundTechnicians: { select: { round: { select: { name: true } } } },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.visit.groupBy({
        by: ["technicianId", "status"],
        where: { technicianId: { not: null }, date: { gte: start, lt: end } },
        _count: true,
      }),
    ]);

    const statsMap = new Map<string, TodayStats>();
    for (const g of todayGroups as Array<{ technicianId: string | null; status: VisitStatus; _count: number }>) {
      if (!g.technicianId) continue;
      const stats = statsMap.get(g.technicianId) ?? { total: 0, completed: 0, skipped: 0, remaining: 0 };
      stats.total += g._count;
      if (g.status === VisitStatus.COMPLETED) stats.completed += g._count;
      else if (g.status === VisitStatus.SKIPPED) stats.skipped += g._count;
      else if (g.status === VisitStatus.SCHEDULED || g.status === VisitStatus.IN_PROGRESS) stats.remaining += g._count;
      statsMap.set(g.technicianId, stats);
    }

    return technicians.map((tech) => ({
      ...toRecord(tech),
      roundNames: tech.roundTechnicians.map((rt) => rt.round.name),
      todayStats: statsMap.get(tech.id) ?? { total: 0, completed: 0, skipped: 0, remaining: 0 },
    }));
  }

  async getTechnicianDetail(id: string): Promise<TechnicianDetail> {
    const { start, end } = todayRange();

    const [tech, todayVisits] = await Promise.all([
      this.prisma.technician.findUnique({
        where: { id },
        include: {
          ...techInclude,
          roundTechnicians: {
            select: { round: { select: { id: true, name: true } } },
          },
        },
      }),
      this.prisma.visit.findMany({
        where: { technicianId: id, date: { gte: start, lt: end } },
        select: {
          status: true,
          roundId: true,
          round: { select: { id: true, name: true } },
        },
      }),
    ]);
    if (!tech) throw new AppError(404, "Technician not found");

    // Build per-round workload rows
    const byRound = new Map<string, { name: string; visits: typeof todayVisits }>();
    for (const v of todayVisits) {
      if (!v.roundId || !v.round) continue;
      const bucket = byRound.get(v.roundId) ?? { name: v.round.name, visits: [] };
      bucket.visits.push(v);
      byRound.set(v.roundId, bucket);
    }

    const todayWorkload: WorkloadRoundRow[] = Array.from(byRound.entries()).map(
      ([roundId, { name, visits }]) => {
        const completed = visits.filter((v) => v.status === VisitStatus.COMPLETED).length;
        const skipped = visits.filter((v) => v.status === VisitStatus.SKIPPED).length;
        const remaining = visits.filter(
          (v) =>
            v.status === VisitStatus.SCHEDULED || v.status === VisitStatus.IN_PROGRESS
        ).length;
        return { roundId, roundName: name, total: visits.length, completed, skipped, remaining };
      }
    );

    return {
      ...toRecord(tech),
      roundNames: tech.roundTechnicians.map((rt) => rt.round.name),
      todayWorkload,
    };
  }

  async getPerformance(id: string, period: KpiPeriod, now: Date): Promise<TechnicianPerformance> {
    const tech = await this.prisma.technician.findUnique({ where: { id }, select: { id: true } });
    if (!tech) throw new AppError(404, "Technician not found");
    const range = periodRange(period, now);
    const k = (await computeTechnicianKpis(this.prisma, range, [id])).get(id) ?? emptyKpis();
    return {
      technicianId: id,
      period,
      from: range.start,
      to: range.end,
      visitsCompleted: k.jobsCompleted,
      revenue: k.valueCompleted,
      timeOnJobMinutes: k.timeOnJobMinutes,
      revenuePerHour: k.revenuePerHour,
      strikes: k.strikes,
      damages: k.damages,
      upsells: k.upsells,
      upsellValue: k.upsellValue,
      complaints: k.complaints,
    };
  }

  // Validates every id in `areaIds` exists; throws AppError(404) naming
  // whichever ones don't.
  private async assertServiceAreasExist(
    prisma: Pick<TenantPrismaClient, "serviceArea">,
    areaIds: string[]
  ): Promise<void> {
    if (areaIds.length === 0) return;
    const found = await prisma.serviceArea.findMany({
      where: { id: { in: areaIds } },
      select: { id: true },
    });
    if (found.length === areaIds.length) return;
    const foundSet = new Set(found.map((a) => a.id));
    const missing = areaIds.filter((id) => !foundSet.has(id));
    throw new AppError(404, `Service area(s) not found: ${missing.join(", ")}`);
  }

  async createTechnician(input: CreateTechnicianInput): Promise<TechnicianRecord> {
    const areaIds = [...new Set(input.serviceAreaIds ?? [])];
    await this.assertServiceAreasExist(this.prisma, areaIds);

    let tech;
    try {
      tech = await this.prisma.technician.create({
        data: {
          name: input.name ?? null,
          phone: input.phone ?? null,
          role: input.role ?? null,
          email: input.email ?? null,
          notes: input.notes ?? null,
          ...(areaIds.length > 0
            ? { serviceAreas: { create: areaIds.map((serviceAreaId) => ({ serviceAreaId })) } }
            : {}),
        },
        include: techInclude,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError(409, "A technician with this email already exists");
      }
      throw err;
    }

    return toRecord(tech);
  }

  async updateTechnician(id: string, input: UpdateTechnicianInput): Promise<TechnicianRecord> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.technician.findUnique({ where: { id } });
      if (!existing) throw new AppError(404, "Technician not found");

      const areaIds =
        input.serviceAreaIds !== undefined ? [...new Set(input.serviceAreaIds)] : undefined;
      if (areaIds !== undefined) {
        await this.assertServiceAreasExist(tx, areaIds);
      }

      let tech;
      try {
        tech = await tx.technician.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(input.role !== undefined ? { role: input.role } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
          include: techInclude,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new AppError(409, "A technician with this email already exists");
        }
        throw err;
      }

      // Replace-semantics for service areas: [] = clear all, non-empty = replace
      if (areaIds !== undefined) {
        await tx.technicianServiceArea.deleteMany({ where: { technicianId: id } });
        if (areaIds.length > 0) {
          await tx.technicianServiceArea.createMany({
            data: areaIds.map((serviceAreaId) => ({ technicianId: id, serviceAreaId })),
          });
        }
        // Re-fetch to get fresh serviceAreas after mutation
        const refreshed = await tx.technician.findUnique({
          where: { id },
          include: techInclude,
        });
        if (!refreshed) throw new AppError(500, "Technician disappeared mid-transaction");
        return toRecord(refreshed);
      }

      return toRecord(tech);
    });
  }
}

export function createTechnicianService(prisma: TenantPrismaClient) {
  return new TechnicianService(prisma);
}
