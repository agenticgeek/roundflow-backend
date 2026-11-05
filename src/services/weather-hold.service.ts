import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { CleaningFrequency, DayOfWeek, Prisma, VisitStatus } from "../generated/tenant-client";
import { createMessageService, type BroadcastResult, type BroadcastTarget } from "./message.service";
import { FALLBACK_BODIES, TEMPLATE_NAMES, formatTemplateDate, loadTemplate, renderTemplate } from "./message-templates";
import { nextDueAfter, snapToWeekday, startOfUtcDay } from "../lib/schedule";
import { tenantToday } from "./business-time";
import { REMINDER_MARKERS_RESET, assertDayNotClosed, cancelPendingVisitMessages } from "./visit-reschedule";

// Weather Hold (Round Planner): the office postpones one round-day because of
// the weather. The round's SCHEDULED visits on that date are moved (or taken
// off the list), the action is written to the activity log, and the affected
// customers are told through the shared message path (opt-out honoured, Message
// rows persisted, tenant "Weather Hold" template when present).

export const ACTIVITY_WEATHER_HOLD = "WEATHER_HOLD";

/** `phrase` completes "due to ..." in the customer message. */
export const WEATHER_CONDITIONS = {
  "heavy-rain": { label: "Heavy rain", phrase: "heavy rain" },
  "high-winds": { label: "High winds", phrase: "high winds" },
  "snow-ice": { label: "Snow / ice", phrase: "snow and ice" },
  "technician-safety": { label: "Technician safety", phrase: "safety concerns for our team" },
} as const;
export type WeatherCondition = keyof typeof WEATHER_CONDITIONS;

/**
 * next-available: SCHEDULED visits move to the next working day (Mon-Fri) after the held date.
 * next-cycle:     each visit moves to its next regular cycle date (plan/round frequency, on the
 *                 round day) and the plan's nextDueDate moves a cycle on, so it is not cleaned twice.
 *                 A visit with no frequency falls back to next-available.
 * manual:         visits are marked SKIPPED ("Weather hold: <condition>") and keep no date — the
 *                 office books a new one later (e.g. Add One-off Job).
 */
export const WEATHER_RESCHEDULING = ["next-available", "next-cycle", "manual"] as const;
export type WeatherRescheduling = (typeof WEATHER_RESCHEDULING)[number];

export interface WeatherHoldInput {
  /** The round-day being held (UTC-midnight date). Must be today or later. */
  date: Date;
  condition: WeatherCondition;
  rescheduling: WeatherRescheduling;
}

export interface WeatherHoldApplyInput extends WeatherHoldInput {
  notifyCustomers: boolean;
  actor?: { id?: string; role?: string };
}

export interface WeatherHoldPreview {
  date: string;
  affectedVisits: number;
  affectedCustomers: number;
  /** Customers who will not be messaged (messagesOptOut). */
  optedOutCustomers: number;
  /** Earliest new visit date (YYYY-MM-DD); null for `manual`. */
  newDate: string | null;
  /** The customer message rendered for the first affected customer ("" when nothing is affected). */
  message: string;
  characterCount: number;
  /** The tenant template used, or null for the built-in wording. */
  templateName: string | null;
}

export interface WeatherHoldResult {
  roundId: string;
  date: string;
  condition: WeatherCondition;
  rescheduling: WeatherRescheduling;
  /** Visits actually moved / taken off the list. */
  held: number;
  newDate: string | null;
  /** null when notifyCustomers was false or the notification step itself failed (see notificationError). */
  notification: BroadcastResult | null;
  notificationError?: string;
}

const NEW_DATE_TOKEN_RE = /\{\{\s*(newDate|new_date)\s*\}\}|\[\s*new date\s*\]/i;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function targetDateFor(
  rescheduling: WeatherRescheduling,
  day: Date,
  frequency: CleaningFrequency | null,
  defaultDay: DayOfWeek | null
): Date | null {
  if (rescheduling === "manual") return null;
  if (rescheduling === "next-cycle" && frequency) return nextDueAfter(day, frequency, defaultDay);
  const tomorrow = new Date(day);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return snapToWeekday(tomorrow);
}

export function createWeatherHoldService(prisma: TenantPrismaClient) {
  const customerSelect = { id: true, name: true, phone: true, email: true, ghlContactId: true, messagesOptOut: true } as const;

  const loadPlan = async (roundId: string, input: WeatherHoldInput) => {
    const round = await prisma.round.findUnique({
      where: { id: roundId },
      select: { name: true, frequency: true, defaultDay: true },
    });
    if (!round) throw new AppError(404, "Round not found");

    const day = startOfUtcDay(input.date);
    if (day < (await tenantToday(prisma))) throw new AppError(400, '"date" must be today or later');

    const visits = await prisma.visit.findMany({
      where: { roundId, status: VisitStatus.SCHEDULED, date: { gte: day, lt: new Date(day.getTime() + 86_400_000) } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        servicePlan: { select: { id: true, cleaningFrequency: true, nextDueDate: true } },
        technician: { select: { name: true } },
        property: { select: { addressLine: true, customer: { select: customerSelect } } },
      },
    });

    const items = visits.map((v) => {
      const frequency = v.servicePlan?.cleaningFrequency ?? round.frequency;
      return { visit: v, frequency, target: targetDateFor(input.rescheduling, day, frequency, round.defaultDay) };
    });

    const settings = await prisma.businessSettings.findFirst({ select: { businessName: true } });
    const phrase = WEATHER_CONDITIONS[input.condition].phrase;
    const byCustomer = new Map<string, BroadcastTarget>();
    const earliest = new Map<string, string>();
    for (const { visit, target } of items) {
      const customer = visit.property.customer;
      // A customer with several held visits is told about the earliest new date.
      if (byCustomer.has(customer.id) && (!target || earliest.get(customer.id)! <= isoDay(target))) continue;
      earliest.set(customer.id, target ? isoDay(target) : "");
      byCustomer.set(customer.id, {
        customer,
        vars: {
          customerName: customer.name,
          firstName: customer.name.split(" ")[0],
          address: visit.property.addressLine,
          date: formatTemplateDate(day),
          newDate: target ? formatTemplateDate(target) : "",
          condition: phrase,
          roundName: round.name,
          technicianName: visit.technician?.name ?? "",
          businessName: settings?.businessName ?? "",
        },
      });
    }

    const manual = input.rescheduling === "manual";
    let template = await loadTemplate(
      prisma,
      TEMPLATE_NAMES.WEATHER_HOLD,
      manual ? FALLBACK_BODIES.WEATHER_HOLD_TBC : FALLBACK_BODIES.WEATHER_HOLD
    );
    // A manual hold has no date to give: a tenant template that promises one ({{newDate}}) would
    // read nonsense, so the built-in "we'll be in touch" wording is used instead.
    if (manual && template.id && NEW_DATE_TOKEN_RE.test(template.body)) {
      template = { id: null, body: FALLBACK_BODIES.WEATHER_HOLD_TBC };
    }
    const targetDates = items.flatMap((i) => (i.target ? [i.target] : [])).sort((a, b) => a.getTime() - b.getTime());
    return { round, day, items, targets: [...byCustomer.values()], template, newDate: targetDates[0] ?? null };
  };

  return {
    // Read-only: what applying the hold would do, with the customer message rendered.
    preview: async (roundId: string, input: WeatherHoldInput): Promise<WeatherHoldPreview> => {
      const { day, items, targets, template, newDate } = await loadPlan(roundId, input);
      const message = targets[0] ? renderTemplate(template.body, targets[0].vars) : "";
      return {
        date: isoDay(day),
        affectedVisits: items.length,
        affectedCustomers: targets.length,
        optedOutCustomers: targets.filter((t) => t.customer.messagesOptOut).length,
        newDate: newDate ? isoDay(newDate) : null,
        message,
        characterCount: message.length,
        templateName: template.id ? TEMPLATE_NAMES.WEATHER_HOLD : null,
      };
    },

    apply: async (roundId: string, input: WeatherHoldApplyInput): Promise<WeatherHoldResult> => {
      const messages = createMessageService(prisma);
      // Fail before anything moves: a hold that cannot tell customers should be a conscious choice.
      if (input.notifyCustomers) await messages.assertGhlConnected();

      const plan = await loadPlan(roundId, input);
      const { round, day, items, targets, template } = plan;
      // Same rule as Reassign / Push Missed: no mutating a day that Close Day has run for.
      await assertDayNotClosed(prisma, day);
      if (items.length === 0) {
        throw new AppError(409, "No scheduled visits to hold on this date", "NO_VISITS_TO_HOLD");
      }

      const conditionLabel = WEATHER_CONDITIONS[input.condition].label;
      const held = await prisma.$transaction(async (tx) => {
        let count = 0;
        if (input.rescheduling === "manual") {
          const res = await tx.visit.updateMany({
            where: { id: { in: items.map((i) => i.visit.id) }, status: VisitStatus.SCHEDULED },
            data: { status: VisitStatus.SKIPPED, skipReason: `Weather hold: ${conditionLabel}` },
          });
          count = res.count;
        } else {
          const byTarget = new Map<string, { target: Date; ids: string[] }>();
          for (const { visit, target } of items) {
            const group = byTarget.get(isoDay(target!)) ?? { target: target!, ids: [] };
            group.ids.push(visit.id);
            byTarget.set(isoDay(target!), group);
          }
          for (const { target, ids } of byTarget.values()) {
            const res = await tx.visit.updateMany({
              where: { id: { in: ids }, status: VisitStatus.SCHEDULED },
              // New date = new reminders: clear the markers so pre-clean reminders fire for it.
              data: { date: target, ...REMINDER_MARKERS_RESET },
            });
            count += res.count;
          }
        }

        if (input.rescheduling === "next-cycle") {
          // The visit now stands in for the next cycle, so the plan's following visit moves a cycle on.
          const bumped = new Set<string>();
          for (const { visit, frequency, target } of items) {
            const planRow = visit.servicePlan;
            if (!planRow || !frequency || !target || bumped.has(planRow.id)) continue;
            if (planRow.nextDueDate && planRow.nextDueDate <= target) {
              bumped.add(planRow.id);
              await tx.servicePlan.update({
                where: { id: planRow.id },
                data: { nextDueDate: nextDueAfter(target, frequency, round.defaultDay) },
              });
            }
          }
        }

        // Reminders still queued for these visits carry the old date (or a visit no longer on the list).
        const cancelledReminders = await cancelPendingVisitMessages(
          tx,
          items.map((i) => i.visit.id),
          "Weather hold"
        );

        const newDate = plan.newDate ? isoDay(plan.newDate) : null;
        await tx.activityLog.create({
          data: {
            type: ACTIVITY_WEATHER_HOLD,
            message:
              `Weather hold (${conditionLabel}) on round ${round.name} for ${isoDay(day)}: ${count} visit(s) ` +
              (input.rescheduling === "manual" ? "taken off the list (reschedule manually)" : `moved to ${newDate} (${input.rescheduling})`),
            actorId: input.actor?.id ?? null,
            actorRole: input.actor?.role ?? null,
            entityId: roundId,
            details: {
              date: isoDay(day),
              condition: input.condition,
              rescheduling: input.rescheduling,
              newDate,
              visitIds: items.map((i) => i.visit.id),
              notifyCustomers: input.notifyCustomers,
              cancelledReminders,
            } as Prisma.InputJsonValue,
          },
        });
        return count;
      });

      const result: WeatherHoldResult = {
        roundId,
        date: isoDay(day),
        condition: input.condition,
        rescheduling: input.rescheduling,
        held,
        newDate: plan.newDate ? isoDay(plan.newDate) : null,
        notification: null,
      };
      if (!input.notifyCustomers) return result;

      try {
        result.notification = await messages.broadcast(targets, {
          body: template.body,
          templateId: template.id,
          reason: ACTIVITY_WEATHER_HOLD,
          extraPayload: { roundId },
        });
      } catch (err) {
        // The hold itself is done; say so rather than failing the whole request.
        console.error(`[weather-hold] notifying round ${roundId} failed:`, err);
        result.notificationError = (err as Error).message;
      }
      return result;
    },
  };
}
