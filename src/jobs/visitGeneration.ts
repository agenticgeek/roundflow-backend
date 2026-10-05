import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { CleaningFrequency, LifecycleStatus, RoundStatus, VisitStatus } from "../generated/tenant-client";

const FREQ_WEEKS: Record<CleaningFrequency, number> = {
  FOUR_WEEKLY:   4,
  SIX_WEEKLY:    6,
  EIGHT_WEEKLY:  8,
  TWELVE_WEEKLY: 12,
};

function addWeeks(date: Date, weeks: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d;
}

// Snap to nearest working day: Sat → Mon, Sun → Mon
function snapToWeekday(date: Date): Date {
  const day = date.getUTCDay();
  if (day === 6) date.setUTCDate(date.getUTCDate() + 2);
  else if (day === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

export async function runVisitGeneration(): Promise<void> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });

  for (const tenant of tenants) {
    try {
      await generateForTenant(getTenantPrismaForSchema(tenant.schemaName), today);
    } catch (err) {
      console.error(`[visitGen] ${tenant.schemaName}:`, err);
    }
  }
}

type TP = ReturnType<typeof getTenantPrismaForSchema>;

async function generateForTenant(tp: TP, today: Date): Promise<void> {
  const rounds = await tp.round.findMany({
    where: { status: RoundStatus.ACTIVE },
    select: { id: true, frequency: true },
  });

  for (const round of rounds) {
    const properties = await tp.property.findMany({
      where: { roundId: round.id, status: LifecycleStatus.ACTIVE },
      select: {
        id: true,
        servicePlans: {
          where: { status: LifecycleStatus.ACTIVE, nextDueDate: { lte: today } },
          select: { id: true, price: true, nextDueDate: true, cleaningFrequency: true, serviceId: true },
        },
      },
    });

    for (const property of properties) {
      for (const plan of property.servicePlans) {
        const freq = plan.cleaningFrequency ?? round.frequency;
        if (!freq || !plan.nextDueDate) continue;

        // Idempotent: skip if a future scheduled/in-progress visit already exists
        const existing = await tp.visit.findFirst({
          where: {
            servicePlanId: plan.id,
            status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS] },
            date: { gte: today },
          },
          select: { id: true },
        });
        if (existing) continue;

        const visitDate = snapToWeekday(new Date(plan.nextDueDate));
        await tp.visit.create({
          data: {
            propertyId:   property.id,
            roundId:      round.id,
            servicePlanId: plan.id,
            serviceId:    plan.serviceId ?? null,
            date:         visitDate,
            price:        plan.price,
            isOneOff:     false,
            status:       VisitStatus.SCHEDULED,
            paymentHold:  false,
          },
        });

        // Advance nextDueDate by one cycle
        await tp.servicePlan.update({
          where: { id: plan.id },
          data: { nextDueDate: snapToWeekday(addWeeks(new Date(plan.nextDueDate), FREQ_WEEKS[freq])) },
        });
      }
    }
  }
}
