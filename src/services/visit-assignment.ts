import { Prisma, VisitStatus } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { startOfUtcDay } from "../lib/schedule";

// Who does which visit (X-1 / GAP-012 / GAP-013 / GAP-030). Generation,
// activation, PUT /rounds/:id/technicians and the backfill all resolve a
// visit's technician through here so the rule lives in one place.

// Accepts either the tenant client or an interactive-transaction client, so
// callers can restamp inside the same $transaction that rewrote the round.
export type TenantDb = TenantPrismaClient | Prisma.TransactionClient;

// 1. The property's assigned technician, if still on the round and available.
// 2. Otherwise the round's only available technician.
// 3. Otherwise null (unassigned — multi-tech round without an allocation, or
//    nobody available).
export function resolveTechnicianForVisit(input: {
  assignedTechnicianId: string | null;
  roundTechnicianIds: string[];
  unavailableTechnicianIds?: string[];
}): string | null {
  const unavailable = new Set(input.unavailableTechnicianIds ?? []);
  const available = input.roundTechnicianIds.filter((id) => !unavailable.has(id));
  if (input.assignedTechnicianId && available.includes(input.assignedTechnicianId)) {
    return input.assignedTechnicianId;
  }
  return available.length === 1 ? available[0] : null;
}

type SplitProperty = { id: string; postcode: string | null; addressLine1: string | null };

type SortKey = { id: string; postcode: string; street: string; houseNumber: number };

// "12a High Street, Alnwick" → { houseNumber: 12, street: "high street" }.
// No leading number (e.g. "Rose Cottage") → the whole first segment is the
// street and the property sorts after the numbered ones on it.
function parseAddress(addressLine: string | null): { street: string; houseNumber: number } {
  const first = (addressLine ?? "").split(",")[0].trim().toLowerCase();
  const match = /^(\d+)[a-z]?\b\s*(.*)$/.exec(first);
  if (!match) return { street: first, houseNumber: Number.POSITIVE_INFINITY };
  return { street: match[2].trim(), houseNumber: Number(match[1]) };
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.postcode !== b.postcode) return a.postcode < b.postcode ? -1 : 1;
  if (a.street !== b.street) return a.street < b.street ? -1 : 1;
  if (a.houseNumber !== b.houseNumber) return a.houseNumber < b.houseNumber ? -1 : 1;
  return a.id < b.id ? -1 : 1; // ids are unique
}

// Deterministic, balanced split of a round's properties between technicians.
// Properties are ordered by postcode, street, house number, then cut into
// contiguous chunks — one per technician, in technicianIds order. Whole
// streets stay together: a street goes to the chunk its first property falls
// nearest to (rounded position), so a long street can't drag every later
// street onto one technician. With very uneven streets one technician can end
// up with fewer properties (or none) — whole streets win over exact balance.
export function autoSplit(properties: SplitProperty[], technicianIds: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (properties.length === 0 || technicianIds.length === 0) return result;

  const sorted: SortKey[] = properties
    .map((p) => ({
      id: p.id,
      // Null postcodes sort last ("~" is after every alphanumeric).
      postcode: p.postcode ? p.postcode.replace(/\s+/g, "").toUpperCase() : "~",
      ...parseAddress(p.addressLine1),
    }))
    .sort(compareKeys);

  const n = sorted.length;
  const k = technicianIds.length;
  let i = 0;
  while (i < n) {
    const start = i;
    const { postcode, street } = sorted[start];
    while (i < n && sorted[i].postcode === postcode && sorted[i].street === street) i++;
    const chunk = Math.min(k - 1, Math.round((start * k) / n));
    for (let j = start; j < i; j++) result.set(sorted[j].id, technicianIds[chunk]);
  }
  return result;
}

// Technicians with a TechnicianAvailability window covering `date` (inclusive).
export async function technicianIdsUnavailableOn(tp: TenantDb, date: Date): Promise<Set<string>> {
  const rows = await tp.technicianAvailability.findMany({
    where: { from: { lte: date }, to: { gte: date } },
    select: { technicianId: true },
  });
  return new Set(rows.map((r) => r.technicianId));
}

// Re-resolve technicianId on the round's future SCHEDULED visits (date >=
// today) after its technicians or allocation changed. Visits a manager
// reassigned by hand (technicianOverride) are left alone. Returns how many
// visits actually changed technician.
export async function restampFutureVisits(tp: TenantDb, roundId: string, today: Date): Promise<number> {
  const from = startOfUtcDay(today);

  const [roundTechs, visits] = await Promise.all([
    tp.roundTechnician.findMany({ where: { roundId }, select: { technicianId: true } }),
    tp.visit.findMany({
      where: { roundId, status: VisitStatus.SCHEDULED, date: { gte: from }, technicianOverride: false },
      select: { id: true, date: true, technicianId: true, property: { select: { assignedTechnicianId: true } } },
    }),
  ]);
  if (visits.length === 0) return 0;

  const roundTechnicianIds = roundTechs.map((r) => r.technicianId);

  // One query for every window that could touch these visits, then match per
  // visit in memory — avoids a query per visit date.
  const windows = roundTechnicianIds.length
    ? await tp.technicianAvailability.findMany({
        where: { technicianId: { in: roundTechnicianIds }, to: { gte: from } },
        select: { technicianId: true, from: true, to: true },
      })
    : [];

  // Group by resolved technician so each target is one updateMany. Map keys
  // can be null (unassigned).
  const byTechnician = new Map<string | null, string[]>();
  for (const visit of visits) {
    const unavailableTechnicianIds = windows
      .filter((w) => w.from <= visit.date && w.to >= visit.date)
      .map((w) => w.technicianId);
    const resolved = resolveTechnicianForVisit({
      assignedTechnicianId: visit.property.assignedTechnicianId,
      roundTechnicianIds,
      unavailableTechnicianIds,
    });
    if (resolved === visit.technicianId) continue;
    const ids = byTechnician.get(resolved) ?? [];
    ids.push(visit.id);
    byTechnician.set(resolved, ids);
  }

  let updated = 0;
  for (const [technicianId, ids] of byTechnician) {
    const res = await tp.visit.updateMany({ where: { id: { in: ids } }, data: { technicianId } });
    updated += res.count;
  }
  return updated;
}
