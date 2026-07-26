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
  frequency?: CleaningFrequency;
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

  // ---- update ----

  async updateRound(
    _profileId: string,
    roundId: string,
    input: RoundUpdateInput
  ): Promise<RoundDetail> {
    if (!(await this.prisma.round.findUnique({ where: { id: roundId } }))) {
      throw new AppError(404, "Round not found");
    }
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
    if (!(await this.prisma.round.findUnique({ where: { id: roundId } }))) {
      throw new AppError(404, "Round not found");
    }

    const uniqueIds = [...new Set(technicianIds)];

    if (uniqueIds.length > 0) {
      const found = await this.prisma.technician.findMany({
        where: { id: { in: uniqueIds } },
      });
      if (found.length !== uniqueIds.length) {
        throw new AppError(404, "One or more technicians not found");
      }
      const inactive = found.filter((t) => !t.active);
      if (inactive.length > 0) {
        throw new AppError(
          400,
          `Cannot assign inactive technician(s): ${inactive.map((t) => t.id).join(", ")}`
        );
      }
    }

    const round = await this.prisma.$transaction(async (tx) => {
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
    if (!(await this.prisma.round.findUnique({ where: { id: roundId }, select: { id: true } }))) {
      throw new AppError(404, "Round not found");
    }

    const visits = await this.prisma.visit.findMany({
      where: {
        roundId,
        ...(from || to
          ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
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

    return Array.from(byDate.entries()).map(([date, vs]) => {
      const completedCount = vs.filter((v) => v.status === VisitStatus.COMPLETED).length;
      const totalValue = vs.reduce((acc, v) => acc + v.price.toNumber(), 0);
      const holdCount = vs.filter((v) => v.paymentHold).length;
      const issueCount = vs.reduce((acc, v) => acc + v._count.issues, 0);
      return {
        date,
        stopCount: vs.length,
        totalValue,
        completedCount,
        completionPct: vs.length > 0 ? Math.round((completedCount / vs.length) * 100) : 0,
        holdCount,
        issueCount,
      };
    });
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
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

    const visits = await this.prisma.visit.findMany({
      where: { roundId, date: { gte: dayStart, lte: dayEnd } },
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
      customerName: v.property.customer.name,
      price: v.price.toNumber(),
      status: v.status,
      paymentHold: v.paymentHold,
      technicianId: v.technicianId,
      technicianName: v.technician?.name ?? null,
      issues: v.issues,
      completedAt: v.completedAt?.toISOString() ?? null,
    };
  }

  private toSummary(stops: PlannerStop[]): Omit<OccurrenceSummary, "date"> {
    const completedCount = stops.filter((s) => s.status === VisitStatus.COMPLETED).length;
    const totalValue = stops.reduce((acc, s) => acc + s.price, 0);
    const holdCount = stops.filter((s) => s.paymentHold).length;
    const issueCount = stops.reduce((acc, s) => acc + s.issues.length, 0);
    return {
      stopCount: stops.length,
      totalValue,
      completedCount,
      completionPct: stops.length > 0 ? Math.round((completedCount / stops.length) * 100) : 0,
      holdCount,
      issueCount,
    };
  }

  private async assertServiceAreaExists(id: string): Promise<void> {
    if (!(await this.prisma.serviceArea.findUnique({ where: { id } }))) {
      throw new AppError(404, `Service area not found: ${id}`);
    }
  }
}

export function createRoundService(prisma: TenantPrismaClient): IRoundService {
  return new RoundService(prisma);
}
