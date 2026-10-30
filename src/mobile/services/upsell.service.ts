import { IncidentType } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";

// B6: a technician records an upsell on the job (counts toward their KPIs).
export interface UpsellRow {
  id: string;
  type: IncidentType;
  amount: number;
  note: string | null;
  visitId: string | null;
  createdAt: Date;
}

export function createUpsellService(tp: TenantPrismaClient) {
  return {
    async recordUpsell(input: {
      visitId: string;
      technicianId: string;
      createdById: string;
      description: string;
      amount: number;
    }): Promise<UpsellRow> {
      const row = await tp.technicianIncident.create({
        data: {
          technicianId: input.technicianId,
          visitId: input.visitId,
          type: IncidentType.UPSELL,
          amount: input.amount,
          note: input.description,
          createdById: input.createdById,
        },
        select: { id: true, type: true, amount: true, note: true, visitId: true, createdAt: true },
      });
      return { ...row, amount: Number(row.amount) };
    },
  };
}
