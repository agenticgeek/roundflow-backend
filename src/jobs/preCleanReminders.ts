import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { DEFAULT_TIMEZONE, resolveTimeZone, localDateTime } from "../lib/dates";
import { canonicalPlaceholder } from "../services/message-templates";
import { parseStoredReminders } from "../lib/settings-validators";
import { LifecycleStatus, MessageChannel, ReminderMode, VisitStatus } from "../generated/tenant-client";

// B2 / GAP-003 / BUG-01: pre-clean reminders driven by BusinessSettings.preCleanReminders
// (a list of { type, time }; legacy reminderMode + reminderTime as fallback) (tenant-local, BusinessSettings.timezone, Europe/London by
// default). Runs every 15 minutes when PRECLEAN_REMINDERS_ENABLED=true. Once a
// tenant's local clock has passed reminderTime it queues one reminder per
// SCHEDULED visit on the target day — tomorrow for EVENING_BEFORE, today for
// MORNING_OF — and records the type in Visit.reminderSentTypes, so a visit gets each reminder
// type at most once however often the job runs.
//
// Delivery goes through the GHL outbox as a "message.send" row
// ({ customerId, visitId, channel, body, templateId, reason }); the outbox
// worker drains it and sends through GHL. Customers with messagesOptOut are
// skipped here and again at drain time.

// Re-exported: the time-zone helpers live in lib/dates.ts (EMU-6).
export { DEFAULT_TIMEZONE, resolveTimeZone, localDateTime };
export const REMINDER_TEMPLATE_NAMES = ["Pre-clean reminder", "Appointment Reminder"];
export const DEFAULT_REMINDER_BODY =
  "Hi {{customerName}}, this is a reminder that your window clean is booked for {{date}}.";

export function isPreCleanRemindersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRECLEAN_REMINDERS_ENABLED === "true";
}

/** UTC-midnight Date for the tenant-local day the reminder targets, or null
 *  when reminders are off or reminderTime hasn't been reached yet. */
export function reminderTargetDay(input: {
  now: Date;
  mode: ReminderMode;
  reminderTime: string;
  timeZone: string;
}): Date | null {
  if (input.mode === ReminderMode.NONE) return null;
  const local = localDateTime(input.now, input.timeZone);
  if (local.time < input.reminderTime) return null;
  const day = new Date(`${local.date}T00:00:00.000Z`);
  if (input.mode === ReminderMode.EVENING_BEFORE) day.setUTCDate(day.getUTCDate() + 1);
  return day;
}

/** Fills {{customerName}} / {{date}} / {{address}} / {{businessName}} (and the
 *  seeded [Customer Name] style); any other {{variable}} renders empty. */
export function renderReminder(
  body: string,
  vars: { customerName: string; date: string; address: string; businessName: string }
): string {
  return body
    .replace(/\[Customer Name\]/gi, vars.customerName)
    .replace(/\[Date\]/gi, vars.date)
    .replace(/\[Address\]/gi, vars.address)
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, raw: string) => {
      const key = canonicalPlaceholder(raw); // legacy snake_case tokens still render
      return key in vars ? vars[key as keyof typeof vars] : "";
    });
}

function pickChannel(preferred: MessageChannel | null, phone: string | null, email: string | null): MessageChannel | null {
  const channel = preferred ?? MessageChannel.SMS;
  if (channel === MessageChannel.EMAIL) return email ? channel : phone ? MessageChannel.SMS : null;
  return phone ? channel : email ? MessageChannel.EMAIL : null;
}

export async function runTenantPreCleanReminders(tp: TenantPrismaClient, now: Date): Promise<number> {
  const bs = await tp.businessSettings.findFirst({
    select: {
      setupCompleted: true,
      reminderMode: true,
      reminderTime: true,
      preCleanReminders: true,
      timezone: true,
      businessName: true,
    },
  });
  if (!bs?.setupCompleted) return 0;

  // BUG-01: one pass per enabled reminder; legacy rows fall back to mode/time.
  const reminders = parseStoredReminders(bs.preCleanReminders, bs.reminderMode, bs.reminderTime);
  const timeZone = resolveTimeZone(bs.timezone);
  let queued = 0;
  let template: Awaited<ReturnType<typeof tp.messageTemplate.findFirst>> | undefined;

  for (const reminder of reminders) {
    const target = reminderTargetDay({ now, mode: reminder.type as ReminderMode, reminderTime: reminder.time, timeZone });
    if (!target) continue;
    const dayAfter = new Date(target);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);

    const visits = await tp.visit.findMany({
      where: {
        date: { gte: target, lt: dayAfter },
        status: VisitStatus.SCHEDULED,
        NOT: { reminderSentTypes: { has: reminder.type } },
        paymentHold: false,
        property: { customer: { status: LifecycleStatus.ACTIVE, holdNextClean: false, messagesOptOut: false } },
      },
      select: {
        id: true,
        date: true,
        property: {
          select: {
            addressLine: true,
            customer: { select: { id: true, name: true, phone: true, email: true } },
          },
        },
      },
    });
    if (visits.length === 0) continue;

    if (template === undefined) {
      template = await tp.messageTemplate.findFirst({
        where: { OR: REMINDER_TEMPLATE_NAMES.map((name) => ({ name: { equals: name, mode: "insensitive" as const } })) },
        orderBy: { createdAt: "asc" },
      });
    }

    for (const visit of visits) {
      const customer = visit.property.customer;
      const channel = pickChannel(template?.channel ?? null, customer.phone, customer.email);
      if (!channel) continue; // no way to reach them; left unstamped so a later contact detail still gets it

      const body = renderReminder(template?.body ?? DEFAULT_REMINDER_BODY, {
        customerName: customer.name,
        date: visit.date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }),
        address: visit.property.addressLine,
        businessName: bs.businessName ?? "",
      });

      // Stamp + enqueue atomically; the conditional per-type stamp means an
      // overlapping run can't double-send, and a second reminder type for the
      // same visit is still allowed. Same outbox row shape as queueGhlEvent().
      const sent = await tp.$transaction(async (tx) => {
        const claimed = await tx.visit.updateMany({
          where: { id: visit.id, NOT: { reminderSentTypes: { has: reminder.type } } },
          data: { reminderSentAt: now, reminderSentTypes: { push: reminder.type } },
        });
        if (claimed.count === 0) return false;
        await tx.integrationOutbox.create({
          data: {
            eventType: "message.send",
            payload: {
              customerId: customer.id,
              visitId: visit.id,
              channel,
              body,
              templateId: template?.id ?? null,
              reason: "PRE_CLEAN_REMINDER",
              reminderType: reminder.type,
            },
          },
        });
        return true;
      });
      if (!sent) continue;
      queued++;
    }
  }
  return queued;
}

export async function runPreCleanReminders(now: Date = new Date()): Promise<{ tenants: number; queued: number }> {
  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });
  let queued = 0;
  for (const t of tenants) {
    try {
      queued += await runTenantPreCleanReminders(getTenantPrismaForSchema(t.schemaName), now);
    } catch (err) {
      console.error(`[preCleanReminders] tenant ${t.schemaName} failed:`, err);
    }
  }
  return { tenants: tenants.length, queued };
}
