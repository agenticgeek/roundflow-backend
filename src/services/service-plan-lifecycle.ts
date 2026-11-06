import {
  CleaningFrequency,
  DayOfWeek,
  LifecycleStatus,
  PaymentMethod,
  Prisma,
  RoundStatus,
  VisitStatus,
} from "../generated/tenant-client";
import type { ServicePlan } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { notifyVisitTechnicians, visitCount, type VisitRef } from "./notify";
import {
  frequencyWeeks,
  initialNextDueDate,
  nextOccurrenceOfDay,
  snapToWeekday,
  startOfUtcDay,
} from "../lib/schedule";

// Pause / resume (A4 · GAP-020) and frequency change (B3 · GAP-018) for a
// single ServicePlan. CustomerService delegates here so property-level and
// per-plan routes share one implementation. The nightly job (visitGeneration)
// reads the same fields: a future pause is stored as status ACTIVE +
// pauseStartDate/pauseEndDate and flipped to PAUSED on pauseStartDate; a
// PAUSED plan whose pauseEndDate has passed is resumed via resumePlan().

export const CANCEL_REASON_PAUSED = "PAUSED";
export const CANCEL_REASON_FREQUENCY_CHANGED = "FREQUENCY_CHANGED";

const DAY_MS = 86_400_000;

export interface PauseWindow {
  pauseStartDate: Date;
  pauseEndDate?: Date | null;
}

export type PauseResult = ServicePlan & { cancelledVisits: number; pauseScheduled: boolean };

// Pause a plan. SCHEDULED visits of this plan inside [start, end] (end
// inclusive; open-ended = every visit from start on) are cancelled with
// reason PAUSED — also for a future start, so already-generated visits in the
// window never reach Today's Work. A start on or before today pauses the plan
// now; a later start keeps it ACTIVE with the window stored for the nightly job.
export async function pausePlan(
  tp: TenantPrismaClient,
  plan: Pick<ServicePlan, "id">,
  input: PauseWindow,
  now: Date
): Promise<PauseResult> {
  const today = startOfUtcDay(now);
  const start = startOfUtcDay(input.pauseStartDate);
  const endDay = input.pauseEndDate ? startOfUtcDay(input.pauseEndDate) : null;
  if (endDay && endDay <= start) throw new AppError(400, "pauseEndDate must be after pauseStartDate");
  const end = endDay ? new Date(endDay.getTime() + DAY_MS) : null;
  const startsNow = start <= today;

  let affected: VisitRef[] = [];
  const result = await tp.$transaction(async (tx) => {
    const window = {
      servicePlanId: plan.id,
      status: VisitStatus.SCHEDULED,
      date: end ? { gte: start, lt: end } : { gte: start },
    };
    affected = await tx.visit.findMany({
      where: window,
      select: { id: true, technicianId: true, date: true, roundId: true, propertyId: true },
    });
    const cancelled = await tx.visit.updateMany({
      where: window,
      data: { status: VisitStatus.CANCELLED, cancelReason: CANCEL_REASON_PAUSED },
    });
    const updated = await tx.servicePlan.update({
      where: { id: plan.id },
      data: {
        ...(startsNow ? { status: LifecycleStatus.PAUSED } : {}),
        // Stored as UTC midnight: the nightly job and visit generation compare
        // these against date-only values, so a time-of-day would shift the
        // window by a day.
        pauseStartDate: start,
        pauseEndDate: endDay,
      },
    });
    return { ...updated, cancelledVisits: cancelled.count, pauseScheduled: !startsNow };
  });
  await notifyVisitsCancelled(tp, affected, "The customer's service was paused.");
  return result;
}

// FLOW-03: technicians whose visits were cancelled hear about it. Best effort.
async function notifyVisitsCancelled(tp: TenantPrismaClient, visits: VisitRef[], reason: string): Promise<void> {
  await notifyVisitTechnicians(tp, visits, ({ count, first }) => ({
    type: "SCHEDULE",
    title: `${visitCount(count)} cancelled`,
    body: `${reason} First affected visit: ${first}.`,
  }));
}

// Resume a plan (manual, or the nightly job at pauseEndDate). The plan goes
// back to ACTIVE with the pause window cleared, and nextDueDate becomes the
// round's first defaultDay on or after `now` (a weekday-snapped `now` when
// the round has no day). Cancelled visits are not restored — the nightly
// generator creates the next one from nextDueDate.
export async function resumePlan(
  tp: TenantPrismaClient | Prisma.TransactionClient,
  plan: Pick<ServicePlan, "id" | "propertyId">,
  now: Date
): Promise<ServicePlan> {
  const property = await tp.property.findUnique({
    where: { id: plan.propertyId },
    select: { round: { select: { defaultDay: true } } },
  });
  const today = startOfUtcDay(now);
  const defaultDay = property?.round?.defaultDay ?? null;
  const workingDays = defaultDay ? [] : (await tp.businessSettings.findFirst({ select: { defaultWorkingDays: true } }))?.defaultWorkingDays ?? [];
  const nextDueDate = defaultDay ? nextOccurrenceOfDay(today, defaultDay) : snapToWeekday(today, workingDays);
  return tp.servicePlan.update({
    where: { id: plan.id },
    data: { status: LifecycleStatus.ACTIVE, pauseStartDate: null, pauseEndDate: null, nextDueDate },
  });
}

// ---- round move (B3) -------------------------------------------------------

export interface RoundMoveTarget {
  id: string;
  defaultDay: DayOfWeek | null;
  frequency: CleaningFrequency | null;
}

// B3: when a property joins a different round, its future SCHEDULED visits
// follow it (visits already started/finished are untouched), arrive
// unassigned (technicianId null, no manual override) and each ACTIVE plan's
// nextDueDate is recomputed for the new round's day. Callers update the
// property row itself (roundId + assignedTechnicianId: null). Visit dates are
// kept: only the round and technician change.
export async function moveFutureVisitsToRound(
  tx: Prisma.TransactionClient,
  input: { propertyId: string; target: RoundMoveTarget; now: Date }
): Promise<{ movedVisits: number }> {
  const today = startOfUtcDay(input.now);
  const moved = await tx.visit.updateMany({
    where: {
      propertyId: input.propertyId,
      status: VisitStatus.SCHEDULED,
      date: { gte: today },
      OR: [{ roundId: null }, { roundId: { not: input.target.id } }],
    },
    data: { roundId: input.target.id, technicianId: null, technicianOverride: false },
  });
  const plans = await tx.servicePlan.findMany({
    where: { propertyId: input.propertyId, status: LifecycleStatus.ACTIVE },
    select: { id: true, lastCompleted: true, cleaningFrequency: true },
  });
  for (const plan of plans) {
    const frequency = plan.cleaningFrequency ?? input.target.frequency;
    if (!frequency) continue;
    await tx.servicePlan.update({
      where: { id: plan.id },
      data: {
        nextDueDate: initialNextDueDate({
          lastCleanedDate: plan.lastCompleted,
          frequency,
          roundDefaultDay: input.target.defaultDay,
          today,
        }),
      },
    });
  }
  return { movedVisits: moved.count };
}

// ---- frequency change (B3) -------------------------------------------------

export interface PlanUpdateInput {
  price?: number;
  cleanMethod?: string | null;
  paymentMethod?: PaymentMethod | null;
  cleaningFrequency?: CleaningFrequency | null;
  createRoundIfMissing?: boolean;
}

export interface RoundSuggestion {
  id: string;
  name: string;
  frequency: CleaningFrequency | null;
  defaultDay: DayOfWeek | null;
}

export interface PlanUpdateResult {
  servicePlan: ServicePlan;
  movedToRound: { id: string; name: string; created: boolean } | null;
}

// 409 NO_MATCHING_ROUND carries the alternatives so the web can offer them
// (or offer to create `proposedName` by retrying with createRoundIfMissing).
export class NoMatchingRoundError extends AppError {
  constructor(
    message: string,
    public readonly suggestions: RoundSuggestion[],
    public readonly proposedName: string
  ) {
    super(409, message, "NO_MATCHING_ROUND");
    this.name = "NoMatchingRoundError";
  }
}

const DAY_LABELS: Record<DayOfWeek, string> = {
  MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat", SUN: "Sun",
};

// "<Area> <Day> <N>wk", e.g. "Alnwick Fri 6wk" (day omitted when the round has none).
export function autoRoundName(areaName: string, day: DayOfWeek | null, frequency: CleaningFrequency): string {
  return [areaName, day ? DAY_LABELS[day] : null, `${frequencyWeeks(frequency)}wk`].filter(Boolean).join(" ");
}

// PATCH /service-plans/:id. A cleaningFrequency that differs from the
// property's round moves the property to an ACTIVE round in the same service
// area with that frequency (same defaultDay preferred), creating one when
// createRoundIfMissing is set. Moving cancels the property's future SCHEDULED
// visits on the old round (reason FREQUENCY_CHANGED), clears the per-property
// technician allocation and recomputes nextDueDate for the new round's day.
export async function updatePlan(
  tp: TenantPrismaClient,
  servicePlanId: string,
  input: PlanUpdateInput,
  now: Date
): Promise<PlanUpdateResult> {
  const plan = await tp.servicePlan.findUnique({
    where: { id: servicePlanId },
    include: {
      property: {
        include: {
          serviceArea: { select: { name: true } },
          round: { include: { roundTechnicians: true, serviceArea: { select: { name: true } } } },
        },
      },
    },
  });
  if (!plan) throw new AppError(404, "Service plan not found");

  const data: Prisma.ServicePlanUpdateInput = {};
  if (input.price !== undefined) data.price = input.price;
  if (input.cleanMethod !== undefined) data.cleanMethod = input.cleanMethod;
  if (input.paymentMethod !== undefined) data.paymentMethod = input.paymentMethod;
  if (input.cleaningFrequency !== undefined) data.cleaningFrequency = input.cleaningFrequency;

  const frequency = input.cleaningFrequency;
  const round = plan.property.round;
  if (!frequency || !round || round.frequency === frequency) {
    const servicePlan = await tp.servicePlan.update({ where: { id: servicePlanId }, data });
    return { servicePlan, movedToRound: null };
  }

  const serviceAreaId = plan.property.serviceAreaId ?? round.serviceAreaId;
  const areaName = plan.property.serviceArea?.name ?? round.serviceArea?.name ?? round.name;
  const proposedName = autoRoundName(areaName, round.defaultDay, frequency);

  const candidates = await tp.round.findMany({
    where: { status: RoundStatus.ACTIVE, frequency, serviceAreaId, NOT: { id: round.id } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, defaultDay: true },
  });
  const match = candidates.find((r) => r.defaultDay === round.defaultDay) ?? candidates[0] ?? null;

  if (!match && !input.createRoundIfMissing) {
    const suggestions = await tp.round.findMany({
      where: { status: RoundStatus.ACTIVE, serviceAreaId, NOT: { id: round.id } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, frequency: true, defaultDay: true },
    });
    throw new NoMatchingRoundError(
      `No active ${frequencyWeeks(frequency)}-weekly round in ${areaName}. Retry with createRoundIfMissing to create "${proposedName}".`,
      suggestions,
      proposedName
    );
  }

  const today = startOfUtcDay(now);
  let cancelled: VisitRef[] = [];
  const outcome = await tp.$transaction(async (tx) => {
    let target = match;
    const created = target === null;
    if (target === null) {
      target = await tx.round.create({
        data: {
          name: proposedName,
          frequency,
          serviceAreaId,
          defaultDay: round.defaultDay,
          status: RoundStatus.ACTIVE,
        },
        select: { id: true, name: true, defaultDay: true },
      });
      if (round.roundTechnicians.length > 0) {
        await tx.roundTechnician.createMany({
          data: round.roundTechnicians.map((rt) => ({ roundId: target!.id, technicianId: rt.technicianId })),
        });
      }
    }

    const future = {
      propertyId: plan.propertyId,
      roundId: round.id,
      status: VisitStatus.SCHEDULED,
      date: { gte: today },
    };
    cancelled = await tx.visit.findMany({
      where: future,
      select: { id: true, technicianId: true, date: true, roundId: true, propertyId: true },
    });
    await tx.visit.updateMany({
      where: future,
      data: { status: VisitStatus.CANCELLED, cancelReason: CANCEL_REASON_FREQUENCY_CHANGED },
    });
    await tx.property.update({
      where: { id: plan.propertyId },
      data: { roundId: target.id, assignedTechnicianId: null },
    });
    const servicePlan = await tx.servicePlan.update({
      where: { id: servicePlanId },
      data: {
        ...data,
        nextDueDate: initialNextDueDate({
          lastCleanedDate: plan.lastCompleted,
          frequency,
          roundDefaultDay: target.defaultDay,
          today,
        }),
      },
    });
    return { servicePlan, movedToRound: { id: target.id, name: target.name, created } };
  });
  await notifyVisitsCancelled(tp, cancelled, "The cleaning frequency changed.");
  return outcome;
}
