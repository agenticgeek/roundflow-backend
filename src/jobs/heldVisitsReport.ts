import { VisitStatus } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { forEachTenant, type TenantResult } from "./backfills";

// BUG-02: read-only report for PM review. Lists open visits that are on
// payment hold and were created by generation (they belong to a service plan
// and are not one-off / complaint revisits). Generation used to copy
// Customer.holdNextClean onto new visits; those rows are NOT reset here — the
// PM decides which to release. `customerOnHold` says whether the customer
// still has a manual hold (a legitimate reason for the visit to stay held).

export interface HeldVisitRow {
  visitId: string;
  date: string; // YYYY-MM-DD
  status: VisitStatus;
  propertyId: string;
  address: string;
  customerId: string;
  customerName: string;
  customerOnHold: boolean;
  holdReason: string | null;
  holdSince: string | null;
}

export async function listGeneratedHeldVisitsForTenant(tp: TenantPrismaClient): Promise<HeldVisitRow[]> {
  const visits = await tp.visit.findMany({
    where: {
      paymentHold: true,
      status: VisitStatus.SCHEDULED,
      servicePlanId: { not: null },
      isOneOff: false,
      complaintId: null,
    },
    orderBy: { date: "asc" },
    select: {
      id: true,
      date: true,
      status: true,
      propertyId: true,
      property: {
        select: {
          addressLine: true,
          customer: { select: { id: true, name: true, holdNextClean: true, holdReason: true, holdSince: true } },
        },
      },
    },
  });
  return visits.map((v) => ({
    visitId: v.id,
    date: v.date.toISOString().slice(0, 10),
    status: v.status,
    propertyId: v.propertyId,
    address: v.property.addressLine,
    customerId: v.property.customer.id,
    customerName: v.property.customer.name,
    customerOnHold: v.property.customer.holdNextClean,
    holdReason: v.property.customer.holdReason,
    holdSince: v.property.customer.holdSince?.toISOString() ?? null,
  }));
}

export function listGeneratedHeldVisits(): Promise<TenantResult<HeldVisitRow[]>[]> {
  return forEachTenant((tp) => listGeneratedHeldVisitsForTenant(tp));
}
