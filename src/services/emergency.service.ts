import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

export interface AvailableTechnicianRow {
  technicianId: string;
  technicianName: string | null;
  avatarUrl: string | null;
  jobsRemaining: number;
  availability: "AVAILABLE" | "BUSY";
}

export interface ReportEmergencyInput {
  technicianId: string;
  roundId: string;
  remainingStops: number;
  lastLocation?: string;
  scheduledWindowEnd?: Date;
  notes?: string;
}

export interface EmergencyRow {
  id: string;
  technicianId: string;
  technicianName: string | null;
  roundId: string;
  roundName: string;
  remainingStops: number;
  lastLocation: string | null;
  scheduledWindowEnd: Date | null;
  notes: string | null;
  status: "ACTIVE" | "RESOLVED";
  assignedTechnicianId: string | null;
  assignedTechnicianName: string | null;
  resolvedAt: Date | null;
  reportedAt: Date;
}

export function createEmergencyService(prisma: TenantPrismaClient) {
  return {
    reportEmergency: async (input: ReportEmergencyInput): Promise<EmergencyRow> => {
      const [technician, round] = await Promise.all([
        prisma.technician.findUnique({ where: { id: input.technicianId }, select: { id: true, name: true } }),
        prisma.round.findUnique({ where: { id: input.roundId }, select: { id: true, name: true } }),
      ]);

      if (!technician) throw new AppError(404, "Technician not found");
      if (!round) throw new AppError(404, "Round not found");

      const emergency = await prisma.technicianEmergency.create({
        data: {
          technicianId: input.technicianId,
          roundId: input.roundId,
          remainingStops: input.remainingStops,
          lastLocation: input.lastLocation ?? null,
          scheduledWindowEnd: input.scheduledWindowEnd ?? null,
          notes: input.notes ?? null,
        },
      });

      return {
        id: emergency.id,
        technicianId: emergency.technicianId,
        technicianName: technician.name,
        roundId: emergency.roundId,
        roundName: round.name,
        remainingStops: emergency.remainingStops,
        lastLocation: emergency.lastLocation,
        scheduledWindowEnd: emergency.scheduledWindowEnd,
        notes: emergency.notes,
        status: emergency.status as "ACTIVE" | "RESOLVED",
        assignedTechnicianId: null,
        assignedTechnicianName: null,
        resolvedAt: null,
        reportedAt: emergency.reportedAt,
      };
    },

    reassign: async (emergencyId: string, newTechnicianId: string): Promise<EmergencyRow> => {
      const emergency = await prisma.technicianEmergency.findUnique({
        where: { id: emergencyId },
        select: { id: true, status: true, technicianId: true, roundId: true },
      });
      if (!emergency) throw new AppError(404, "Emergency not found");
      if (emergency.status === "RESOLVED") {
        throw new AppError(409, "Emergency is already resolved");
      }

      const newTechnician = await prisma.technician.findUnique({
        where: { id: newTechnicianId },
        select: { id: true, name: true },
      });
      if (!newTechnician) throw new AppError(404, "Technician not found");

      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);
      const now = new Date();

      const [updated] = await prisma.$transaction([
        prisma.technicianEmergency.update({
          where: { id: emergencyId },
          data: {
            status: "RESOLVED",
            assignedTechnicianId: newTechnicianId,
            resolvedAt: now,
          },
          include: {
            technician: { select: { id: true, name: true } },
            round: { select: { id: true, name: true } },
            assignedTechnician: { select: { id: true, name: true } },
          },
        }),
        prisma.visit.updateMany({
          where: {
            roundId: emergency.roundId,
            technicianId: emergency.technicianId,
            date: { gte: dayStart, lt: dayEnd },
            status: { in: ["SCHEDULED", "IN_PROGRESS"] },
          },
          data: { technicianId: newTechnicianId },
        }),
      ]);

      return {
        id: updated.id,
        technicianId: updated.technicianId,
        technicianName: updated.technician.name,
        roundId: updated.roundId,
        roundName: updated.round.name,
        remainingStops: updated.remainingStops,
        lastLocation: updated.lastLocation,
        scheduledWindowEnd: updated.scheduledWindowEnd,
        notes: updated.notes,
        status: updated.status as "ACTIVE" | "RESOLVED",
        assignedTechnicianId: updated.assignedTechnicianId,
        assignedTechnicianName: updated.assignedTechnician?.name ?? null,
        resolvedAt: updated.resolvedAt,
        reportedAt: updated.reportedAt,
      };
    },

    getAvailableTechnicians: async (emergencyId: string): Promise<AvailableTechnicianRow[]> => {
      const emergency = await prisma.technicianEmergency.findUnique({
        where: { id: emergencyId },
        select: { technicianId: true },
      });
      if (!emergency) throw new AppError(404, "Emergency not found");

      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);

      const [technicians, remainingVisits] = await Promise.all([
        prisma.technician.findMany({
          where: { active: true, id: { not: emergency.technicianId } },
          select: { id: true, name: true, avatarUrl: true },
        }),
        prisma.visit.groupBy({
          by: ["technicianId"],
          where: {
            date: { gte: dayStart, lt: dayEnd },
            status: { in: ["SCHEDULED", "IN_PROGRESS"] },
            technicianId: { not: null },
          },
          _count: { id: true },
        }),
      ]);

      const remainingMap = new Map<string, number>();
      for (const row of remainingVisits) {
        if (row.technicianId) remainingMap.set(row.technicianId, row._count.id);
      }

      return technicians.map((t) => {
        const jobsRemaining = remainingMap.get(t.id) ?? 0;
        return {
          technicianId: t.id,
          technicianName: t.name,
          avatarUrl: t.avatarUrl,
          jobsRemaining,
          availability: jobsRemaining === 0 ? "AVAILABLE" : "BUSY",
        };
      });
    },

    getEmergency: async (id: string): Promise<EmergencyRow> => {
      const e = await prisma.technicianEmergency.findUnique({
        where: { id },
        include: {
          technician: { select: { id: true, name: true } },
          round: { select: { id: true, name: true } },
          assignedTechnician: { select: { id: true, name: true } },
        },
      });

      if (!e) throw new AppError(404, "Emergency not found");

      return {
        id: e.id,
        technicianId: e.technicianId,
        technicianName: e.technician.name,
        roundId: e.roundId,
        roundName: e.round.name,
        remainingStops: e.remainingStops,
        lastLocation: e.lastLocation,
        scheduledWindowEnd: e.scheduledWindowEnd,
        notes: e.notes,
        status: e.status as "ACTIVE" | "RESOLVED",
        assignedTechnicianId: e.assignedTechnicianId,
        assignedTechnicianName: e.assignedTechnician?.name ?? null,
        resolvedAt: e.resolvedAt,
        reportedAt: e.reportedAt,
      };
    },

    listEmergencies: async (status?: "ACTIVE" | "RESOLVED"): Promise<EmergencyRow[]> => {
      const rows = await prisma.technicianEmergency.findMany({
        where: status ? { status } : undefined,
        orderBy: { reportedAt: "desc" },
        include: {
          technician: { select: { id: true, name: true } },
          round: { select: { id: true, name: true } },
          assignedTechnician: { select: { id: true, name: true } },
        },
      });

      return rows.map((e) => ({
        id: e.id,
        technicianId: e.technicianId,
        technicianName: e.technician.name,
        roundId: e.roundId,
        roundName: e.round.name,
        remainingStops: e.remainingStops,
        lastLocation: e.lastLocation,
        scheduledWindowEnd: e.scheduledWindowEnd,
        notes: e.notes,
        status: e.status as "ACTIVE" | "RESOLVED",
        assignedTechnicianId: e.assignedTechnicianId,
        assignedTechnicianName: e.assignedTechnician?.name ?? null,
        resolvedAt: e.resolvedAt,
        reportedAt: e.reportedAt,
      }));
    },
  };
}
