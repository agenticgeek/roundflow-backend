import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { CleaningFrequency, DayOfWeek, LifecycleStatus, RoundStatus, VisitStatus } from "../generated/tenant-client";
import { queueGhlEvent } from "../integrations/ghl/sync";
import { frequencyWeeks, startOfUtcDay } from "../lib/schedule";
import { activeClosures, advanceDueDate, isServedCycle, resolveClosedDate, visitDateFor, type ClosureWindow } from "../lib/closures";
import { resolveTechnicianForVisit, technicianIdsUnavailableOn } from "../services/visit-assignment";
import { tenantToday, tenantWorkingDays } from "../services/business-time";
import { pausePlan, resumePlan } from "../services/service-plan-lifecycle";

/** ActivityLog type written once per closure per run when whole cycles were skipped (SKIP closures). */
export const CLOSURE_CYCLES_SKIPPED_ACTIVITY = "CLOSURE_CYCLES_SKIPPED";

/** Skipped cycles collected during a run: closure id -> the closure and the raw visit dates skipped. */
type SkipLog = Map<string, { closure: ClosureWindow; dates: Date[] }>;

// The tenant's closures that ended no more than 366 days ago (so a catch-up cycle that fell inside a closure that has
// since ended is still moved/skipped), as UTC-midnight windows. Loaded once per run.
async function loadClosures(tp: TenantPrismaClient, today: Date): Promise<ClosureWindow[]> {
  const since = new Date(startOfUtcDay(today).getTime() - 366 * 86_400_000);
  const rows = await tp.businessClosure.findMany({ where: { endDate: { gte: since } } });
  return activeClosures(
    rows.map((c) => ({
      id: c.id,
      label: c.label,
      startDate: startOfUtcDay(c.startDate),
      endDate: startOfUtcDay(c.endDate),
      mode: c.mode,
      roundIds: c.roundIds,
    })),
    since
  );
}

// One activity row per closure that skipped cycles in this run.
async function writeSkipLog(tp: TenantPrismaClient, log: SkipLog): Promise<void> {
  for (const { closure, dates } of log.values()) {
    await tp.activityLog.create({
      data: {
        type: CLOSURE_CYCLES_SKIPPED_ACTIVITY,
        message: `Closure "${closure.label}" skipped ${dates.length} visit ${dates.length === 1 ? "cycle" : "cycles"}`,
        details: {
          closureId: closure.id,
          count: dates.length,
          skippedDates: dates.map((x) => x.toISOString().slice(0, 10)),
        },
      },
    });
  }
}

export async function runVisitGeneration(): Promise<void> {
  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });

  for (const tenant of tenants) {
    try {
      const tp = getTenantPrismaForSchema(tenant.schemaName);
      // EMU-6: "today" is the tenant's local calendar day, not the server's UTC day.
      await generateForTenant(tp, await tenantToday(tp));
    } catch (err) {
      console.error(`[visitGen] ${tenant.schemaName}:`, err);
    }
  }
}

type TP = ReturnType<typeof getTenantPrismaForSchema>;

export async function generateForTenant(tp: TP, today: Date): Promise<void> {
  // Pause transitions run whatever the tenant's generation setting is.
  await applyPauseTransitions(tp, today);

  // B2: tenants that turned off "auto-create next visit" get no generation.
  const settings = await tp.businessSettings.findFirst({ select: { autoCreateNextVisit: true, defaultWorkingDays: true } });
  if (settings?.autoCreateNextVisit === false) return;

  const rounds = await tp.round.findMany({
    where: { status: RoundStatus.ACTIVE },
    select: { id: true, frequency: true, defaultDay: true },
  });

  // Closures are loaded once for the whole run, never per round or per plan.
  const closures = await loadClosures(tp, today);
  const skipLog: SkipLog = new Map();
  for (const round of rounds) {
    await generateForRound(tp, round, today, settings?.defaultWorkingDays ?? [], closures, skipLog);
  }
  await writeSkipLog(tp, skipLog);
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
  today: Date,
  workingDaysArg?: readonly string[],
  closuresArg?: readonly ClosureWindow[],
  skipLogArg?: SkipLog
): Promise<number> {
  let created = 0;
  const workingDays = workingDaysArg ?? (await tenantWorkingDays(tp));
  const closures = closuresArg ?? (await loadClosures(tp, today));
  // Called by the tenant run: it writes the log once for all rounds. Called directly: this run writes its own.
  const skipLog: SkipLog = skipLogArg ?? new Map();

  const [properties, roundTechs] = await Promise.all([
    tp.property.findMany({
      where: { roundId: round.id, status: LifecycleStatus.ACTIVE },
      select: {
        id: true,
        customerId: true,
        assignedTechnicianId: true,
        servicePlans: {
          where: { status: LifecycleStatus.ACTIVE, nextDueDate: { lte: today } },
          select: {
            id: true, price: true, nextDueDate: true, cleaningFrequency: true, serviceId: true,
            pauseStartDate: true, pauseEndDate: true,
          },
        },
      },
    }),
    tp.roundTechnician.findMany({ where: { roundId: round.id, technician: { active: true } }, select: { technicianId: true } }),
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

      // rules s4: resolve the cycle against the closures; at most one visit per plan per run.
      const weeks = frequencyWeeks(freq);
      let due = plan.nextDueDate;
      let latestVisitDate: Date | null | undefined; // served-cycle guard input, fetched at most once per plan
      for (;;) {
        const rawDate = visitDateFor(due, round.defaultDay, workingDays);
        const resolution = resolveClosedDate({
          visitDate: rawDate, roundId: round.id, defaultDay: round.defaultDay ?? null, workingDays, closures,
        });

        let served = false;
        if (resolution.action === "SKIP") {
          const closure = closures.find((c) => c.id === resolution.closureId)!;
          const entry = skipLog.get(closure.id) ?? { closure, dates: [] };
          entry.dates.push(rawDate);
          skipLog.set(closure.id, entry);
          served = true;
        } else {
          if (latestVisitDate === undefined) {
            const latest = await tp.visit.findFirst({
              where: { servicePlanId: plan.id, isOneOff: false, status: { not: VisitStatus.CANCELLED } },
              orderBy: { date: "desc" },
              select: { date: true },
            });
            latestVisitDate = latest?.date ?? null;
          }
          served = isServedCycle(resolution.date, latestVisitDate);
        }

        if (served) {
          // Nothing created for a skipped or already served cycle: advance and look at the next one.
          due = advanceDueDate(due, rawDate, { weeks, defaultDay: round.defaultDay ?? null, workingDays });
          if (due <= today) continue;
          break;
        }

        // resolution is KEEP or MOVE here (SKIP is always "served").
        const visitDate = (resolution as { date: Date }).date;

        // A4: a future-dated pause keeps the plan ACTIVE until its start date;
        // don't mint a visit inside the window (the nightly step flips it to
        // PAUSED, and resume recomputes nextDueDate).
        if (
          plan.pauseStartDate && visitDate >= plan.pauseStartDate &&
          (!plan.pauseEndDate || visitDate <= plan.pauseEndDate)
        ) break;

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
            // BUG-02: new visits are never auto-held. A manual hold (debt board /
            // Pause service) acts on the customer and is enforced by the debt gate.
            paymentHold:  false,
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

        // Advance nextDueDate one cycle from the ORIGINAL date, never from a moved one.
        due = advanceDueDate(due, rawDate, { weeks, defaultDay: round.defaultDay ?? null, workingDays });
        break;
      }

      if (due.getTime() !== plan.nextDueDate.getTime()) {
        await tp.servicePlan.update({ where: { id: plan.id }, data: { nextDueDate: due } });
      }
    }
  }

  if (!skipLogArg) await writeSkipLog(tp, skipLog);

  return created;
}
