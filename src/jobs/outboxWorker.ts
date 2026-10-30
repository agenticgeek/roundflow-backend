import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { syncCustomerToGhl, applyGhlTags, applyGhlCustomFields } from "../integrations/ghl/sync";
import { computeBalanceOwed } from "../services/payment.service";
import { createMessageService } from "../services/message.service";
import { FALLBACK_BODIES, TEMPLATE_NAMES, loadTemplate, renderTemplate } from "../services/message-templates";
import { VisitStatus } from "../generated/tenant-client";

const MAX_ATTEMPTS = 5;
const BATCH = 20;

type Payload = {
  customerId?: string;
  visitId?: string;
  nextCleanDate?: string;
  // message.send (pre-clean reminders): body is already rendered by the producer.
  channel?: string;
  body?: string;
  templateId?: string | null;
  // message.visit_completed: template name to render at drain time.
  template?: string;
};

async function writeBalanceOwed(tp: TenantPrismaClient, customerId: string): Promise<void> {
  const balance = await computeBalanceOwed(tp, customerId);
  await applyGhlCustomFields(tp, customerId, { balance_owed: balance });
}

// last_clean_date / round_name / technician_name (docs/GHL_AUTOMATION_OWNER_HANDOFF.md §1)
// are only known at drain time via the Visit row — the outbox payload just
// carries the visitId.
async function writeVisitCompletedFields(tp: TenantPrismaClient, customerId: string, visitId: string): Promise<void> {
  const visit = await tp.visit.findUnique({
    where: { id: visitId },
    select: { completedAt: true, round: { select: { name: true } }, technician: { select: { name: true } } },
  });

  const fields: Record<string, string | number> = { balance_owed: await computeBalanceOwed(tp, customerId) };
  if (visit?.completedAt) fields.last_clean_date = visit.completedAt.toISOString().slice(0, 10);
  if (visit?.round?.name) fields.round_name = visit.round.name;
  if (visit?.technician?.name) fields.technician_name = visit.technician.name;

  await applyGhlCustomFields(tp, customerId, fields);
}

// Automated customer messages honour Customer.messagesOptOut at drain time
// (the producers also skip opted-out customers, but the flag may have been set
// after the row was queued). An opted-out or deleted customer is a no-op, so
// the row is marked sent without contacting GHL.
async function isOptedOut(tp: TenantPrismaClient, customerId: string): Promise<boolean> {
  const customer = await tp.customer.findUnique({ where: { id: customerId }, select: { messagesOptOut: true } });
  return !customer || customer.messagesOptOut;
}

// Pre-rendered message (pre-clean reminders). A reminder whose visit was
// cancelled/skipped/completed before the drain is dropped.
async function sendQueuedMessage(tp: TenantPrismaClient, customerId: string, payload: Payload): Promise<void> {
  if (!payload.body) throw new Error("payload missing body");
  if (await isOptedOut(tp, customerId)) return;
  if (payload.visitId) {
    const visit = await tp.visit.findUnique({ where: { id: payload.visitId }, select: { status: true } });
    if (!visit || visit.status !== VisitStatus.SCHEDULED) return;
  }
  await createMessageService(tp).send({
    customerId,
    channel: payload.channel,
    body: payload.body,
    templateId: payload.templateId ?? null,
  });
}

// "Visit completed" message (A5): rendered here from the tenant template so
// edits to the template apply to messages still in the queue.
async function sendVisitCompletedMessage(tp: TenantPrismaClient, customerId: string, payload: Payload): Promise<void> {
  if (await isOptedOut(tp, customerId)) return;
  const visit = payload.visitId
    ? await tp.visit.findUnique({
        where: { id: payload.visitId },
        select: {
          completedAt: true,
          date: true,
          property: { select: { addressLine: true, customer: { select: { name: true } } } },
          round: { select: { name: true } },
          technician: { select: { name: true } },
        },
      })
    : null;
  if (!visit) throw new Error("payload visit not found");

  const bs = await tp.businessSettings.findFirst({ select: { businessName: true } });
  const template = await loadTemplate(
    tp,
    payload.template ?? TEMPLATE_NAMES.VISIT_COMPLETED,
    FALLBACK_BODIES.VISIT_COMPLETED
  );
  const customerName = visit.property.customer.name;
  const body = renderTemplate(template.body, {
    customerName,
    firstName: customerName.split(" ")[0],
    address: visit.property.addressLine,
    date: (visit.completedAt ?? visit.date).toISOString().slice(0, 10),
    roundName: visit.round?.name ?? "",
    technicianName: visit.technician?.name ?? "",
    businessName: bs?.businessName ?? "",
  });
  await createMessageService(tp).send({ customerId, body, templateId: template.id });
}

// Only GHL-connected tenants are drained: every handler below (tags, custom
// fields and the message.* sends) goes through GHL. Rows queued for a tenant
// that has not connected GHL stay pending until it does.
export async function runOutboxWorker(): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    where: { ghlLocationId: { not: null } },
    select: { schemaName: true },
  });

  await Promise.allSettled(tenants.map((t) => processTenant(t.schemaName)));
}

async function processTenant(schemaName: string): Promise<void> {
  const tp = getTenantPrismaForSchema(schemaName);

  const rows = await tp.integrationOutbox.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });

  for (const row of rows) {
    const payload = row.payload as Payload;
    const customerId = payload.customerId;

    try {
      if (!customerId) throw new Error("payload missing customerId");

      switch (row.eventType) {
        case "customer.synced":
          await syncCustomerToGhl(tp, customerId);
          break;
        case "visit.completed":
          await applyGhlTags(tp, customerId, ["visit-completed"]);
          if (payload.visitId) await writeVisitCompletedFields(tp, customerId, payload.visitId);
          break;
        case "visit.scheduled":
          if (payload.nextCleanDate) {
            await applyGhlCustomFields(tp, customerId, { next_clean_date: payload.nextCleanDate });
          }
          break;
        case "payment.collected":
          await applyGhlTags(tp, customerId, ["payment-collected"], ["debt-overdue", "payment-failed"]);
          await writeBalanceOwed(tp, customerId);
          break;
        case "payment.failed":
          await applyGhlTags(tp, customerId, ["payment-failed"]);
          await writeBalanceOwed(tp, customerId);
          break;
        case "debt.overdue":
          await applyGhlTags(tp, customerId, ["debt-overdue"]);
          await writeBalanceOwed(tp, customerId);
          break;
        case "complaint.logged":
          await applyGhlTags(tp, customerId, ["has-open-complaint"]);
          break;
        case "complaint.resolved":
          await applyGhlTags(tp, customerId, [], ["has-open-complaint"]);
          break;
        case "message.send":
          await sendQueuedMessage(tp, customerId, payload);
          break;
        case "message.visit_completed":
          await sendVisitCompletedMessage(tp, customerId, payload);
          break;
        default:
          console.warn(`[outbox] unknown eventType: ${row.eventType}`);
      }

      await tp.integrationOutbox.update({
        where: { id: row.id },
        data: { status: "sent", processedAt: new Date() },
      });
    } catch (err) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await tp.integrationOutbox.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: String(err),
          status: dead ? "dead" : "pending",
          ...(dead ? { processedAt: new Date() } : {}),
        },
      });
      if (dead) {
        console.error(`[outbox] row ${row.id} (${row.eventType}) dead after ${MAX_ATTEMPTS} attempts:`, err);
      }
    }
  }
}
