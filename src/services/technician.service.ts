import { VisitStatus, Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import type { AppStatus } from "./settings.service";

// ---------------------------------------------------------------------------
// M9 — Technicians CRUD (BE-M9-02).
// ---------------------------------------------------------------------------

// ---- helpers ----------------------------------------------------------------

function todayRange(): { start: Date; end: Date } {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export type { AppStatus };

function deriveAppStatus(active: boolean, profileId: string | null): AppStatus {
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

// Alias: create/update operations return the same shape as list items.
export type TechnicianRecord = TechnicianListItem;

// ---- input types ------------------------------------------------------------

export interface CreateTechnicianInput {
  name?: string | null;
  phone?: string | null;
  role?: string | null;
  email?: string | null;
  notes?: string | null;
  serviceAreaId?: string | null;
}

export interface UpdateTechnicianInput {
  name?: string | null;
  phone?: string | null;
  role?: string | null;
  email?: string | null;
  notes?: string | null;
  active?: boolean;
  // undefined = no change; null = clear all areas; string = replace with this area
  serviceAreaId?: string | null;
}

// ---- Prisma includes --------------------------------------------------------

const techInclude = {
  serviceAreas: {
    select: {
      serviceAreaId: true,
      assignedAt: true,
      serviceArea: { select: { name: true } },
    },
  },
} satisfies Prisma.TechnicianInclude;

type TechWithAreas = Prisma.TechnicianGetPayload<{ include: typeof techInclude }>;

function mapServiceAreas(tech: TechWithAreas): TechnicianServiceAreaRow[] {
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

// ---- contract ---------------------------------------------------------------

export interface ITechnicianService {
  listTechnicians(): Promise<TechnicianListItem[]>;
  getTechnicianDetail(id: string): Promise<TechnicianDetail>;
  createTechnician(input: CreateTechnicianInput): Promise<TechnicianRecord>;
  updateTechnician(id: string, input: UpdateTechnicianInput): Promise<TechnicianRecord>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class TechnicianService implements ITechnicianService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async listTechnicians(): Promise<TechnicianListItem[]> {
    const technicians = await this.prisma.technician.findMany({
      include: techInclude,
      orderBy: { createdAt: "asc" },
    });

    return technicians.map(toRecord);
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

  async createTechnician(input: CreateTechnicianInput): Promise<TechnicianRecord> {
    if (input.serviceAreaId) {
      const area = await this.prisma.serviceArea.findUnique({ where: { id: input.serviceAreaId } });
      if (!area) throw new AppError(404, "Service area not found");
    }

    const tech = await this.prisma.technician.create({
      data: {
        name: input.name ?? null,
        phone: input.phone ?? null,
        role: input.role ?? null,
        email: input.email ?? null,
        notes: input.notes ?? null,
        ...(input.serviceAreaId
          ? { serviceAreas: { create: { serviceAreaId: input.serviceAreaId } } }
          : {}),
      },
      include: techInclude,
    });

    return toRecord(tech);
  }

  async updateTechnician(id: string, input: UpdateTechnicianInput): Promise<TechnicianRecord> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.technician.findUnique({ where: { id } });
      if (!existing) throw new AppError(404, "Technician not found");

      if (input.serviceAreaId !== undefined && input.serviceAreaId !== null) {
        const area = await tx.serviceArea.findUnique({ where: { id: input.serviceAreaId } });
        if (!area) throw new AppError(404, "Service area not found");
      }

      const tech = await tx.technician.update({
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

      // Replace-semantics for service area: null = clear, string = replace
      if (input.serviceAreaId !== undefined) {
        await tx.technicianServiceArea.deleteMany({ where: { technicianId: id } });
        if (input.serviceAreaId !== null) {
          await tx.technicianServiceArea.create({
            data: { technicianId: id, serviceAreaId: input.serviceAreaId },
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

export function createTechnicianService(prisma: TenantPrismaClient): ITechnicianService {
  return new TechnicianService(prisma);
}
