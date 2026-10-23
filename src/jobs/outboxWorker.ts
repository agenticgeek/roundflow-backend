import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { syncCustomerToGhl, applyGhlTags, applyGhlCustomFields } from "../integrations/ghl/sync";
import { computeBalanceOwed } from "../services/payment.service";

const MAX_ATTEMPTS = 5;
const BATCH = 20;

type Payload = { customerId?: string; visitId?: string; nextCleanDate?: string };

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
