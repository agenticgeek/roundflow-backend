import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { CleaningFrequency, DayOfWeek, LifecycleStatus, RoundStatus, VisitStatus } from "../generated/tenant-client";
import { queueGhlEvent } from "../integrations/ghl/sync";
import { nextDueAfter, nextOccurrenceOfDay, snapToWeekday, startOfUtcDay } from "../lib/schedule";
import { resolveTechnicianForVisit, technicianIdsUnavailableOn } from "../services/visit-assignment";
import { pausePlan, resumePlan } from "../services/service-plan-lifecycle";

// Visit date for a due plan: the round day on or after nextDueDate, or the
// nearest weekday when the round has no day.
function visitDateFor(nextDueDate: Date, defaultDay: DayOfWeek | null | undefined): Date {
  return defaultDay ? nextOccurrenceOfDay(nextDueDate, defaultDay) : snapToWeekday(startOfUtcDay(nextDueDate));
}

export async function runVisitGeneration(): Promise<void> {
  const today = startOfUtcDay(new Date());

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
  // Pause transitions run whatever the tenant's generation setting is.
  await applyPauseTransitions(tp, today);

  // B2: tenants that turned off "auto-create next visit" get no generation.
  const settings = await tp.businessSettings.findFirst({ select: { autoCreateNextVisit: true } });
  if (settings?.autoCreateNextVisit === false) return;

  const rounds = await tp.round.findMany({
    where: { status: RoundStatus.ACTIVE },
    select: { id: true, frequency: true, defaultDay: true },
  });

  for (const round of rounds) {
    await generateForRound(tp, round, today);
  }
}

// A4 nightly step — delegates to service-plan-lifecycle so the manual
// pause/resume routes and the nightly job share one implementation.
// - ACTIVE plans whose (future-dated) pause has started go through pausePlan():
//   PAUSED, and their SCHEDULED visits inside the window cancelled (PAUSED).
// - PAUSED plans whose pauseEndDate has passed (end date inclusive) go through
//   resumePlan(): ACTIVE, pause dates cleared, nextDueDate = the round day on
//   or after today. Cancelled visits are not resurrected.
export async function applyPauseTransitions(tp: TenantPrismaClient, today: Date): Promise<void> {
  const starting = await tp.servicePlan.findMany({
    where: {
      status: LifecycleStatus.ACTIVE,
      pauseStartDate: { lte: today },
      OR: [{ pauseEndDate: null }, { pauseEndDate: { gte: today } }],
    },
    select: { id: true, pauseStartDate: true, pauseEndDate: true },
  });
  for (const plan of starting) {
    await pausePlan(tp, plan, { pauseStartDate: plan.pauseStartDate!, pauseEndDate: plan.pauseEndDate }, today);
  }

  const ending = await tp.servicePlan.findMany({
    where: { status: LifecycleStatus.PAUSED, pauseEndDate: { lt: today } },
    select: { id: true, propertyId: true },
  });
  for (const plan of ending) {
    await resumePlan(tp, plan, today);
  }
}

// Shared by the nightly cron (one round at a time, for every ACTIVE round)
// and the on-demand POST /rounds/:id/generate-visits endpoint (one round,
// right now — so a round created after setup doesn't wait for the next
// nightly run before it has any visits).
export async function generateForRound(
  tp: TenantPrismaClient,
  round: { id: string; frequency: CleaningFrequency | null; defaultDay?: DayOfWeek | null },
  today: Date
): Promise<number> {
  let created = 0;

  const [properties, roundTechs] = await Promise.all([
    tp.property.findMany({
      where: { roundId: round.id, status: LifecycleStatus.ACTIVE },
      select: {
        id: true,
        customerId: true,
        assignedTechnicianId: true,
        customer: { select: { holdNextClean: true } },
        servicePlans: {
          where: { status: LifecycleStatus.ACTIVE, nextDueDate: { lte: today } },
          select: {
            id: true, price: true, nextDueDate: true, cleaningFrequency: true, serviceId: true,
            pauseStartDate: true, pauseEndDate: true,
          },
        },
      },
    }),
    tp.roundTechnician.findMany({ where: { roundId: round.id }, select: { technicianId: true } }),
  ]);
  const roundTechnicianIds = roundTechs.map((r) => r.technicianId);

  // Availability lookups are per visit date; most plans of a round share one.
  const unavailableByDate = new Map<number, string[]>();
  const unavailableOn = async (date: Date): Promise<string[]> => {
    let ids = unavailableByDate.get(date.getTime());
    if (!ids) {
      ids = [...(await technicianIdsUnavailableOn(tp, date))];
      unavailableByDate.set(date.getTime(), ids);
    }
    return ids;
  };

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

      const visitDate = visitDateFor(plan.nextDueDate, round.defaultDay);

      // A4: a future-dated pause keeps the plan ACTIVE until its start date;
      // don't mint a visit inside the window (the nightly step flips it to
      // PAUSED, and resume recomputes nextDueDate).
      if (
        plan.pauseStartDate && visitDate >= plan.pauseStartDate &&
        (!plan.pauseEndDate || visitDate <= plan.pauseEndDate)
      ) continue;

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
          paymentHold:  property.customer.holdNextClean,
          technicianId: resolveTechnicianForVisit({
            assignedTechnicianId: property.assignedTechnicianId,
            roundTechnicianIds,
            unavailableTechnicianIds: await unavailableOn(visitDate),
          }),
        },
      });
      created++;

      // Drives the GHL "Pre-Clean Reminder" workflow (next_clean_date custom
      // field) — see docs/GHL_AUTOMATION_OWNER_HANDOFF.md §1/§3.
      queueGhlEvent(tp, "visit.scheduled", property.customerId, {
        nextCleanDate: visitDate.toISOString().slice(0, 10),
      }).catch(console.error);

      // Advance nextDueDate by one cycle from the visit just created
      const next = nextDueAfter(visitDate, freq, round.defaultDay);
      await tp.servicePlan.update({
        where: { id: plan.id },
        data: { nextDueDate: round.defaultDay ? next : snapToWeekday(next) },
      });
    }
  }

  return created;
}
