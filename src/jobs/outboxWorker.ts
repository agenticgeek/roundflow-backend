import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { syncCustomerToGhl, applyGhlTags } from "../integrations/ghl/sync";

const MAX_ATTEMPTS = 5;
const BATCH = 20;

type Payload = { customerId?: string };

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
          break;
        case "payment.collected":
          await applyGhlTags(tp, customerId, ["payment-collected"], ["debt-overdue"]);
          break;
        case "debt.overdue":
          await applyGhlTags(tp, customerId, ["debt-overdue"]);
          break;
        case "complaint.logged":
          await applyGhlTags(tp, customerId, ["has-open-complaint"]);
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
