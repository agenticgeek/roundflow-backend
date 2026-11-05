import { IncidentType, Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

// Strikes, damage and upsells recorded against a technician (B6 · GAP-025).
// Counted by technician-kpi.service.ts.

export interface IncidentCreateInput {
  type: IncidentType;
  amount?: number | null;
  note: string;
  visitId?: string | null;
  createdById: string | null;
}

export interface IncidentListFilters {
  type?: IncidentType;
  from?: Date; // inclusive
  to?: Date; // inclusive (whole day)
  page: number;
  pageSize: number;
}

export interface IncidentRow {
  id: string;
  technicianId: string;
  visitId: string | null;
  type: IncidentType;
  amount: number | null;
  note: string | null;
  createdById: string | null;
  createdAt: Date;
}

type IncidentRecord = Prisma.TechnicianIncidentGetPayload<object>;

function toRow(i: IncidentRecord): IncidentRow {
  return {
    id: i.id,
    technicianId: i.technicianId,
    visitId: i.visitId,
    type: i.type,
    amount: i.amount == null ? null : Number(i.amount),
    note: i.note,
    createdById: i.createdById,
    createdAt: i.createdAt,
  };
}

const DAY_MS = 86_400_000;

export function createTechnicianIncidentService(tp: TenantPrismaClient) {
  const assertTechnician = async (id: string) => {
    const tech = await tp.technician.findUnique({ where: { id }, select: { id: true } });
    if (!tech) throw new AppError(404, "Technician not found");
  };

  return {
    async create(technicianId: string, input: IncidentCreateInput): Promise<IncidentRow> {
      await assertTechnician(technicianId);
      if (input.visitId) {
        const visit = await tp.visit.findUnique({ where: { id: input.visitId }, select: { id: true } });
        if (!visit) throw new AppError(404, "Visit not found");
      }
      const row = await tp.technicianIncident.create({
        data: {
          technicianId,
          type: input.type,
          amount: input.amount ?? null,
          note: input.note,
          visitId: input.visitId ?? null,
          createdById: input.createdById,
        },
      });
      return toRow(row);
    },

    async list(technicianId: string, filters: IncidentListFilters) {
      await assertTechnician(technicianId);
      const createdAt: Prisma.DateTimeFilter = {};
      if (filters.from) createdAt.gte = filters.from;
      if (filters.to) createdAt.lt = new Date(filters.to.getTime() + DAY_MS);
      const where: Prisma.TechnicianIncidentWhereInput = {
        technicianId,
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.from || filters.to ? { createdAt } : {}),
      };
      const { page, pageSize } = filters;
      const [total, rows] = await Promise.all([
        tp.technicianIncident.count({ where }),
        tp.technicianIncident.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]);
      return {
        rows: rows.map(toRow),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      };
    },

    async remove(id: string): Promise<void> {
      const existing = await tp.technicianIncident.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new AppError(404, "Incident not found");
      await tp.technicianIncident.delete({ where: { id } });
    },
  };
}
