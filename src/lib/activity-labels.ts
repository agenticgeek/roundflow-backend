import type { TenantPrismaClient } from "./tenant-prisma-manager";

// Human labels for the System Activity Log. Messages used to embed raw ids ("Generated 1 visit(s) for round:
// cmwe0qxar...") which admins cannot read. These helpers look the name up and NEVER throw: a missing row or a failed
// lookup falls back to a generic noun, so logging an activity can never break the request that triggered it.

type Client = Pick<TenantPrismaClient, "round" | "technician" | "customer" | "visit" | "property">;

async function safe<T>(lookup: () => Promise<T | null | undefined>, fallback: string, pick: (row: T) => string | null | undefined): Promise<string> {
  try {
    const row = await lookup();
    const label = row ? pick(row)?.trim() : "";
    return label ? label : fallback;
  } catch {
    return fallback;
  }
}

export const roundLabel = (prisma: Client, id: string): Promise<string> =>
  safe(() => prisma.round.findUnique({ where: { id }, select: { name: true } }), "a round", (r) => (r.name ? `"${r.name}"` : null));

export const technicianLabel = (prisma: Client, id: string): Promise<string> =>
  safe(() => prisma.technician.findUnique({ where: { id }, select: { name: true } }), "a technician", (t) => t.name);

export const customerLabel = (prisma: Client, id: string): Promise<string> =>
  safe(() => prisma.customer.findUnique({ where: { id }, select: { name: true } }), "a customer", (c) => c.name);

export const propertyLabel = (prisma: Client, id: string): Promise<string> =>
  safe(
    () => prisma.property.findUnique({ where: { id }, select: { addressLine: true, propertyName: true, customer: { select: { name: true } } } }),
    "a property",
    (p) => [p.customer?.name, p.propertyName ?? p.addressLine].filter(Boolean).join(", ")
  );

/** "AUDIT-Customer One, 5 Fenkle Street" — the customer and where the visit is. */
export const visitLabel = (prisma: Client, id: string): Promise<string> =>
  safe(
    () => prisma.visit.findUnique({ where: { id }, select: { property: { select: { addressLine: true, customer: { select: { name: true } } } } } }),
    "a visit",
    (v) => [v.property?.customer?.name, v.property?.addressLine].filter(Boolean).join(", ")
  );

/** Same label from rows the caller already loaded (no extra query). */
export const visitLabelFrom = (customerName: string | null | undefined, addressLine: string | null | undefined): string =>
  [customerName, addressLine].filter(Boolean).join(", ") || "a visit";
