import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { CleaningFrequency, LifecycleStatus, Prisma, VisitStatus } from "../generated/tenant-client";
import type { DayOfWeek } from "../generated/tenant-client";
import { addWeeks, frequencyWeeks, startOfUtcDay } from "../lib/schedule";
import { activeClosures, advanceDueDate, closuresCovering, type ClosureWindow } from "../lib/closures";
import { createCycleVisit } from "../jobs/visitGeneration";
import { queueGhlEvent } from "../integrations/ghl/sync";
import { planFirstCycle, projectOccurrences } from "./round-projection";
import { tenantToday } from "./business-time";
import { getCachedBusinessSettings } from "./settings.service";
import { REMINDER_MARKERS_RESET, cancelPendingVisitMessages } from "./visit-reschedule";
import { technicianIdsUnavailableOn } from "./visit-assignment";
import { notifyVisitTechnicians } from "./notify";
import { createMessageService } from "./message.service";
import { formatTemplateDate } from "./message-templates";
import { isWorkingDay } from "../lib/working-days";

// Move a round date (Round Planner, plan 2026-11-25 branch 4). Every property on the date moves; no partial moves.
// - A REAL date (the round has SCHEDULED/SKIPPED visits on it, today or later): those visits are rebooked onto the new
//   date exactly as the per-visit reschedule does (SCHEDULED, skip reason cleared, reminder markers reset, pending
//   messages cancelled). Plans keep their cycle.
// - The round's NEXT FORECAST date (planner projection): each ACTIVE plan whose next cycle is that date gets its visit
//   created on the new date now, and its nextDueDate advances one cycle from the ORIGINAL date (the generator's own
//   helper), so the nightly job never creates that cycle again and later dates stay on the customer's normal cycle.
// The target must be today or later, not a closed operational day, not inside a closure for the round, inside the
// neighbour window (after the previous round date and today, before the next round date), and must not put any moved
// property's clean on or before its previous unfinished visit, or on or after its next visit / next due cycle.

export const ACTIVITY_VISITS_MOVED = "VISITS_MOVED";

export type MoveKind = "REAL" | "FORECAST";

export type MoveErrorCode =
  | "SAME_DATE"
  | "DATE_IN_PAST"
  | "DAY_CLOSED"
  | "DATE_IN_CLOSURE"
  | "OUTSIDE_MOVE_WINDOW"
  | "PROPERTY_CLEAN_CLASH";

export interface MoveCheck {
  toDate: string;
  ok: boolean;
  code: MoveErrorCode | null;
  message: string | null;
  clashCount: number;
  /** Non-blocking: set when toDate is not one of the tenant's working days (ok is unaffected). */
  warning: string | null;
}

export interface BlockedDate {
  date: string;
  reason: "CLOSURE" | "CLOSED_DAY";
  label: string;
}

export interface MovePreview {
  fromDate: string;
  kind: MoveKind;
  propertyCount: number;
  earliestDate: string;
  latestDate: string;
  blockedDates: BlockedDate[];
  /** Days inside [earliestDate, latestDate] that are not working days: allowed, with a warning. */
  nonWorkingDates: string[];
  check: MoveCheck | null;
}

export interface MoveInput {
  fromDate: Date;
  toDate: Date;
  notifyCustomers: boolean;
  message?: string | null;
  actor?: { id?: string; role?: string };
}

export interface MoveResult {
  fromDate: string;
  toDate: string;
  kind: MoveKind;
  movedVisits: number;
  createdVisits: number;
  notifiedCustomers: number;
  customerNotificationError: string | null;
  warning: string | null;
}

const DAY_MS = 86_400_000;
const UNFINISHED: VisitStatus[] = [VisitStatus.SCHEDULED, VisitStatus.SKIPPED];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
const minDate = (dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((m, d) => (d && (!m || d < m) ? d : m), null);
const maxDate = (dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null);

interface Failure {
  status: number;
  code: MoveErrorCode;
  message: string;
  clashCount: number;
}

/** A due plan on the next forecast date: the cycle to create and the plan's next due date afterwards. */
interface ForecastPlan {
  id: string;
  price: Prisma.Decimal;
  serviceId: string | null;
  nextDueDate: Date;
  propertyId: string;
  property: { id: string; customerId: string; assignedTechnicianId: string | null };
  raw: Date;
  weeks: number;
  nextDueAfter: Date;
}

interface MovedVisit {
  id: string;
  propertyId: string;
  servicePlanId: string | null;
  technicianId: string | null;
  roundId: string | null;
  property: { customerId: string };
}

export function createRoundMoveService(prisma: TenantPrismaClient) {
  /** Everything the checks need about one round date. Throws 404 / OCCURRENCE_NOT_MOVABLE. */
  async function loadOccurrence(roundId: string, fromInput: Date) {
    const fromDate = startOfUtcDay(fromInput);
    const round = await prisma.round.findUnique({
      where: { id: roundId },
      select: { id: true, name: true, frequency: true, defaultDay: true, status: true },
    });
    if (!round) throw new AppError(404, "Round not found");

    const today = await tenantToday(prisma);
    const notMovable = (why: string) => new AppError(409, why, "OCCURRENCE_NOT_MOVABLE");
    if (fromDate < today) throw notMovable("Only today's and future round dates can be moved");

    const settings = await getCachedBusinessSettings(prisma);
    const workingDays = settings?.defaultWorkingDays ?? [];
    // Same closure set as generation and the planner (a catch-up cycle can sit in a closure that has since ended).
    const closuresSince = addDays(today, -366);
    const closureRows = await prisma.businessClosure.findMany({ where: { endDate: { gte: closuresSince } } });
    const closures: ClosureWindow[] = activeClosures(
      closureRows.map((c) => ({
        id: c.id, label: c.label, startDate: startOfUtcDay(c.startDate), endDate: startOfUtcDay(c.endDate), mode: c.mode, roundIds: c.roundIds,
      })),
      closuresSince
    );

    const visits: MovedVisit[] = await prisma.visit.findMany({
      where: { roundId, date: { gte: fromDate, lt: addDays(fromDate, 1) }, status: { in: UNFINISHED } },
      select: { id: true, propertyId: true, servicePlanId: true, technicianId: true, roundId: true, property: { select: { customerId: true } } },
    });

    // The planner's series for this round (real dates win; projected entries are the forecast).
    const forecast = (await projectOccurrences(prisma, [roundId], today)).get(roundId) ?? [];
    const kind: MoveKind = visits.length > 0 ? "REAL" : "FORECAST";
    let plans: ForecastPlan[] = [];

    if (kind === "FORECAST") {
      if (forecast[0]?.date !== iso(fromDate)) {
        throw notMovable("Only a date with visits or the round's next forecast date can be moved");
      }
      plans = await duePlansOn(round, fromDate, today, workingDays, closures);
      if (plans.length === 0) throw notMovable("No plan of the round is due on this date");
    }

    // Plans behind the visits / due on the date: the properties and their cycles.
    const propertyIds = [...new Set(kind === "REAL" ? visits.map((v) => v.propertyId) : plans.map((p) => p.propertyId))];
    const customerIds = [...new Set(kind === "REAL" ? visits.map((v) => v.property.customerId) : plans.map((p) => p.property.customerId))];

    // Neighbour window.
    const [previous, nextReal] = await Promise.all([
      prisma.visit.findFirst({
        where: { roundId, date: { lt: fromDate }, status: { not: VisitStatus.CANCELLED } },
        orderBy: { date: "desc" },
        select: { date: true },
      }),
      prisma.visit.findFirst({
        where: { roundId, date: { gte: addDays(fromDate, 1) }, status: { not: VisitStatus.CANCELLED } },
        orderBy: { date: "asc" },
        select: { date: true },
      }),
    ]);
    const nextForecast = forecast.find((e) => e.date > iso(fromDate));
    const nextDate = minDate([nextReal?.date ?? null, nextForecast ? new Date(`${nextForecast.date}T00:00:00.000Z`) : null]);
    const earliest = maxDate([today, previous ? addDays(startOfUtcDay(previous.date), 1) : null])!;
    let latest: Date;
    if (nextDate) {
      latest = addDays(startOfUtcDay(nextDate), -1);
    } else {
      // No next date within the projection: one round cycle (round frequency, else the shortest of the moved plans', else 4 weeks).
      latest = addDays(addWeeks(fromDate, await cycleWeeks(round.frequency, visits)), -1);
    }

    // Per property: the previous unfinished visit and the next visit / next due cycle.
    const bounds = await propertyBounds(round, fromDate, propertyIds, visits, plans, workingDays, closures);

    return {
      round, fromDate, today, kind, visits, plans, propertyIds, customerIds, closures, workingDays,
      lastClosedDate: settings?.lastClosedDate ?? null, earliest, latest, bounds,
    };
  }

  /** ACTIVE plans of the round whose next cycle (as the planner shows it) is `fromDate`. */
  async function duePlansOn(
    round: { id: string; frequency: CleaningFrequency | null; defaultDay: DayOfWeek | null },
    fromDate: Date,
    today: Date,
    workingDays: readonly string[],
    closures: readonly ClosureWindow[]
  ): Promise<ForecastPlan[]> {
    const rows = await prisma.servicePlan.findMany({
      where: { status: LifecycleStatus.ACTIVE, nextDueDate: { not: null }, property: { roundId: round.id, status: LifecycleStatus.ACTIVE } },
      select: {
        id: true, price: true, serviceId: true, nextDueDate: true, cleaningFrequency: true, pauseStartDate: true, pauseEndDate: true, propertyId: true,
        property: { select: { id: true, customerId: true, assignedTechnicianId: true } },
      },
    });
    const latest = await latestVisitByPlan(rows.map((r) => r.id));
    const out: ForecastPlan[] = [];
    for (const p of rows) {
      const frequency = p.cleaningFrequency ?? round.frequency;
      if (!frequency) continue;
      const cycle = planFirstCycle(p.nextDueDate!, latest.get(p.id) ?? null, round, frequency, workingDays, closures);
      if (!cycle) continue;
      // The planner shows an overdue cycle today.
      const shown = cycle.date < today ? today : cycle.date;
      if (shown.getTime() !== fromDate.getTime()) continue;
      // Generation would not create a cycle inside a future pause window, so it is not moved either.
      if (p.pauseStartDate && cycle.date >= p.pauseStartDate && (!p.pauseEndDate || cycle.date <= p.pauseEndDate)) continue;
      const weeks = frequencyWeeks(frequency);
      out.push({
        id: p.id, price: p.price, serviceId: p.serviceId, nextDueDate: p.nextDueDate!, propertyId: p.propertyId, property: p.property,
        raw: cycle.raw, weeks,
        nextDueAfter: advanceDueDate(p.nextDueDate!, cycle.raw, { weeks, defaultDay: round.defaultDay, workingDays }),
      });
    }
    return out;
  }

  /** Each plan's latest non-cancelled, non-one-off visit date (the served-cycle guard's input, as in generation). */
  async function latestVisitByPlan(planIds: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (planIds.length === 0) return out;
    const rows = await prisma.visit.groupBy({
      by: ["servicePlanId"],
      where: { servicePlanId: { in: planIds }, status: { not: VisitStatus.CANCELLED }, isOneOff: false },
      _max: { date: true },
    });
    // Grouped over the given plan ids (servicePlanId never null); every group has a date.
    for (const r of rows) out.set(r.servicePlanId!, r._max.date!);
    return out;
  }

  /** One round cycle in weeks: the round's frequency, else the shortest of the moved visits' plans, else 4. */
  async function cycleWeeks(roundFrequency: CleaningFrequency | null, visits: MovedVisit[]): Promise<number> {
    if (roundFrequency) return frequencyWeeks(roundFrequency);
    const planIds = [...new Set(visits.flatMap((v) => (v.servicePlanId ? [v.servicePlanId] : [])))];
    const rows = await prisma.servicePlan.findMany({ where: { id: { in: planIds } }, select: { cleaningFrequency: true } });
    const weeks = rows.flatMap((r) => (r.cleaningFrequency ? [frequencyWeeks(r.cleaningFrequency)] : []));
    return weeks.length > 0 ? Math.min(...weeks) : 4;
  }

  /**
   * Per property: `previous` = its latest unfinished (SCHEDULED/SKIPPED) visit before the date; `next` = the earlier of its
   * next non-cancelled, non-one-off visit after the date and its plans' next due cycle after the date (plans can have their
   * own frequency). A moved forecast plan counts with its cycle after the move.
   */
  async function propertyBounds(
    round: { id: string; frequency: CleaningFrequency | null; defaultDay: DayOfWeek | null },
    fromDate: Date,
    propertyIds: string[],
    visits: MovedVisit[],
    moved: ForecastPlan[],
    workingDays: readonly string[],
    closures: readonly ClosureWindow[]
  ): Promise<Map<string, { previous: Date | null; next: Date | null }>> {
    const movedVisitIds = visits.map((v) => v.id);
    const [earlier, later, plans] = await Promise.all([
      prisma.visit.findMany({
        where: { propertyId: { in: propertyIds }, status: { in: UNFINISHED }, date: { lt: fromDate } },
        select: { propertyId: true, date: true },
      }),
      prisma.visit.findMany({
        where: {
          propertyId: { in: propertyIds }, status: { not: VisitStatus.CANCELLED }, isOneOff: false,
          date: { gte: addDays(fromDate, 1) }, id: { notIn: movedVisitIds },
        },
        select: { propertyId: true, date: true },
      }),
      prisma.servicePlan.findMany({
        where: { propertyId: { in: propertyIds }, status: LifecycleStatus.ACTIVE, nextDueDate: { not: null } },
        select: { id: true, propertyId: true, nextDueDate: true, cleaningFrequency: true },
      }),
    ]);
    const latest = await latestVisitByPlan(plans.map((p) => p.id));
    const movedById = new Map(moved.map((p) => [p.id, p]));

    const out = new Map<string, { previous: Date | null; next: Date | null }>();
    for (const id of propertyIds) out.set(id, { previous: null, next: null });
    for (const v of earlier) {
      const b = out.get(v.propertyId)!;
      b.previous = maxDate([b.previous, v.date]);
    }
    for (const v of later) {
      const b = out.get(v.propertyId)!;
      b.next = minDate([b.next, v.date]);
    }
    for (const p of plans) {
      const frequency = p.cleaningFrequency ?? round.frequency;
      if (!frequency) continue;
      const m = movedById.get(p.id);
      // A moved forecast plan: its cycle after this one (no served guard: that cycle must stay clear of the new date).
      // Any other plan: the cycle generation would create next, counting the date's own visit as served.
      const cycle = m
        ? planFirstCycle(m.nextDueAfter, null, round, frequency, workingDays, closures)
        : planFirstCycle(p.nextDueDate!, maxDate([latest.get(p.id) ?? null, fromDate]), round, frequency, workingDays, closures);
      if (cycle && cycle.date > fromDate) {
        const b = out.get(p.propertyId)!;
        b.next = minDate([b.next, cycle.date]);
      }
    }
    return out;
  }

  type Occurrence = Awaited<ReturnType<typeof loadOccurrence>>;

  const closedToday = (o: Occurrence, day: Date) => day.getTime() === o.today.getTime() && o.lastClosedDate === iso(o.today);
  const closuresOn = (o: Occurrence, day: Date) => closuresCovering(day, o.round.id, o.closures);

  /** The POST's validation of `toDate`, in order. null = the move can go ahead. */
  function validate(o: Occurrence, toInput: Date): Failure | null {
    const toDate = startOfUtcDay(toInput);
    const fail = (status: number, code: MoveErrorCode, message: string, clashCount = 0): Failure => ({ status, code, message, clashCount });
    if (toDate.getTime() === o.fromDate.getTime()) return fail(400, "SAME_DATE", '"toDate" must differ from "fromDate"');
    if (toDate < o.today) return fail(400, "DATE_IN_PAST", '"toDate" must be today or later');
    if (closedToday(o, toDate)) return fail(409, "DAY_CLOSED", "Operational day has already been closed");
    const [closure] = closuresOn(o, toDate);
    if (closure) return fail(409, "DATE_IN_CLOSURE", `${iso(toDate)} is inside the closure "${closure.label}"`);
    if (toDate < o.earliest || toDate > o.latest) {
      return fail(409, "OUTSIDE_MOVE_WINDOW", `Pick a date between ${iso(o.earliest)} and ${iso(o.latest)}`);
    }
    let clashes = 0;
    for (const b of o.bounds.values()) {
      if ((b.previous && toDate <= b.previous) || (b.next && toDate >= b.next)) clashes++;
    }
    if (clashes > 0) {
      const who = clashes === 1 ? "1 property" : `${clashes} properties`;
      return fail(409, "PROPERTY_CLEAN_CLASH", `${who} would get two cleans too close together`, clashes);
    }
    return null;
  }

  // The working days generation uses (BusinessSettings.defaultWorkingDays; none configured = Mon-Fri).
  const nonWorking = (o: Occurrence, day: Date) => !isWorkingDay(day, { workingDays: o.workingDays, tz: "UTC" });

  /** The non-blocking warning for `toDate` (moving onto a non-working day is allowed). */
  function warningFor(o: Occurrence, toInput: Date): string | null {
    const day = startOfUtcDay(toInput);
    if (!nonWorking(o, day)) return null;
    const label = day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
    return `${label} is not a working day.`;
  }

  function nonWorkingDates(o: Occurrence): string[] {
    const out: string[] = [];
    for (let day = o.earliest; day <= o.latest; day = addDays(day, 1)) if (nonWorking(o, day)) out.push(iso(day));
    return out;
  }

  function blockedDates(o: Occurrence): BlockedDate[] {
    const out: BlockedDate[] = [];
    for (let day = o.earliest; day <= o.latest; day = addDays(day, 1)) {
      if (closedToday(o, day)) {
        out.push({ date: iso(day), reason: "CLOSED_DAY", label: "Day already closed" });
        continue;
      }
      const [closure] = closuresOn(o, day);
      if (closure) out.push({ date: iso(day), reason: "CLOSURE", label: closure.label });
    }
    return out;
  }

  /** Push-missed's customer path: one SMS per customer, best effort (the move is already done). */
  async function notifyCustomers(o: Occurrence, toDate: Date, message: string | null | undefined) {
    const body =
      message?.trim() ||
      `Your window clean has been moved from ${formatTemplateDate(o.fromDate)} to ${formatTemplateDate(toDate)}.`;
    const messages = createMessageService(prisma);
    let notified = 0;
    const errors: string[] = [];
    for (const customerId of o.customerIds) {
      try {
        await messages.send({ customerId, channel: "sms", body });
        notified++;
      } catch (err) {
        console.error(`[rounds] move-occurrence notify failed for customer ${customerId}:`, err);
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    const error = errors.length > 0
      ? `${errors.length === 1 ? "1 customer" : `${errors.length} customers`} could not be notified: ${errors[0]}`
      : null;
    return { notified, error };
  }

  return {
    preview: async (roundId: string, fromDate: Date, toDate?: Date): Promise<MovePreview> => {
      const o = await loadOccurrence(roundId, fromDate);
      let check: MoveCheck | null = null;
      if (toDate) {
        const f = validate(o, toDate);
        check = {
          toDate: iso(startOfUtcDay(toDate)), ok: !f, code: f?.code ?? null, message: f?.message ?? null, clashCount: f?.clashCount ?? 0,
          warning: warningFor(o, toDate),
        };
      }
      return {
        fromDate: iso(o.fromDate),
        kind: o.kind,
        propertyCount: o.propertyIds.length,
        earliestDate: iso(o.earliest),
        latestDate: iso(o.latest),
        blockedDates: blockedDates(o),
        nonWorkingDates: nonWorkingDates(o),
        check,
      };
    },

    move: async (roundId: string, input: MoveInput): Promise<MoveResult> => {
      const o = await loadOccurrence(roundId, input.fromDate);
      const failure = validate(o, input.toDate);
      if (failure) throw new AppError(failure.status, failure.message, failure.code);

      const toDate = startOfUtcDay(input.toDate);
      const from = iso(o.fromDate);
      const to = iso(toDate);
      const visitIds = o.visits.map((v) => v.id);
      const [roundTechs, unavailable] = o.kind === "FORECAST"
        ? await Promise.all([
            prisma.roundTechnician.findMany({ where: { roundId, technician: { active: true } }, select: { technicianId: true } }),
            technicianIdsUnavailableOn(prisma, toDate),
          ])
        : [[], new Set<string>()];

      let createdVisits = 0;
      await prisma.$transaction(async (tx) => {
        if (o.kind === "REAL") {
          // Re-checked inside the transaction: a visit finished or moved meanwhile aborts the whole move.
          const res = await tx.visit.updateMany({
            where: { id: { in: visitIds }, status: { in: UNFINISHED }, date: o.fromDate },
            data: { date: toDate, status: VisitStatus.SCHEDULED, skipReason: null, ...REMINDER_MARKERS_RESET },
          });
          if (res.count !== visitIds.length) {
            throw new AppError(409, "The round date changed while it was being moved; try again", "OCCURRENCE_CHANGED");
          }
          await cancelPendingVisitMessages(tx, visitIds, "Round date moved");
        } else {
          for (const p of o.plans) {
            await createCycleVisit(tx, {
              round: o.round, property: p.property, plan: p, due: p.nextDueDate, rawDate: p.raw, visitDate: toDate,
              weeks: p.weeks, workingDays: o.workingDays,
              roundTechnicianIds: roundTechs.map((r) => r.technicianId),
              unavailableTechnicianIds: [...unavailable],
            });
            await tx.servicePlan.update({ where: { id: p.id }, data: { nextDueDate: p.nextDueAfter } });
            createdVisits++;
          }
        }
        const count = o.propertyIds.length;
        await tx.activityLog.create({
          data: {
            type: ACTIVITY_VISITS_MOVED,
            message: `Round ${o.round.name}: ${from} moved to ${to} (${count} ${count === 1 ? "property" : "properties"})`,
            actorId: input.actor?.id ?? null,
            actorRole: input.actor?.role ?? null,
            entityId: roundId,
            details: { roundId, fromDate: from, toDate: to, kind: o.kind, propertyCount: count, visitIds, notifyCustomers: input.notifyCustomers },
          },
        });
      });

      // After commit, best effort: GHL learns the new date (drives the pre-clean reminder workflow) ...
      for (const customerId of o.customerIds) {
        try {
          await queueGhlEvent(prisma, "visit.scheduled", customerId, { nextCleanDate: to });
        } catch (err) {
          console.error(`[rounds] move-occurrence GHL event failed for customer ${customerId}:`, err);
        }
      }
      // ... the technicians of moved visits hear about it (as on a per-visit reschedule) ...
      if (o.kind === "REAL") {
        await notifyVisitTechnicians(
          prisma,
          o.visits.map((v) => ({ id: v.id, technicianId: v.technicianId, roundId: v.roundId, propertyId: v.propertyId, date: toDate })),
          () => ({ type: "SCHEDULE", title: "A round date was moved", body: `Moved from ${from} to ${to}.` })
        );
      }
      // ... and the customers, unless switched off.
      const sent = input.notifyCustomers ? await notifyCustomers(o, toDate, input.message) : { notified: 0, error: null };

      return {
        fromDate: from,
        toDate: to,
        kind: o.kind,
        movedVisits: o.kind === "REAL" ? visitIds.length : 0,
        createdVisits,
        notifiedCustomers: sent.notified,
        customerNotificationError: sent.error,
        warning: warningFor(o, toDate),
      };
    },
  };
}
