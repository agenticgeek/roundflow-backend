import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { VisitStatus } from "../generated/tenant-client";
import { startOfUtcDay } from "../lib/schedule";
import { tenantToday, tenantTodayRange } from "./business-time";
import { getCachedBusinessSettings } from "./settings.service";
import { notifyVisitTechnicians } from "./notify";

export const ACTIVITY_VISIT_RESCHEDULED = "VISIT_RESCHEDULED";

// A visit with a new date is a new appointment: its pre-clean reminders must fire again
// for that date.
export const REMINDER_MARKERS_RESET = { reminderSentAt: null, reminderSentTypes: [] as string[] };

/**
 * Cancels customer messages still waiting on the outbox for these visits (pre-clean reminders
 * carry the old date in their text). Cancelled rows are kept for audit. Returns how many.
 */
export async function cancelPendingVisitMessages(
  tx: Pick<TenantPrismaClient, "integrationOutbox">,
  visitIds: string[],
  reason: string
): Promise<number> {
  if (visitIds.length === 0) return 0;
  const res = await tx.integrationOutbox.updateMany({
    where: {
      status: "pending",
      eventType: "message.send",
      OR: visitIds.map((id) => ({ payload: { path: ["visitId"], equals: id } })),
    },
    data: { status: "cancelled", lastError: reason, processedAt: new Date() },
  });
  return res.count;
}

/** 409 when `day` is today and Close Day has already run (same rule as Reassign / Push Missed). */
export async function assertDayNotClosed(prisma: TenantPrismaClient, day: Date): Promise<void> {
  if (day.getTime() !== (await tenantToday(prisma)).getTime()) return;
  const settings = await getCachedBusinessSettings(prisma);
  if (settings?.lastClosedDate === (await tenantTodayRange(prisma)).start.toISOString().slice(0, 10)) {
    throw new AppError(409, "Operational day has already been closed");
  }
}

export function createVisitRescheduleService(prisma: TenantPrismaClient) {
  return {
    // Book a SCHEDULED or SKIPPED visit onto a new date (a skipped one becomes SCHEDULED again).
    reschedule: async (
      visitId: string,
      input: { date: Date; actor?: { id?: string; role?: string } }
    ): Promise<{ id: string; status: VisitStatus; date: string }> => {
      const visit = await prisma.visit.findUnique({
        where: { id: visitId },
        select: { id: true, status: true, date: true, technicianId: true, roundId: true, propertyId: true },
      });
      if (!visit) throw new AppError(404, "Visit not found");
      if (visit.status !== VisitStatus.SCHEDULED && visit.status !== VisitStatus.SKIPPED) {
        throw new AppError(409, "Only scheduled or skipped visits can be rescheduled", "VISIT_NOT_RESCHEDULABLE");
      }
      const day = startOfUtcDay(input.date);
      if (day < (await tenantToday(prisma))) throw new AppError(400, '"date" must be today or later');
      await assertDayNotClosed(prisma, day);

      const from = visit.date.toISOString().slice(0, 10);
      const to = day.toISOString().slice(0, 10);
      await prisma.$transaction(async (tx) => {
        await tx.visit.update({
          where: { id: visitId },
          data: { date: day, status: VisitStatus.SCHEDULED, skipReason: null, ...REMINDER_MARKERS_RESET },
        });
        await cancelPendingVisitMessages(tx, [visitId], "Visit rescheduled");
        await tx.activityLog.create({
          data: {
            type: ACTIVITY_VISIT_RESCHEDULED,
            message: `Visit ${visitId} rescheduled from ${from} to ${to}`,
            actorId: input.actor?.id ?? null,
            actorRole: input.actor?.role ?? null,
            entityId: visitId,
            details: { from, to, previousStatus: visit.status },
          },
        });
      });
      // FLOW-03: the assigned technician hears about the new date. Best effort.
      await notifyVisitTechnicians(
        prisma,
        [{ ...visit, date: day }],
        () => ({ type: "SCHEDULE", title: "A visit was rescheduled", body: `Moved from ${from} to ${to}.` })
      );
      return { id: visitId, status: VisitStatus.SCHEDULED, date: to };
    },
  };
}
