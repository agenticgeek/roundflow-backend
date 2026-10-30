import { CleaningFrequency, DayOfWeek, LifecycleStatus, RoundStatus, VisitStatus, IssueType, Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { getCachedBusinessSettings } from "./settings.service";
import { todayRange } from "../lib/dates";
import { createMessageService } from "./message.service";
import { generateForRound } from "../jobs/visitGeneration";
import { autoSplit, resolveTechnicianForVisit, restampFutureVisits } from "./visit-assignment";
import { startOfUtcDay } from "../lib/schedule";

// ---- input types ----------------------------------------------------------

export interface RoundCreateInput {
  name: string;
  frequency: CleaningFrequency;
  serviceAreaId: string;
  defaultDay?: DayOfWeek | null;
  description?: string | null;
}

export interface RoundUpdateInput {
  name?: string;
  frequency?: CleaningFrequency | null; // null = clear frequency
  serviceAreaId?: string | null; // null = unassign service area
  defaultDay?: DayOfWeek | null;
  description?: string | null;
  status?: RoundStatus;
}

// ---- output types ---------------------------------------------------------

export interface RoundSummary {
  id: string;
  name: string;
  frequency: CleaningFrequency | null;
  defaultDay: DayOfWeek | null;
  status: RoundStatus;
  serviceAreaId: string | null;
  serviceAreaName: string | null;
  technicianCount: number;
  propertyCount: number;
}

export interface TechnicianRef {
  id: string;
  name: string | null;
  active: boolean;
}

export interface RoundDetail {
  id: string;
  name: string;
  frequency: CleaningFrequency | null;
  defaultDay: DayOfWeek | null;
  description: string | null;
  status: RoundStatus;
  serviceAreaId: string | null;
  serviceAreaName: string | null;
  technicians: TechnicianRef[];
  propertyCount: number;
}

// ---- planner output types -------------------------------------------------

export interface OccurrenceTechnicianRef {
  id: string;
  name: string | null;
}

export interface OccurrenceSummary {
  date: string;          // "YYYY-MM-DD" (UTC)
  stopCount: number;
  totalValue: number;
  completedCount: number;
  completionPct: number; // 0–100, rounded
  holdCount: number;
  issueCount: number;
  // Every distinct technician with at least one stop on this date, deduped by id.
  technicians: OccurrenceTechnicianRef[];
}

export interface PlannerStop {
  visitId: string;
  propertyId: string;
  propertyName: string | null;
  addressLine: string;
  postcode: string;
  latitude: number | null;
  longitude: number | null;
  customerName: string;
  price: number;
  status: VisitStatus;
  paymentHold: boolean;
  technicianId: string | null;
  technicianName: string | null;
  issues: { id: string; type: IssueType; note: string | null }[];
  completedAt: string | null;
}

export interface OccurrenceDetail {
  roundId: string;
  roundName: string;
  date: string;
  stops: PlannerStop[];
  summary: Omit<OccurrenceSummary, "date">;
}

export interface DayStopsForRound {
  roundId: string;
  stops: PlannerStop[];
}

export interface GenerateVisitsResult {
  visitsGenerated: number;
}

// ---- M4 output types (BE-M4-02, BE-M4-03, BE-M4-04) ----------------------

export interface TodayPanelStop {
  visitId: string;
  customerName: string | null;
  addressLine: string;
  latitude: number | null;
  longitude: number | null;
  status: VisitStatus;
  paymentHold: boolean;
  hasIssue: boolean;
  issueFlag: string | null; // first issue note; null when no note text or no issues
}

export interface TodayPanel {
  roundId: string;
  roundName: string;
  technicianId: string | null;
  technicianName: string | null;
  status: "not_started" | "in_progress" | "completed";
  progress: { total: number; completed: number; skipped: number; issues: number };
  stops: TodayPanelStop[];
}

export interface ReassignInput {
  date?: Date;                     // visit date to reassign; defaults to today
  fromTechnicianId: string | null; // null = the date's unassigned visits
  toTechnicianId: string;
  scope: "REMAINING" | "ALL";
  permanent?: boolean;             // also move the properties' allocation
  note?: string | null;
  notify: boolean;
}

export interface ReassignResult {
  updated: number;
}

// ---- A1 technician split / allocation (GAP-012) ---------------------------

export type SplitMode = "SINGLE" | "AUTO" | "MANUAL";

export interface SplitInput {
  mode: SplitMode;
  allocations?: { propertyId: string; technicianId: string }[]; // MANUAL only
}

export interface AllocationEntry {
  technicianId: string;
  name: string | null;
  propertyIds: string[];
  stops: number;
  value: string; // sum of the properties' ACTIVE plan prices, "37.00"
}

export interface SetTechniciansResult {
  roundId: string;
  allocation: AllocationEntry[];
  visitsUpdated: number;
}

export interface RoundAllocation {
  mode: SplitMode;
  allocation: AllocationEntry[];
}

// 400 INVALID_ALLOCATION with a per-property reason map; the central error
// handler forwards `fields` in the body.
export class AllocationError extends AppError {
  constructor(public readonly fields: Record<string, string>) {
    super(400, "Invalid technician allocation", "INVALID_ALLOCATION");
  }
}

// Thrown at the end of a dry-run transaction so every write rolls back while
// the caller still gets the exact result (incl. visitsUpdated).
class DryRunRollback extends Error {
  constructor(public readonly result: SetTechniciansResult) {
    super("dry run");
  }
}

export interface PushMissedInput {
  newDate: Date;
  reason: string;
  technicianId?: string | null;
  notifyCustomers: boolean;
  message?: string | null;
}

export interface PushMissedResult {
  pushedCount: number;
}

// ---- Prisma payload types -------------------------------------------------

const visitDetailInclude = {
  property: { include: { customer: true } },
  technician: true,
  issues: { select: { id: true, type: true, note: true } },
} satisfies Prisma.VisitInclude;

type VisitWithDetails = Prisma.VisitGetPayload<{ include: typeof visitDetailInclude }>;

const roundDetailInclude = {
  serviceArea: true,
  roundTechnicians: { include: { technician: true } },
  _count: { select: { properties: true } },
} satisfies Prisma.RoundInclude;

type RoundWithRelations = Prisma.RoundGetPayload<{ include: typeof roundDetailInclude }>;

const allocationPropertySelect = {
  id: true,
  postcode: true,
  addressLine: true,
  assignedTechnicianId: true,
  servicePlans: { where: { status: LifecycleStatus.ACTIVE }, select: { price: true } },
} satisfies Prisma.PropertySelect;

type AllocationProperty = Prisma.PropertyGetPayload<{ select: typeof allocationPropertySelect }>;

// Planner/today readers never show visits cancelled by a pause or round move (A4).
const NOT_CANCELLED = { not: VisitStatus.CANCELLED };

// autoSplit labels chunks in technicianIds order; sorting makes the split
// independent of request order, so GET /allocation can recognise it as AUTO.
function autoAssign(properties: AllocationProperty[], technicianIds: string[]): Map<string, string> {
  return autoSplit(
    properties.map((p) => ({ id: p.id, postcode: p.postcode, addressLine1: p.addressLine })),
    [...technicianIds].sort()
  );
}

function buildAllocation(
  technicians: { id: string; name: string | null }[],
  properties: AllocationProperty[],
  assignment: Map<string, string | null>
): AllocationEntry[] {
  return technicians.map((t) => {
    const mine = properties.filter((p) => assignment.get(p.id) === t.id);
    const value = mine
      .flatMap((p) => p.servicePlans)
      .reduce((acc, sp) => acc.add(sp.price), new Prisma.Decimal(0));
    return {
      technicianId: t.id,
      name: t.name,
      propertyIds: mine.map((p) => p.id),
      stops: mine.length,
      value: value.toFixed(2),
    };
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class RoundService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  // ---- list ----

  async listRounds(status?: RoundStatus): Promise<RoundSummary[]> {
    const rounds = await this.prisma.round.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "asc" },
      include: {
        serviceArea: true,
        _count: { select: { roundTechnicians: true, properties: true } },
      },
    });

    return rounds.map((r) => ({
      id: r.id,
      name: r.name,
      frequency: r.frequency,
      defaultDay: r.defaultDay,
      status: r.status,
      serviceAreaId: r.serviceAreaId,
      serviceAreaName: r.serviceArea?.name ?? null,
      technicianCount: r._count.roundTechnicians,
      propertyCount: r._count.properties,
    }));
  }

  // ---- create ----

  async createRound(input: RoundCreateInput): Promise<RoundDetail> {
    await this.assertServiceAreaExists(input.serviceAreaId);

    const round = await this.prisma.round.create({
      data: {
        name: input.name,
        frequency: input.frequency,
        serviceAreaId: input.serviceAreaId,
        defaultDay: input.defaultDay ?? null,
        description: input.description ?? null,
        status: RoundStatus.ACTIVE,
      },
      include: roundDetailInclude,
    });

    return this.toDetail(round);
  }

  // ---- read ----

  async getRound(roundId: string): Promise<RoundDetail> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      include: roundDetailInclude,
    });
    if (!round) throw new AppError(404, "Round not found");
    return this.toDetail(round);
  }

  private async assertRoundExists(roundId: string): Promise<void> {
    const r = await this.prisma.round.findUnique({ where: { id: roundId }, select: { id: true } });
    if (!r) throw new AppError(404, "Round not found");
  }

  // The operational day is closed once BusinessSettings.lastClosedDate equals
  // today's UTC date string (see today.service.ts closeDay()). Reassign and
  // Push Missed must not silently mutate visits after Close Day has run.
  private async assertDayNotClosed(): Promise<void> {
    const settings = await getCachedBusinessSettings(this.prisma);
    const today = todayRange().start.toISOString().slice(0, 10);
    if (settings?.lastClosedDate === today) {
      throw new AppError(409, "Operational day has already been closed");
    }
  }

  // ---- update ----

  async updateRound(
    roundId: string,
    input: RoundUpdateInput
  ): Promise<RoundDetail> {
    await this.assertRoundExists(roundId);
    if (input.serviceAreaId) await this.assertServiceAreaExists(input.serviceAreaId);

    const round = await this.prisma.round.update({
      where: { id: roundId },
      data: {
        name: input.name,
        frequency: input.frequency,
        serviceAreaId: input.serviceAreaId,
        defaultDay: input.defaultDay,
        description: input.description,
        status: input.status,
      },
      include: roundDetailInclude,
    });

    return this.toDetail(round);
  }

  // ---- set technicians (replace semantics) + property split (A1) ----
  // Writes RoundTechnician, every round property's assignedTechnicianId and
  // restamps future visits in one transaction. `split` omitted = SINGLE for
  // one technician, AUTO for two or more. dryRun runs the whole transaction
  // and rolls it back, so the preview is exactly what a save would do.

  async setTechnicians(
    roundId: string,
    technicianIds: string[],
    split?: SplitInput,
    options: { dryRun?: boolean } = {}
  ): Promise<SetTechniciansResult> {
    await this.assertRoundExists(roundId);

    const uniqueIds = [...new Set(technicianIds)];
    const mode: SplitMode = split?.mode ?? (uniqueIds.length >= 2 ? "AUTO" : "SINGLE");
    if (split?.mode === "SINGLE" && uniqueIds.length !== 1) {
      throw new AppError(400, 'Split mode "SINGLE" requires exactly one technician');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Validate inside the transaction to avoid TOCTOU (a technician
        // deactivated between pre-check and write would otherwise be assigned).
        const found = uniqueIds.length > 0
          ? await tx.technician.findMany({
              where: { id: { in: uniqueIds } },
              select: { id: true, name: true, active: true, profileId: true },
            })
          : [];
        if (found.length !== uniqueIds.length) {
          throw new AppError(404, "One or more technicians not found");
        }
        const pending = found.filter((t) => t.profileId === null);
        if (pending.length > 0) {
          throw new AppError(
            400,
            `Cannot assign technician(s) with a pending invite: ${pending.map((t) => t.name ?? t.id).join(", ")}`
          );
        }
        const inactive = found.filter((t) => !t.active);
        if (inactive.length > 0) {
          throw new AppError(
            400,
            `Cannot assign inactive technician(s): ${inactive.map((t) => t.id).join(", ")}`
          );
        }

        const properties = await tx.property.findMany({
          where: { roundId },
          select: allocationPropertySelect,
          orderBy: { addressLine: "asc" },
        });
        const assignment = this.assignProperties(mode, properties, uniqueIds, split?.allocations ?? []);

        await tx.roundTechnician.deleteMany({ where: { roundId } });
        if (uniqueIds.length > 0) {
          await tx.roundTechnician.createMany({
            data: uniqueIds.map((technicianId) => ({ roundId, technicianId })),
          });
        }
        // One updateMany per target technician (null = unassigned).
        const byTechnician = new Map<string | null, string[]>();
        for (const [propertyId, technicianId] of assignment) {
          byTechnician.set(technicianId, [...(byTechnician.get(technicianId) ?? []), propertyId]);
        }
        for (const [technicianId, ids] of byTechnician) {
          await tx.property.updateMany({ where: { id: { in: ids } }, data: { assignedTechnicianId: technicianId } });
        }
        const visitsUpdated = await restampFutureVisits(tx, roundId, new Date());

        const byId = new Map(found.map((t) => [t.id, t]));
        const result: SetTechniciansResult = {
          roundId,
          allocation: buildAllocation(
            uniqueIds.map((id) => ({ id, name: byId.get(id)!.name })),
            properties,
            assignment
          ),
          visitsUpdated,
        };
        if (options.dryRun) throw new DryRunRollback(result);
        return result;
      });
    } catch (err) {
      if (err instanceof DryRunRollback) return err.result;
      throw err;
    }
  }

  // propertyId → technicianId (null = unassigned) for every round property.
  private assignProperties(
    mode: SplitMode,
    properties: AllocationProperty[],
    technicianIds: string[],
    allocations: { propertyId: string; technicianId: string }[]
  ): Map<string, string | null> {
    const assignment = new Map<string, string | null>(properties.map((p) => [p.id, null]));

    if (mode === "MANUAL") {
      // Properties left out of `allocations` stay unassigned.
      const fields: Record<string, string> = {};
      const seen = new Set<string>();
      for (const a of allocations) {
        if (!assignment.has(a.propertyId)) fields[a.propertyId] = "Property not in round";
        else if (seen.has(a.propertyId)) fields[a.propertyId] = "Property allocated more than once";
        else if (!technicianIds.includes(a.technicianId)) fields[a.propertyId] = "Technician not in technicianIds";
        seen.add(a.propertyId);
      }
      if (Object.keys(fields).length > 0) throw new AllocationError(fields);
      for (const a of allocations) assignment.set(a.propertyId, a.technicianId);
    } else if (mode === "AUTO") {
      for (const [propertyId, technicianId] of autoAssign(properties, technicianIds)) {
        assignment.set(propertyId, technicianId);
      }
    } else if (technicianIds.length === 1) {
      for (const p of properties) assignment.set(p.id, technicianIds[0]);
    }
    return assignment;
  }

  // ---- current allocation (A1, split screen) ----
  // Effective allocation as visits would be stamped (property assignment if
  // still on the round, else the sole technician). Mode is SINGLE for 0–1
  // technicians, AUTO when the allocation matches the auto split, else MANUAL.

  async getAllocation(roundId: string): Promise<RoundAllocation> {
    await this.assertRoundExists(roundId);

    const [roundTechs, properties] = await Promise.all([
      this.prisma.roundTechnician.findMany({
        where: { roundId },
        select: { technician: { select: { id: true, name: true } } },
        orderBy: { assignedAt: "asc" },
      }),
      this.prisma.property.findMany({
        where: { roundId },
        select: allocationPropertySelect,
        orderBy: { addressLine: "asc" },
      }),
    ]);
    const technicians = roundTechs.map((rt) => rt.technician);
    const ids = technicians.map((t) => t.id);

    const assignment = new Map(
      properties.map((p) => [
        p.id,
        resolveTechnicianForVisit({ assignedTechnicianId: p.assignedTechnicianId, roundTechnicianIds: ids }),
      ])
    );

    let mode: SplitMode = "SINGLE";
    if (ids.length >= 2) {
      const auto = autoAssign(properties, ids);
      mode = properties.every((p) => auto.get(p.id) === assignment.get(p.id)) ? "AUTO" : "MANUAL";
    }

    return { mode, allocation: buildAllocation(technicians, properties, assignment) };
  }

  // ---- planner — occurrence list (calendar view) ----

  async listOccurrences(
    roundId: string,
    from?: Date,
    to?: Date
  ): Promise<OccurrenceSummary[]> {
    await this.assertRoundExists(roundId);

    if (from && to && from > to) {
      throw new AppError(400, '"from" must be before "to"');
    }
    // Cap to 90 days to prevent unbounded full-table scans.
    const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
    if (from && to && to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new AppError(400, "Date range must not exceed 90 days");
    }
    // Require at least one bound so callers can't scan all visits.
    if (!from && !to) {
      throw new AppError(400, "At least one of \"from\" or \"to\" is required");
    }

    const visits = await this.prisma.visit.findMany({
      where: {
        roundId,
        status: NOT_CANCELLED,
        date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
      },
      select: {
        date: true,
        status: true,
        paymentHold: true,
        price: true,
        _count: { select: { issues: true } },
        technician: { select: { id: true, name: true } },
      },
      orderBy: { date: "asc" },
    });

    // Group visits by UTC date string
    const byDate = new Map<string, typeof visits>();
    for (const v of visits) {
      const key = v.date.toISOString().slice(0, 10);
      let bucket = byDate.get(key);
      if (!bucket) {
        bucket = [];
        byDate.set(key, bucket);
      }
      bucket.push(v);
    }

    return Array.from(byDate.entries()).map(([date, vs]) =>
      this.aggregateStats(date, vs.length, {
        completedCount: vs.filter((v) => v.status === VisitStatus.COMPLETED).length,
        totalValue: vs.reduce((acc, v) => acc + v.price.toNumber(), 0),
        holdCount: vs.filter((v) => v.paymentHold).length,
        issueCount: vs.reduce((acc, v) => acc + v._count.issues, 0),
        technicians: this.dedupeTechnicians(vs, (v) => v.technician),
      })
    );
  }

  // ---- planner — batched occurrence list across multiple rounds ----
  // Batch call: unlike listOccurrences(), does NOT 404 on a missing/unknown
  // roundId — a round with no matching visits simply gets an empty array,
  // so callers can pass IDs from a stale list without the whole call failing.

  async listOccurrencesForRounds(
    roundIds: string[],
    from?: Date,
    to?: Date
  ): Promise<{ roundId: string; occurrences: OccurrenceSummary[] }[]> {
    if (from && to && from > to) {
      throw new AppError(400, '"from" must be before "to"');
    }
    // Cap to 90 days to prevent unbounded full-table scans.
    const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
    if (from && to && to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new AppError(400, "Date range must not exceed 90 days");
    }
    // Require at least one bound so callers can't scan all visits.
    if (!from && !to) {
      throw new AppError(400, "At least one of \"from\" or \"to\" is required");
    }

    const visits = await this.prisma.visit.findMany({
      where: {
        roundId: { in: roundIds },
        status: NOT_CANCELLED,
        date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
      },
      select: {
        roundId: true,
        date: true,
        status: true,
        paymentHold: true,
        price: true,
        _count: { select: { issues: true } },
        technician: { select: { id: true, name: true } },
      },
      orderBy: { date: "asc" },
    });

    // Group visits by roundId, then by UTC date string within each round.
    const byRound = new Map<string, Map<string, typeof visits>>();
    for (const v of visits) {
      // where.roundId: { in: roundIds } guarantees this is one of the
      // (non-null) requested IDs; the field is nullable in the schema so TS
      // still sees string | null here.
      if (v.roundId === null) continue;
      let byDate = byRound.get(v.roundId);
      if (!byDate) {
        byDate = new Map();
        byRound.set(v.roundId, byDate);
      }
      const key = v.date.toISOString().slice(0, 10);
      let bucket = byDate.get(key);
      if (!bucket) {
        bucket = [];
        byDate.set(key, bucket);
      }
      bucket.push(v);
    }

    return roundIds.map((roundId) => {
      const byDate = byRound.get(roundId);
      const occurrences = byDate
        ? Array.from(byDate.entries()).map(([date, vs]) =>
            this.aggregateStats(date, vs.length, {
              completedCount: vs.filter((v) => v.status === VisitStatus.COMPLETED).length,
              totalValue: vs.reduce((acc, v) => acc + v.price.toNumber(), 0),
              holdCount: vs.filter((v) => v.paymentHold).length,
              issueCount: vs.reduce((acc, v) => acc + v._count.issues, 0),
              technicians: this.dedupeTechnicians(vs, (v) => v.technician),
            })
          )
        : [];
      return { roundId, occurrences };
    });
  }

  // ---- planner — single occurrence (list/map view) ----

  async getOccurrence(
    roundId: string,
    date: string
  ): Promise<OccurrenceDetail> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      select: { id: true, name: true },
    });
    if (!round) throw new AppError(404, "Round not found");

    const dayStart = new Date(`${date}T00:00:00.000Z`);
    if (isNaN(dayStart.getTime())) {
      throw new AppError(400, '"date" is not a valid calendar date');
    }
    const dayEnd = new Date(dayStart.getTime() + 86_400_000); // exclusive: next midnight

    const visits = await this.prisma.visit.findMany({
      where: { roundId, status: NOT_CANCELLED, date: { gte: dayStart, lt: dayEnd } },
      include: visitDetailInclude,
      orderBy: { property: { addressLine: "asc" } },
    });

    const stops = visits.map((v) => this.toStop(v));
    return {
      roundId: round.id,
      roundName: round.name,
      date,
      stops,
      summary: this.toSummary(stops),
    };
  }

  // ---- planner — batched day stops across multiple rounds (list/map view) ----
  // Batch call: like listOccurrencesForRounds(), does NOT 404 on an unknown
  // roundId — it just gets an empty stops array, so a stale round list
  // doesn't fail the whole request.

  async listDayStopsForRounds(
    roundIds: string[],
    date: string
  ): Promise<DayStopsForRound[]> {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    if (isNaN(dayStart.getTime())) {
      throw new AppError(400, '"date" is not a valid calendar date');
    }
    const dayEnd = new Date(dayStart.getTime() + 86_400_000); // exclusive: next midnight

    const visits = await this.prisma.visit.findMany({
      where: { roundId: { in: roundIds }, status: NOT_CANCELLED, date: { gte: dayStart, lt: dayEnd } },
      include: visitDetailInclude,
      orderBy: { property: { addressLine: "asc" } },
    });

    const byRound = new Map<string, VisitWithDetails[]>();
    for (const v of visits) {
      if (v.roundId === null) continue;
      const bucket = byRound.get(v.roundId) ?? [];
      bucket.push(v);
      byRound.set(v.roundId, bucket);
    }

    return roundIds.map((roundId) => ({
      roundId,
      stops: (byRound.get(roundId) ?? []).map((v) => this.toStop(v)),
    }));
  }

  // ---- on-demand visit generation ----
  // Rounds created after setup otherwise wait for the next nightly
  // runVisitGeneration() cron run before they have any visits — this runs
  // the same per-round generation logic immediately, for just this round.

  async generateVisitsNow(roundId: string): Promise<GenerateVisitsResult> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      select: { id: true, frequency: true, defaultDay: true, status: true },
    });
    if (!round) throw new AppError(404, "Round not found");
    if (round.status !== RoundStatus.ACTIVE) {
      throw new AppError(400, "Round must be ACTIVE to generate visits");
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const visitsGenerated = await generateForRound(this.prisma, round, today);
    return { visitsGenerated };
  }

  // ---- shared helpers ----

  private toDetail(round: RoundWithRelations): RoundDetail {
    return {
      id: round.id,
      name: round.name,
      frequency: round.frequency,
      defaultDay: round.defaultDay,
      description: round.description,
      status: round.status,
      serviceAreaId: round.serviceAreaId,
      serviceAreaName: round.serviceArea?.name ?? null,
      technicians: round.roundTechnicians.map((rt) => ({
        id: rt.technician.id,
        name: rt.technician.name ?? null,
        active: rt.technician.active,
      })),
      propertyCount: round._count.properties,
    };
  }

  private toStop(v: VisitWithDetails): PlannerStop {
    return {
      visitId: v.id,
      propertyId: v.propertyId,
      propertyName: v.property.propertyName,
      addressLine: v.property.addressLine,
      postcode: v.property.postcode,
      latitude: v.property.latitude,
      longitude: v.property.longitude,
      customerName: v.property.customer?.name ?? null,
      price: v.price.toNumber(),
      status: v.status,
      paymentHold: v.paymentHold,
      technicianId: v.technicianId,
      technicianName: v.technician?.name ?? null,
      issues: v.issues,
      completedAt: v.completedAt?.toISOString() ?? null,
    };
  }

  private aggregateStats(
    date: string,
    stopCount: number,
    counts: {
      completedCount: number;
      totalValue: number;
      holdCount: number;
      issueCount: number;
      technicians: OccurrenceTechnicianRef[];
    }
  ): OccurrenceSummary {
    return {
      date,
      stopCount,
      ...counts,
      completionPct: stopCount > 0 ? Math.round((counts.completedCount / stopCount) * 100) : 0,
    };
  }

  // Dedupe technician refs by id, preserving first-seen order. `ref` extracts
  // the (possibly null — unassigned stop) technician reference from each item.
  private dedupeTechnicians<T>(
    items: T[],
    ref: (item: T) => OccurrenceTechnicianRef | null
  ): OccurrenceTechnicianRef[] {
    const map = new Map<string, OccurrenceTechnicianRef>();
    for (const item of items) {
      const t = ref(item);
      if (t) map.set(t.id, t);
    }
    return [...map.values()];
  }

  private toSummary(stops: PlannerStop[]): Omit<OccurrenceSummary, "date"> {
    const { date: _d, ...rest } = this.aggregateStats("", stops.length, {
      completedCount: stops.filter((s) => s.status === VisitStatus.COMPLETED).length,
      totalValue: stops.reduce((acc, s) => acc + s.price, 0),
      holdCount: stops.filter((s) => s.paymentHold).length,
      issueCount: stops.reduce((acc, s) => acc + s.issues.length, 0),
      technicians: this.dedupeTechnicians(stops, (s) =>
        s.technicianId ? { id: s.technicianId, name: s.technicianName } : null
      ),
    });
    return rest;
  }

  private async assertServiceAreaExists(id: string): Promise<void> {
    if (!(await this.prisma.serviceArea.findUnique({ where: { id } }))) {
      throw new AppError(404, `Service area not found: ${id}`);
    }
  }

  // ---- M4: today panel (Screen 13) ----------------------------------------

  async getTodayPanel(roundId: string): Promise<TodayPanel> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      select: { id: true, name: true },
    });
    if (!round) throw new AppError(404, "Round not found");

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);

    const visits = await this.prisma.visit.findMany({
      where: { roundId, status: NOT_CANCELLED, date: { gte: start, lt: end } },
      include: {
        property: {
          select: { addressLine: true, latitude: true, longitude: true, customer: { select: { name: true } } },
        },
        technician: { select: { id: true, name: true } },
        issues: { select: { id: true, note: true }, take: 1 },
      },
      orderBy: { property: { addressLine: "asc" } },
    });

    // Primary technician: prefer IN_PROGRESS, then SCHEDULED, then any
    const primaryVisit =
      visits.find((v) => v.status === VisitStatus.IN_PROGRESS) ??
      visits.find((v) => v.status === VisitStatus.SCHEDULED) ??
      visits[0] ??
      null;

    const completed = visits.filter((v) => v.status === VisitStatus.COMPLETED).length;
    const skipped = visits.filter((v) => v.status === VisitStatus.SKIPPED).length;
    const inProgress = visits.filter((v) => v.status === VisitStatus.IN_PROGRESS).length;

    let panelStatus: "not_started" | "in_progress" | "completed";
    if (visits.length === 0 || (completed === 0 && skipped === 0 && inProgress === 0)) {
      panelStatus = "not_started";
    } else if (completed + skipped === visits.length) {
      panelStatus = "completed";
    } else {
      panelStatus = "in_progress";
    }

    return {
      roundId: round.id,
      roundName: round.name,
      technicianId: primaryVisit?.technicianId ?? null,
      technicianName: primaryVisit?.technician?.name ?? null,
      status: panelStatus,
      progress: {
        total: visits.length,
        completed,
        skipped,
        issues: visits.filter((v) => v.issues.length > 0).length,
      },
      stops: visits.map((v) => ({
        visitId: v.id,
        customerName: v.property.customer?.name ?? null,
        addressLine: v.property.addressLine,
        latitude: v.property.latitude,
        longitude: v.property.longitude,
        status: v.status,
        paymentHold: v.paymentHold,
        hasIssue: v.issues.length > 0,
        issueFlag: v.issues[0]?.note ?? null,
      })),
    };
  }

  // ---- M4: reassign technician (M15, GAP-013) ------------------------------
  // Moves one date's visits from a technician (or from nobody, when
  // fromTechnicianId is null) to another. A one-off reassign marks the visits
  // technicianOverride so restamping leaves them alone; `permanent` instead
  // moves the properties' allocation (adding the target to the round) and
  // restamps the round's future visits to match.

  async reassignTechnician(
    roundId: string,
    input: ReassignInput
  ): Promise<ReassignResult> {
    if (input.fromTechnicianId === input.toTechnicianId) {
      throw new AppError(400, '"fromTechnicianId" and "toTechnicianId" must be different');
    }

    await this.assertRoundExists(roundId);

    const today = startOfUtcDay(new Date());
    const start = startOfUtcDay(input.date ?? today);
    if (start < today) throw new AppError(400, '"date" must be today or later');
    if (start.getTime() === today.getTime()) await this.assertDayNotClosed();
    const end = new Date(start.getTime() + 86_400_000);

    // Validate the target technician is active and has accepted their invite
    const toTech = await this.prisma.technician.findUnique({
      where: { id: input.toTechnicianId },
      select: { id: true, active: true, profileId: true },
    });
    if (!toTech) throw new AppError(404, "Target technician not found");
    if (toTech.profileId === null) throw new AppError(400, "Target technician has not accepted their invite");
    if (!toTech.active) throw new AppError(400, "Target technician is inactive");

    const statusFilter: VisitStatus[] =
      input.scope === "REMAINING"
        ? [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS]
        : [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS, VisitStatus.COMPLETED, VisitStatus.SKIPPED];
    const where: Prisma.VisitWhereInput = {
      roundId,
      technicianId: input.fromTechnicianId,
      date: { gte: start, lt: end },
      status: { in: statusFilter },
    };
    const toTechnicianId = input.toTechnicianId;

    if (!input.permanent) {
      const result = await this.prisma.visit.updateMany({
        where,
        data: { technicianId: toTechnicianId, technicianOverride: true },
      });
      return { updated: result.count };
    }

    return this.prisma.$transaction(async (tx) => {
      const visits = await tx.visit.findMany({ where, select: { id: true, propertyId: true } });
      const propertyIds = [...new Set(visits.map((v) => v.propertyId))];

      await tx.roundTechnician.createMany({ data: [{ roundId, technicianId: toTechnicianId }], skipDuplicates: true });
      await tx.property.updateMany({ where: { id: { in: propertyIds } }, data: { assignedTechnicianId: toTechnicianId } });
      const moved = await tx.visit.updateMany({
        where: { id: { in: visits.map((v) => v.id) } },
        data: { technicianId: toTechnicianId, technicianOverride: false },
      });
      const restamped = await restampFutureVisits(tx, roundId, today);
      return { updated: moved.count + restamped };
    });
  }

  // ---- M4: push missed jobs (M22) ------------------------------------------

  async pushMissedJobs(
    roundId: string,
    input: PushMissedInput
  ): Promise<PushMissedResult> {
    await this.assertRoundExists(roundId);
    await this.assertDayNotClosed();

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);

    // newDate must be strictly after today to avoid silent no-ops or past-date corruption.
    const newDateDay = new Date(input.newDate);
    newDateDay.setUTCHours(0, 0, 0, 0);
    if (newDateDay <= start) {
      throw new AppError(400, '"newDate" must be after today');
    }

    // Resolve affected customers BEFORE the update, while the SCHEDULED/today
    // filter still identifies exactly the visits about to be pushed.
    const affected = input.notifyCustomers
      ? await this.prisma.visit.findMany({
          where: { roundId, date: { gte: start, lt: end }, status: VisitStatus.SCHEDULED },
          select: { property: { select: { customerId: true } } },
        })
      : [];

    const result = await this.prisma.visit.updateMany({
      where: {
        roundId,
        date: { gte: start, lt: end },
        status: VisitStatus.SCHEDULED,
      },
      data: {
        date: input.newDate,
        ...(input.technicianId !== undefined ? { technicianId: input.technicianId } : {}),
      },
    });

    if (input.notifyCustomers && affected.length > 0) {
      const customerIds = [...new Set(affected.map((v) => v.property.customerId))];
      const body =
        input.message?.trim() ||
        `Your clean has been rescheduled. Reason: ${input.reason}`;
      const messageService = createMessageService(this.prisma);
      for (const customerId of customerIds) {
        try {
          await messageService.send({ customerId, channel: "sms", body });
        } catch (err) {
          console.error(`[rounds] push-missed notify failed for customer ${customerId}:`, err);
        }
      }
    }

    return { pushedCount: result.count };
  }
}

export function createRoundService(prisma: TenantPrismaClient) {
  return new RoundService(prisma);
}
