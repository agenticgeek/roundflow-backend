import { prisma } from "../lib/prisma";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { forEachTenant } from "../lib/tenant-jobs";
import { syncCustomerToGhl, applyGhlTags, applyGhlCustomFields } from "../integrations/ghl/sync";
import { computeBalanceOwed } from "../services/payment.service";
import { createMessageService } from "../services/message.service";
import { FALLBACK_BODIES, TEMPLATE_NAMES, loadTemplate, renderTemplate } from "../services/message-templates";
import { VisitStatus } from "../generated/tenant-client";
import { INVOICE_SEND_EVENT, processInvoiceSendRow } from "../services/invoice-send-batch.service";
import { OUTBOX_MAX_ATTEMPTS, outboxBackoffMs } from "../lib/outbox-backoff";
import { notifyIntegrationDead } from "../services/notify";

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
// The producer's channel is a preference: if it cannot be used now (e.g. SMS but GHL was disconnected) the best
// available channel is used, and a customer who cannot be reached is skipped with a reason (status "skipped").
async function sendQueuedMessage(tp: TenantPrismaClient, customerId: string, payload: Payload): Promise<string | void> {
  if (!payload.body) throw new Error("payload missing body");
  if (await isOptedOut(tp, customerId)) return;
  if (payload.visitId) {
    const visit = await tp.visit.findUnique({ where: { id: payload.visitId }, select: { status: true } });
    if (!visit || visit.status !== VisitStatus.SCHEDULED) return;
  }
  const res = await createMessageService(tp).sendBest({
    customerId,
    preferred: payload.channel,
    body: payload.body,
    templateId: payload.templateId ?? null,
  });
  if (res.status === "skipped") return res.reason;
}

// "Visit completed" message (A5): rendered here from the tenant template so
// edits to the template apply to messages still in the queue.
async function sendVisitCompletedMessage(tp: TenantPrismaClient, customerId: string, payload: Payload): Promise<string | void> {
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
  const res = await createMessageService(tp).sendBest({ customerId, body, templateId: template.id });
  if (res.status === "skipped") return res.reason;
}

// Wave 2B-2 (GHL-05): GHL is optional. Every tenant is drained because message.send / message.visit_completed /
// invoice.send are delivered by the native mailer (or GHL for SMS, decided per customer by the channel router).
// The CRM events below only make sense with GHL; for a tenant that is not connected they are DROPPED (status
// "dropped": not retried, not dead, no admin alert).
const GHL_ONLY_EVENTS = new Set([
  "customer.synced", "visit.completed", "visit.scheduled", "payment.collected", "payment.failed", "debt.overdue",
  "complaint.logged", "complaint.resolved",
]);

export async function runOutboxWorker(): Promise<void> {
  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });

  // BUG-010: bounded concurrency through the shared client cache (never one client per tenant at once).
  await forEachTenant(tenants, (tp) => processTenant(tp));
}

async function processTenant(tp: TenantPrismaClient): Promise<void> {
  const rows = await tp.integrationOutbox.findMany({
    // runAfter = delayed sends (scheduled round messages): not drained before their time.
    where: { status: "pending", OR: [{ runAfter: null }, { runAfter: { lte: new Date() } }] },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });

  if (rows.length === 0) return;
  const ghlConnected = (await tp.businessSettings.findFirst({ select: { ghlConnected: true } }))?.ghlConnected === true;

  for (const row of rows) {
    if (!ghlConnected && GHL_ONLY_EVENTS.has(row.eventType)) {
      await tp.integrationOutbox.update({
        where: { id: row.id },
        data: { status: "dropped", lastError: "GoHighLevel is not connected", processedAt: new Date() },
      });
      continue;
    }
    // ACT-01: invoice.send has its own atomic claim, retry and result handling.
    if (row.eventType === INVOICE_SEND_EVENT) {
      await processInvoiceSendRow(tp, row);
      continue;
    }
    const payload = row.payload as Payload;
    const customerId = payload.customerId;
    let unknownType = false;
    let skipReason: string | void = undefined;

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
          skipReason = await sendQueuedMessage(tp, customerId, payload);
          break;
        case "message.visit_completed":
          skipReason = await sendVisitCompletedMessage(tp, customerId, payload);
          break;
        default:
          unknownType = true;
      }

      if (unknownType) {
        // BE-12: an event type nothing handles is a bug, not a success: park it as dead (visible, replayable) and
        // tell the office, instead of silently marking it sent.
        console.warn(`[outbox] unknown eventType: ${row.eventType}`);
        await tp.integrationOutbox.update({
          where: { id: row.id },
          data: { status: "dead", lastError: `Unknown event type: ${row.eventType}`, processedAt: new Date() },
        });
        await notifyIntegrationDead(tp, { id: row.id, eventType: row.eventType, lastError: `Unknown event type: ${row.eventType}` });
        continue;
      }

      await tp.integrationOutbox.update({
        where: { id: row.id },
        data: skipReason
          ? { status: "skipped", lastError: skipReason, processedAt: new Date() }
          : { status: "sent", processedAt: new Date() },
      });
    } catch (err) {
      const attempts = row.attempts + 1;
      const dead = attempts >= OUTBOX_MAX_ATTEMPTS;
      await tp.integrationOutbox.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: String(err),
          status: dead ? "dead" : "pending",
          // BE-12: exponential back-off (30 s, 2 min, 10 min, 1 h, 6 h) through runAfter instead of retrying every drain.
          runAfter: dead ? null : new Date(Date.now() + outboxBackoffMs(attempts)),
          ...(dead ? { processedAt: new Date() } : {}),
        },
      });
      if (dead) {
        console.error(`[outbox] row ${row.id} (${row.eventType}) dead after ${OUTBOX_MAX_ATTEMPTS} attempts:`, err);
        await notifyIntegrationDead(tp, { id: row.id, eventType: row.eventType, lastError: String(err) });
      }
    }
  }
}
