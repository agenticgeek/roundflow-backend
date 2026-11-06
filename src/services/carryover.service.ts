import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { Prisma, VisitStatus } from "../generated/tenant-client";
import { carryoverOptions, resolveCarryoverTarget, toCalendarDay, type CarryoverOption } from "../lib/working-days";
import { startOfUtcDay } from "../lib/schedule";
import { tenantToday } from "./business-time";
import { getCachedBusinessSettings } from "./settings.service";
import { technicianIdsUnavailableOn, type TenantDb } from "./visit-assignment";
import { REMINDER_MARKERS_RESET, cancelPendingVisitMessages } from "./visit-reschedule";
import { notifyVisitTechnicians, visitCount } from "./notify";
import { createMessageService, type BroadcastTarget } from "./message.service";
import { formatTemplateDate } from "./message-templates";

// ACT-02..04: carry unfinished visits of a day to a later working day. Shared by
// POST /visits/carryover and POST /today/close (push_to_tomorrow).

export const ACTIVITY_VISITS_CARRIED_OVER = "VISITS_CARRIED_OVER";

export const CARRYOVER_CUSTOMER_BODY =
  "Hi {{firstName}}, we've had to move your window clean at {{address}} to {{newDate}}. Sorry for any inconvenience, {{businessName}}.";

const DAY_MS = 86_400_000;
const UNFINISHED: VisitStatus[] = [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS];
const customerSelect = { id: true, name: true, phone: true, email: true, ghlContactId: true, messagesOptOut: true } as const;

export type CarryoverConflictReason = "TECHNICIAN_UNAVAILABLE" | "TECHNICIAN_INACTIVE";
export type CarryoverSkipReason = "NOT_FOUND" | "NOT_ON_DATE" | "NOT_UNFINISHED";

export interface CarryoverConflict {
  visitId: string;
  technicianId: string;
  reason: CarryoverConflictReason;
}

export interface CarryoverOptionsResult {
  date: string;
  options: CarryoverOption[];
}

export interface CarryoverResult {
  moved: number;
  targetDate: string;
  conflicts: CarryoverConflict[];
  notifiedTechnicians: number;
  notifiedCustomers: number;
  skipped: { visitId: string; reason: CarryoverSkipReason }[];
  dryRun: boolean;
  /** Set when notifyCustomers was requested but the customer message step failed (the carryover itself is done). */
  customerNotificationError?: string;
}

export interface MovedVisit {
  id: string;
  technicianId: string | null;
  roundId: string | null;
  propertyId: string;
  customer: BroadcastTarget["customer"];
  addressLine: string;
}

export interface CoreResult {
  moved: MovedVisit[];
  conflicts: CarryoverConflict[];
  skipped: CarryoverResult["skipped"];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The write path, usable inside a caller's transaction. Moves the unfinished
 * visits of `fromDate` (or the given `visitIds`) to `targetDate`: back to
 * SCHEDULED, start/arrival cleared, reminder markers reset, queued pre-clean
 * messages for the old date cancelled, carryover recorded, activity logged.
 * Technician conflicts on the target date are reported, not blocking.
 */
export async function carryOverVisits(
  db: TenantDb,
  input: {
    fromDate: Date;
    targetDate: Date;
    visitIds?: string[];
    dryRun?: boolean;
    actor?: { id?: string | null; role?: string | null };
    via: "carryover" | "close-day";
  }
): Promise<CoreResult> {
  const { fromDate, targetDate } = input;
  const rows = await db.visit.findMany({
    where: input.visitIds
      ? { id: { in: input.visitIds } }
      : { date: { gte: fromDate, lt: new Date(fromDate.getTime() + DAY_MS) }, status: { in: UNFINISHED } },
    select: {
      id: true,
      date: true,
      status: true,
      technicianId: true,
      roundId: true,
      propertyId: true,
      technician: { select: { active: true } },
      property: { select: { addressLine: true, customer: { select: customerSelect } } },
    },
    orderBy: { id: "asc" },
  });

  const skipped: CoreResult["skipped"] = [];
  const eligible = rows.filter((r) => {
    if (r.date.getTime() !== fromDate.getTime()) skipped.push({ visitId: r.id, reason: "NOT_ON_DATE" });
    else if (!UNFINISHED.includes(r.status)) skipped.push({ visitId: r.id, reason: "NOT_UNFINISHED" });
    else return true;
    return false;
  });
  const found = new Set(rows.map((r) => r.id));
  for (const id of input.visitIds ?? []) if (!found.has(id)) skipped.push({ visitId: id, reason: "NOT_FOUND" });

  const unavailable = eligible.length > 0 ? await technicianIdsUnavailableOn(db, targetDate) : new Set<string>();
  const conflicts: CarryoverConflict[] = [];
  for (const r of eligible) {
    if (!r.technicianId) continue;
    if (r.technician && !r.technician.active) conflicts.push({ visitId: r.id, technicianId: r.technicianId, reason: "TECHNICIAN_INACTIVE" });
    else if (unavailable.has(r.technicianId)) conflicts.push({ visitId: r.id, technicianId: r.technicianId, reason: "TECHNICIAN_UNAVAILABLE" });
  }

  const moved: MovedVisit[] = eligible.map((r) => ({
    id: r.id,
    technicianId: r.technicianId,
    roundId: r.roundId,
    propertyId: r.propertyId,
    customer: r.property.customer,
    addressLine: r.property.addressLine,
  }));
  if (input.dryRun || moved.length === 0) return { moved, conflicts, skipped };

  const ids = moved.map((m) => m.id);
  await db.visit.updateMany({
    where: { id: { in: ids } },
    data: {
      date: targetDate,
      status: VisitStatus.SCHEDULED,
      startedAt: null,
      arrivedAt: null,
      ...REMINDER_MARKERS_RESET,
      carriedOverFromDate: fromDate,
      carryoverCount: { increment: 1 },
    },
  });
  const cancelledReminders = await cancelPendingVisitMessages(db, ids, "Carried over");
  await db.activityLog.create({
    data: {
      type: ACTIVITY_VISITS_CARRIED_OVER,
      message: `${visitCount(ids.length)} carried over from ${iso(fromDate)} to ${iso(targetDate)}`,
      actorId: input.actor?.id ?? null,
      actorRole: input.actor?.role ?? null,
      details: {
        from: iso(fromDate),
        to: iso(targetDate),
        via: input.via,
        visitIds: ids,
        conflicts,
        cancelledReminders,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  return { moved, conflicts, skipped };
}

/** Tells the technicians of the moved visits (best effort, never throws). Returns how many distinct technicians. */
export async function notifyCarryoverTechnicians(
  prisma: TenantPrismaClient,
  moved: MovedVisit[],
  fromDate: Date,
  targetDate: Date
): Promise<number> {
  const technicians = new Set(moved.flatMap((m) => (m.technicianId ? [m.technicianId] : [])));
  await notifyVisitTechnicians(
    prisma,
    moved.map((m) => ({ id: m.id, technicianId: m.technicianId, roundId: m.roundId, propertyId: m.propertyId, date: targetDate })),
    ({ count }) => ({
      type: "SCHEDULE",
      title: `${visitCount(count)} carried over`,
      body: `Unfinished work from ${iso(fromDate)} moved to ${iso(targetDate)}.`,
    })
  );
  return technicians.size;
}

/** Messages each customer of the moved visits once (best effort, never throws; the carryover is already done). */
export async function notifyCarryoverCustomers(
  prisma: TenantPrismaClient,
  moved: MovedVisit[],
  fromDate: Date,
  targetDate: Date
): Promise<{ notified: number; error?: string }> {
  try {
    const businessName = (await workingConfig(prisma)).businessName;
    const byCustomer = new Map<string, BroadcastTarget>();
    for (const m of moved) {
      if (byCustomer.has(m.customer.id)) continue;
      byCustomer.set(m.customer.id, {
        customer: m.customer,
        vars: {
          customerName: m.customer.name,
          firstName: m.customer.name.split(" ")[0],
          address: m.addressLine,
          date: formatTemplateDate(fromDate),
          newDate: formatTemplateDate(targetDate),
          businessName,
        },
      });
    }
    const sent = await createMessageService(prisma).broadcast([...byCustomer.values()], {
      body: CARRYOVER_CUSTOMER_BODY,
      reason: ACTIVITY_VISITS_CARRIED_OVER,
      extraPayload: { carryover: true },
    });
    return { notified: sent.sent + sent.scheduled };
  } catch (err) {
    console.error("[carryover] notifying customers failed:", err);
    return { notified: 0, error: (err as Error).message };
  }
}

async function workingConfig(prisma: TenantPrismaClient) {
  const settings = await getCachedBusinessSettings(prisma);
  return {
    workingDays: settings?.defaultWorkingDays ?? [],
    tz: settings?.timezone ?? undefined,
    lastClosedDate: settings?.lastClosedDate ?? null,
    businessName: settings?.businessName ?? "",
  };
}

/** Target date for a carryover from `date`: the option with `key`, or the default option when no key is given. */
export function pickTarget(
  date: Date,
  key: string | undefined,
  cfg: { workingDays: string[]; tz?: string }
): Date {
  const opts = { workingDays: cfg.workingDays, tz: cfg.tz };
  if (key === undefined) {
    const def = carryoverOptions(date, opts).find((o) => o.default)!;
    return toCalendarDay(def.date);
  }
  const target = resolveCarryoverTarget(date, key, opts);
  if (!target) {
    throw new AppError(400, `"target" ${key} is not available for ${iso(date)}`, "INVALID_CARRYOVER_TARGET");
  }
  return target;
}

export function createCarryoverService(prisma: TenantPrismaClient) {
  return {
    options: async (date: Date): Promise<CarryoverOptionsResult> => {
      const cfg = await workingConfig(prisma);
      const day = startOfUtcDay(date);
      return { date: iso(day), options: carryoverOptions(day, { workingDays: cfg.workingDays, tz: cfg.tz }) };
    },

    carryover: async (input: {
      date: Date;
      target: string;
      visitIds?: string[];
      notifyCustomers?: boolean;
      dryRun?: boolean;
      actor?: { id?: string | null; role?: string | null };
    }): Promise<CarryoverResult> => {
      const cfg = await workingConfig(prisma);
      const fromDate = startOfUtcDay(input.date);
      const targetDate = pickTarget(fromDate, input.target, cfg);

      if (targetDate < (await tenantToday(prisma))) {
        throw new AppError(400, "The target day is in the past", "CARRYOVER_TARGET_IN_PAST");
      }
      if (cfg.lastClosedDate === iso(targetDate)) {
        throw new AppError(409, "The target day has already been closed", "CARRYOVER_TARGET_CLOSED");
      }

      const dryRun = input.dryRun === true;
      const core = await prisma.$transaction((tx) =>
        carryOverVisits(tx, { fromDate, targetDate, visitIds: input.visitIds, dryRun, actor: input.actor, via: "carryover" })
      );
      const result: CarryoverResult = {
        moved: core.moved.length,
        targetDate: iso(targetDate),
        conflicts: core.conflicts,
        notifiedTechnicians: 0,
        notifiedCustomers: 0,
        skipped: core.skipped,
        dryRun,
      };
      if (dryRun || core.moved.length === 0) return result;

      result.notifiedTechnicians = await notifyCarryoverTechnicians(prisma, core.moved, fromDate, targetDate);

      if (input.notifyCustomers) {
        const sent = await notifyCarryoverCustomers(prisma, core.moved, fromDate, targetDate);
        result.notifiedCustomers = sent.notified;
        if (sent.error) result.customerNotificationError = sent.error;
      }
      return result;
    },
  };
}
