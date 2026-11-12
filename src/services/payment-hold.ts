import { InvoiceStatus, LifecycleStatus, VisitStatus } from "../generated/tenant-client";
import { startOfUtcDay } from "../lib/schedule";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import type { TenantDb } from "./visit-assignment";
import { NOT_COLLECTING_INVOICE } from "./direct-debit";
import { notifyVisitTechnicians, visitCount, type VisitRef } from "./notify";

// FLOW-03 / NOTIF-01: a hold blocks Start and a release unblocks it, so the technicians
// on those visits are told. Callers of this module always pass the real tenant client
// (never a transaction), which is what the notifier needs. Best effort.
async function notifyHoldChange(tp: TenantDb, visits: VisitRef[], customerId: string, placed: boolean): Promise<void> {
  await notifyVisitTechnicians(
    tp as TenantPrismaClient,
    visits,
    ({ count, first }) => ({
      type: "PAYMENT",
      title: placed ? `Payment hold: ${visitCount(count)} on hold` : `Payment hold released: ${visitCount(count)}`,
      body: placed
        ? `The customer has unpaid invoices. Do not start the visit on ${first} until the office releases the hold.`
        : `The hold is lifted. You can start the visit on ${first}.`,
    }),
    { customerId }
  );
}

// Payment hold (A3 · GAP-026). One home for "put a customer's next clean on
// hold" and "release it", shared by PATCH /debt/:id/hold and every path that
// turns an invoice PAID (payment.service.applyOutcome, the Stripe and
// GoCardless webhooks, POST /invoices/:id/mark-paid).

/** Flag the next SCHEDULED visit (today or later) on each ACTIVE property of
 *  the customer with paymentHold. Returns how many visits were flagged. */
export async function holdNextVisits(tp: TenantDb, customerId: string, now: Date = new Date()): Promise<number> {
  const today = startOfUtcDay(now);
  const properties = await tp.property.findMany({
    where: { customerId, status: LifecycleStatus.ACTIVE },
    select: { id: true },
  });
  let held = 0;
  const heldVisits: VisitRef[] = [];
  for (const property of properties) {
    const next = await tp.visit.findFirst({
      where: { propertyId: property.id, status: VisitStatus.SCHEDULED, date: { gte: today } },
      orderBy: { date: "asc" },
      select: { id: true, technicianId: true, date: true, roundId: true, propertyId: true },
    });
    if (!next) continue;
    await tp.visit.update({ where: { id: next.id }, data: { paymentHold: true } });
    heldVisits.push(next);
    held++;
  }
  await notifyHoldChange(tp, heldVisits, customerId, true);
  return held;
}

/** Clear paymentHold on all of the customer's future SCHEDULED visits. */
export async function releaseHeldVisits(tp: TenantDb, customerId: string, now: Date = new Date()): Promise<number> {
  const where = {
    property: { customerId },
    status: VisitStatus.SCHEDULED,
    date: { gte: startOfUtcDay(now) },
    paymentHold: true,
  };
  const released = await tp.visit.findMany({
    where,
    select: { id: true, technicianId: true, date: true, roundId: true, propertyId: true },
  });
  const result = await tp.visit.updateMany({ where, data: { paymentHold: false } });
  await notifyHoldChange(tp, released, customerId, false);
  return result.count;
}

/** After an invoice is paid: when debt hold is enabled and the customer is on
 *  hold with no other unpaid (SENT, incl. overdue) invoices, release the hold
 *  on the customer and their visits. Returns true when a hold was released. */
export async function releaseHoldIfSettled(tp: TenantDb, customerId: string): Promise<boolean> {
  const settings = await tp.businessSettings.findFirst({ select: { debtHoldEnabled: true } });
  if (!settings?.debtHoldEnabled) return false;

  const customer = await tp.customer.findUnique({ where: { id: customerId }, select: { holdNextClean: true } });
  if (!customer?.holdNextClean) return false;

  const unpaid = await tp.invoice.count({ where: { customerId, status: InvoiceStatus.SENT, ...NOT_COLLECTING_INVOICE } });
  if (unpaid > 0) return false;

  await tp.customer.update({
    where: { id: customerId },
    data: { holdNextClean: false, holdReason: null, holdSince: null },
  });
  await releaseHeldVisits(tp, customerId);
  return true;
}
