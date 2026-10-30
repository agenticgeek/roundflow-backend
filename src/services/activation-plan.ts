import { LifecycleStatus, VisitStatus, PaymentMethod, Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { enumerateActivationVisits, nextDueAfter } from "../lib/schedule";
import { resolveTechnicianForVisit } from "./visit-assignment";

// Setup step 11 (A2 / GAP-016): which visits activation creates. POST
// /setup/step/11 and GET /setup/step/11/preview both go through
// loadActivationInputs + buildActivationPlan, so the preview count can never
// drift from what activation actually writes.

export const activationRoundInclude = {
  roundTechnicians: { select: { technicianId: true } },
  properties: {
    where: { status: LifecycleStatus.ACTIVE },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      assignedTechnicianId: true,
      customer: { select: { holdNextClean: true } },
      servicePlans: {
        where: { status: LifecycleStatus.ACTIVE },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { id: true, price: true, paymentMethod: true, cleaningFrequency: true },
      },
    },
  },
} satisfies Prisma.RoundInclude;

export type ActivationRound = Prisma.RoundGetPayload<{ include: typeof activationRoundInclude }>;

export type AvailabilityWindow = { technicianId: string; from: Date; to: Date };

export interface PlannedVisit {
  date: Date;
  status: VisitStatus;
  price: Prisma.Decimal;
  propertyId: string;
  roundId: string;
  servicePlanId: string;
  paymentMethod: PaymentMethod | null;
  technicianId: string | null;
  paymentHold: boolean;
}

export interface ActivationPlan {
  visits: PlannedVisit[];
  rounds: Array<{ roundId: string; name: string; firstVisit: Date | null; visits: number }>;
  // Where the nightly generator continues each series: one cycle after the
  // last activation visit (null-frequency plans are one-offs and get none).
  nextDueDates: Array<{ servicePlanId: string; nextDueDate: Date }>;
  total: number;
}

export async function loadActivationInputs(
  tp: TenantPrismaClient,
  where: Prisma.RoundWhereInput,
  window: { startDate: Date; cycleEndDate: Date }
): Promise<{ rounds: ActivationRound[]; windows: AvailabilityWindow[] }> {
  const rounds = await tp.round.findMany({ where, include: activationRoundInclude, orderBy: { createdAt: "asc" } });
  const technicianIds = [...new Set(rounds.flatMap((r) => r.roundTechnicians.map((rt) => rt.technicianId)))];
  const windows = technicianIds.length
    ? await tp.technicianAvailability.findMany({
        where: { technicianId: { in: technicianIds }, from: { lt: window.cycleEndDate }, to: { gte: window.startDate } },
        select: { technicianId: true, from: true, to: true },
      })
    : [];
  return { rounds, windows };
}

export function buildActivationPlan(
  rounds: ActivationRound[],
  input: { startDate: Date; cycleEndDate: Date; windows: AvailabilityWindow[] }
): ActivationPlan {
  const plan: ActivationPlan = { visits: [], rounds: [], nextDueDates: [], total: 0 };

  for (const round of rounds) {
    const roundTechnicianIds = round.roundTechnicians.map((rt) => rt.technicianId);
    let firstVisit: Date | null = null;
    let count = 0;

    for (const property of round.properties) {
      const servicePlan = property.servicePlans[0];
      if (!servicePlan) continue;

      // A plan without its own frequency follows the round's.
      const frequency = servicePlan.cleaningFrequency ?? round.frequency;
      const dates = enumerateActivationVisits({
        startDate: input.startDate,
        cycleEndDate: input.cycleEndDate,
        defaultDay: round.defaultDay,
        frequency,
      });

      for (const [i, date] of dates.entries()) {
        const unavailableTechnicianIds = input.windows
          .filter((w) => w.from <= date && w.to >= date)
          .map((w) => w.technicianId);
        plan.visits.push({
          date,
          status: VisitStatus.SCHEDULED,
          price: servicePlan.price,
          propertyId: property.id,
          roundId: round.id,
          servicePlanId: servicePlan.id,
          paymentMethod: servicePlan.paymentMethod,
          technicianId: resolveTechnicianForVisit({
            assignedTechnicianId: property.assignedTechnicianId,
            roundTechnicianIds,
            unavailableTechnicianIds,
          }),
          // A3: a customer on hold has their next clean held — the first one.
          paymentHold: i === 0 && property.customer.holdNextClean,
        });
      }
      count += dates.length;
      if (dates.length > 0 && (!firstVisit || dates[0] < firstVisit)) firstVisit = dates[0];

      if (frequency && dates.length > 0) {
        plan.nextDueDates.push({
          servicePlanId: servicePlan.id,
          nextDueDate: nextDueAfter(dates[dates.length - 1], frequency, round.defaultDay),
        });
      }
    }

    plan.rounds.push({ roundId: round.id, name: round.name, firstVisit, visits: count });
    plan.total += count;
  }
  return plan;
}
