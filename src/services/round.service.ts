import { CleaningFrequency, DayOfWeek, RoundStatus, VisitStatus, IssueType, Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

// ---------------------------------------------------------------------------
// M3 — Rounds (BE-M3-03).
//
// Same OCP seam as the other services: routes depend on IRoundService;
// methods are profileId-first for Phase 2 extensibility.
// ---------------------------------------------------------------------------

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

export interface OccurrenceSummary {
  date: string;          // "YYYY-MM-DD" (UTC)
  stopCount: number;
  totalValue: number;
  completedCount: number;
  completionPct: number; // 0–100, rounded
  holdCount: number;
  issueCount: number;
}

export interface PlannerStop {
  visitId: string;
  propertyId: string;
  propertyName: string | null;
  addressLine: string;
  postcode: string;
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

// ---- M4 output types (BE-M4-02, BE-M4-03, BE-M4-04) ----------------------

export interface TodayPanelStop {
  visitId: string;
  customerName: string | null;
  addressLine: string;
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
  fromTechnicianId: string;
  toTechnicianId: string;
  scope: "remaining" | "all";
  note?: string | null;
  notify: boolean;
}

export interface ReassignResult {
  updatedCount: number;
}

export interface PushMissedInput {
  newDate: Date;
  reason: string;
  technicianId?: string | null;
  notifyCustomers: boolean;
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

// ---- contract -------------------------------------------------------------

export interface IRoundService {
  listRounds(profileId: string, status?: RoundStatus): Promise<RoundSummary[]>;
  createRound(profileId: string, input: RoundCreateInput): Promise<RoundDetail>;
  getRound(profileId: string, roundId: string): Promise<RoundDetail>;
  updateRound(profileId: string, roundId: string, input: RoundUpdateInput): Promise<RoundDetail>;
  setTechnicians(profileId: string, roundId: string, technicianIds: string[]): Promise<RoundDetail>;
  listOccurrences(profileId: string, roundId: string, from?: Date, to?: Date): Promise<OccurrenceSummary[]>;
  getOccurrence(profileId: string, roundId: string, date: string): Promise<OccurrenceDetail>;
  // M4 additions
  getTodayPanel(profileId: string, roundId: string): Promise<TodayPanel>;
  reassignTechnician(profileId: string, roundId: string, input: ReassignInput): Promise<ReassignResult>;
  pushMissedJobs(profileId: string, roundId: string, input: PushMissedInput): Promise<PushMissedResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class RoundService implements IRoundService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  // ---- list ----

  async listRounds(_profileId: string, status?: RoundStatus): Promise<RoundSummary[]> {
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

  async createRound(_profileId: string, input: RoundCreateInput): Promise<RoundDetail> {
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

  async getRound(_profileId: string, roundId: string): Promise<RoundDetail> {
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

  // ---- update ----

  async updateRound(
    _profileId: string,
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

  // ---- set technicians (replace semantics) ----

  async setTechnicians(
    _profileId: string,
    roundId: string,
    technicianIds: string[]
  ): Promise<RoundDetail> {
    await this.assertRoundExists(roundId);

    const uniqueIds = [...new Set(technicianIds)];

    // Validate + replace inside one transaction to avoid TOCTOU (a technician
    // deactivated between pre-check and write would otherwise be silently assigned).
    const round = await this.prisma.$transaction(async (tx) => {
      if (uniqueIds.length > 0) {
        const found = await tx.technician.findMany({
          where: { id: { in: uniqueIds } },
          select: { id: true, active: true, profileId: true },
        });
        if (found.length !== uniqueIds.length) {
          throw new AppError(404, "One or more technicians not found");
        }
        const pending = found.filter((t) => t.profileId === null);
        if (pending.length > 0) {
          throw new AppError(
            400,
            `Cannot assign technician(s) with a pending invite: ${pending.map((t) => t.id).join(", ")}`
          );
        }
        const inactive = found.filter((t) => !t.active);
        if (inactive.length > 0) {
          throw new AppError(
            400,
            `Cannot assign inactive technician(s): ${inactive.map((t) => t.id).join(", ")}`
          );
        }
      }
      await tx.roundTechnician.deleteMany({ where: { roundId } });
      if (uniqueIds.length > 0) {
        await tx.roundTechnician.createMany({
          data: uniqueIds.map((technicianId) => ({ roundId, technicianId })),
        });
      }
      return tx.round.findUniqueOrThrow({
        where: { id: roundId },
        include: roundDetailInclude,
      });
    });

    return this.toDetail(round);
  }

  // ---- planner — occurrence list (calendar view) ----

  async listOccurrences(
    _profileId: string,
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
        date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
      },
      select: {
        date: true,
        status: true,
        paymentHold: true,
        price: true,
        _count: { select: { issues: true } },
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
      })
    );
  }

  // ---- planner — single occurrence (list/map view) ----

  async getOccurrence(
    _profileId: string,
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
      where: { roundId, date: { gte: dayStart, lt: dayEnd } },
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
    counts: { completedCount: number; totalValue: number; holdCount: number; issueCount: number }
  ): OccurrenceSummary {
    return {
      date,
      stopCount,
      ...counts,
      completionPct: stopCount > 0 ? Math.round((counts.completedCount / stopCount) * 100) : 0,
    };
  }

  private toSummary(stops: PlannerStop[]): Omit<OccurrenceSummary, "date"> {
    const { date: _d, ...rest } = this.aggregateStats("", stops.length, {
      completedCount: stops.filter((s) => s.status === VisitStatus.COMPLETED).length,
      totalValue: stops.reduce((acc, s) => acc + s.price, 0),
      holdCount: stops.filter((s) => s.paymentHold).length,
      issueCount: stops.reduce((acc, s) => acc + s.issues.length, 0),
    });
    return rest;
  }

  private async assertServiceAreaExists(id: string): Promise<void> {
    if (!(await this.prisma.serviceArea.findUnique({ where: { id } }))) {
      throw new AppError(404, `Service area not found: ${id}`);
    }
  }

  // ---- M4: today panel (Screen 13) ----------------------------------------

  async getTodayPanel(_profileId: string, roundId: string): Promise<TodayPanel> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      select: { id: true, name: true },
    });
    if (!round) throw new AppError(404, "Round not found");

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);

    const visits = await this.prisma.visit.findMany({
      where: { roundId, date: { gte: start, lt: end } },
      include: {
        property: { select: { addressLine: true, customer: { select: { name: true } } } },
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
        status: v.status,
        paymentHold: v.paymentHold,
        hasIssue: v.issues.length > 0,
        issueFlag: v.issues[0]?.note ?? null,
      })),
    };
  }

  // ---- M4: reassign technician (M15) ---------------------------------------

  async reassignTechnician(
    _profileId: string,
    roundId: string,
    input: ReassignInput
  ): Promise<ReassignResult> {
    if (input.fromTechnicianId === input.toTechnicianId) {
      throw new AppError(400, '"fromTechnicianId" and "toTechnicianId" must be different');
    }

    await this.assertRoundExists(roundId);

    // Validate the target technician is active and has accepted their invite
    const toTech = await this.prisma.technician.findUnique({
      where: { id: input.toTechnicianId },
      select: { id: true, active: true, profileId: true },
    });
    if (!toTech) throw new AppError(404, "Target technician not found");
    if (toTech.profileId === null) throw new AppError(400, "Target technician has not accepted their invite");
    if (!toTech.active) throw new AppError(400, "Target technician is inactive");

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);

    const statusFilter: VisitStatus[] =
      input.scope === "remaining"
        ? [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS]
        : [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS, VisitStatus.COMPLETED, VisitStatus.SKIPPED];

    const result = await this.prisma.visit.updateMany({
      where: {
        roundId,
        technicianId: input.fromTechnicianId,
        date: { gte: start, lt: end },
        status: { in: statusFilter },
      },
      data: { technicianId: input.toTechnicianId },
    });

    return { updatedCount: result.count };
  }

  // ---- M4: push missed jobs (M22) ------------------------------------------

  async pushMissedJobs(
    _profileId: string,
    roundId: string,
    input: PushMissedInput
  ): Promise<PushMissedResult> {
    await this.assertRoundExists(roundId);

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);

    // newDate must be strictly after today to avoid silent no-ops or past-date corruption.
    const newDateDay = new Date(input.newDate);
    newDateDay.setUTCHours(0, 0, 0, 0);
    if (newDateDay <= start) {
      throw new AppError(400, '"newDate" must be after today');
    }

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

    return { pushedCount: result.count };
  }
}

export function createRoundService(prisma: TenantPrismaClient): IRoundService {
  return new RoundService(prisma);
}
