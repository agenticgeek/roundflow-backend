import {
  ServiceCategory,
  DayOfWeek,
  CleaningFrequency,
  RoundStatus,
  VisitStatus,
  LifecycleStatus,
  PaymentTiming,
  PropertyType,
  PaymentMethod,
} from "../generated/tenant-client";
import type {
  BusinessSettings,
  Service,
  Technician,
  ServiceArea,
  Round,
  Customer,
  Property,
  ServicePlan,
  RoundTechnician,
} from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepStatus {
  step: number;
  complete: boolean;
  deferred: boolean;
}

export interface SetupStatus {
  setupCompleted: boolean;
  allRequiredComplete: boolean;
  steps: StepStatus[];
}

export interface BusinessProfileInput {
  businessName?: string | null;
  phone?: string | null;
  email?: string | null;
  companyNumber?: string | null;
  vatRegistered?: boolean;
  vatRegistration?: string | null;
  defaultWorkingDays?: string[];
  timezone?: string | null;
  currency?: string | null;
}

export interface RoundSettingsInput {
  defaultCycleLength?: number | null;
  defaultWorkingDays?: string[];
}

export interface PaymentSetupInput {
  paymentRule?: PaymentTiming | null;
  debtHoldEnabled?: boolean;
  vatInInvoices?: boolean;
  gocardlessConnected?: boolean;
  stripeConnected?: boolean;
}

export interface ServiceInput {
  name: string;
  category?: string;
  description?: string | null;
  defaultPrice: number;
  active?: boolean;
}

export interface TechnicianInput {
  name?: string | null; // admin display label — persisted to Technician.name
  role?: string | null;
  phone?: string | null;
  active?: boolean;
}

export interface ServiceAreaInput {
  name: string;
  postcodeSector?: string | null;
  isDefault?: boolean;
}

export interface FirstRoundInput {
  name: string;
  defaultDay?: string | null;
  frequency?: string | null;
  serviceAreaId?: string | null;
}

export interface SetupPropertyInput {
  customerName: string;
  propertyName?: string | null;
  phone?: string | null;
  email?: string | null;
  fullAddress: string;
  postcode: string;
  serviceAreaId: string;
  propertyType?: string | null;
  // Service plan
  price: number;
  cleaningFrequency?: string | null;
  paymentMethod?: string | null;
  serviceId?: string | null;
  // Notes
  accessNotes?: string | null;
  riskNotes?: string | null;
  // Round assignment — required during setup (property must be schedulable)
  roundId: string;
}

export interface RoundTechnicianAssignment {
  roundId: string;
  technicianIds: string[];
}

export interface ActivationInput {
  generateAll: boolean;
  startDate: string; // ISO date string
  cycleWeeks: number; // 1 | 2 | 3 | 4
  roundIds?: string[];
}

export interface SetupPropertyResult {
  customer: Customer;
  property: Property;
  servicePlan: ServicePlan;
}

export interface RoundAssignmentResult {
  roundId: string;
  roundName: string;
  defaultDay: string | null;
  serviceAreaName: string | null;
  propertyCount: number;
  technicianIds: string[];
  technicians: Array<{ id: string; name: string | null }>;
}

export interface WorkloadEntry {
  technicianId: string;
  name: string | null;
  roundCount: number;
}

export interface Step10Result {
  totalRounds: number;
  technicianCount: number;
  unassignedCount: number;
  assignments: RoundAssignmentResult[];
  workload: WorkloadEntry[];
}

export interface ActivationResult {
  visitsGenerated: number;
}

// The service contract. Routes depend on this abstraction, never on the
// concrete class — so Phase 2 (multi-tenancy) can bind a different
// implementation (e.g. one that scopes by tenant derived from profileId)
// without any route changes.
export interface ISetupService {
  getStatus(profileId: string): Promise<SetupStatus>;
  assertSetupIncomplete(profileId: string): Promise<void>;
  completeSetup(profileId: string): Promise<void>;

  saveBusinessProfile(
    profileId: string,
    input: BusinessProfileInput
  ): Promise<BusinessSettings>;

  // Reads the BusinessSettings singleton — backs GET /setup/step/1 and step/4
  // (Business Profile + Round Settings live on the same row). Stays open after
  // setup completes so the Settings screens can reuse it.
  getBusinessSettings(profileId: string): Promise<BusinessSettings | null>;

  getServices(profileId: string): Promise<Service[]>;
  saveServices(profileId: string, input: ServiceInput[]): Promise<Service[]>;

  saveRoundSettings(
    profileId: string,
    input: RoundSettingsInput
  ): Promise<BusinessSettings>;

  // Payment Setup (Setup step 2 — real, not a stub). Same BusinessSettings
  // singleton; connect toggles are Phase-1 stubs (booleans, no real OAuth).
  getPaymentSetup(profileId: string): Promise<BusinessSettings | null>;
  savePaymentSetup(
    profileId: string,
    input: PaymentSetupInput
  ): Promise<BusinessSettings>;

  getTechnicians(profileId: string): Promise<Technician[]>;
  saveTechnicians(
    profileId: string,
    input: TechnicianInput[]
  ): Promise<Technician[]>;

  getServiceAreas(profileId: string): Promise<ServiceArea[]>;
  saveServiceAreas(
    profileId: string,
    input: ServiceAreaInput[]
  ): Promise<ServiceArea[]>;

  getActiveRounds(profileId: string): Promise<Round[]>;
  saveFirstRound(profileId: string, input: FirstRoundInput): Promise<Round>;

  // Step 9: Add Property (one-time setup; does not reuse /customers or /properties)
  getSetupProperties(): Promise<SetupPropertyResult[]>;
  addSetupProperty(input: SetupPropertyInput): Promise<SetupPropertyResult>;

  // Step 10: Assign Technicians to Rounds
  getSetupRoundAssignments(): Promise<Step10Result>;
  assignTechniciansToRounds(
    assignments: RoundTechnicianAssignment[]
  ): Promise<Step10Result>;

  // Step 11: Activate System & Generate Visits
  getActivationStatus(): Promise<{ activated: boolean; visitsGenerated: number }>;
  activateSystem(input: ActivationInput): Promise<ActivationResult>;

  // Step 12: Review & Launch checklist (read-only; launch = POST /setup/complete)
  getReviewChecklist(): Promise<{
    checklist: Array<{ label: string; complete: boolean }>;
    allComplete: boolean;
  }>;
}


// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
//
// PHASE 2 TENANT SEAM — honest assessment:
//
// What the seam genuinely covers:
//   BusinessSettings — all access goes through getSettings()/writeSettings();
//   the singleton WHERE clause lives in exactly one place. Changing those two
//   methods to scope by tenant is a real one-place change.
//
// What the seam does NOT cover (Phase 2 will require):
//   - A tenant FK column on every operational table (Service, Technician,
//     ServiceArea, Round, Property, Visit, ServicePlan, Invoice, Payment,
//     Message, Complaint, Photo, ActivityLog) — a schema migration with backfill.
//   - ~30 unscoped query call sites in this service that will each need a
//     { where: { tenantId } } scope added.
//   - BusinessSettings.uniqueId @unique ("singleton") must become per-tenant.
//   - Invoice.invoiceNumber @unique is globally unique — must become unique
//     per tenant or tenants collide on invoice numbers.
//   - The actorId parameter (currently supabaseUserId) is the wrong grain for
//     Phase 2 — tenancy resolves from the GHL install/location, not the acting
//     user. A separate tenantId resolution step will be needed.
//
// Phase 2 is a whole-schema migration + ~30 query edits, not a two-method swap.
// The interface boundary and thin routes are correct and will not need changing.
class SetupService implements ISetupService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  private async getSettings(): Promise<BusinessSettings | null> {
    return this.prisma.businessSettings.findFirst();
  }

  async getStatus(_profileId: string): Promise<SetupStatus> {
    const [
      settings,
      serviceCount,
      technicianCount,
      serviceAreaCount,
      activeRoundCount,
      setupPropertyCount,
      visitCount,
    ] = await Promise.all([
      this.getSettings(),
      this.prisma.service.count(),
      this.prisma.technician.count(),
      this.prisma.serviceArea.count(),
      this.prisma.round.count({ where: { status: RoundStatus.ACTIVE } }),
      this.prisma.property.count({ where: { roundId: { not: null } } }),
      this.prisma.visit.count({ where: { status: VisitStatus.SCHEDULED } }),
    ]);

    // Step 10: all ACTIVE rounds must have ≥1 technician assigned.
    const activeRounds = await this.prisma.round.findMany({
      where: { status: RoundStatus.ACTIVE },
      include: { roundTechnicians: { select: { technicianId: true } } },
    });
    const allRoundsAssigned =
      activeRounds.length > 0 &&
      activeRounds.every((r) => r.roundTechnicians.length > 0);

    const step = (n: number, complete: boolean, deferred = false): StepStatus => ({
      step: n,
      complete,
      deferred,
    });

    const steps: StepStatus[] = [
      step(1, settings?.businessName != null),
      step(2, settings?.paymentRule != null),
      step(3, serviceCount > 0),
      step(4, settings?.defaultCycleLength != null),
      step(5, false, true), // SMS Templates — deferred
      step(6, technicianCount > 0),
      step(7, serviceAreaCount > 0),
      step(8, activeRoundCount > 0),
      step(9, setupPropertyCount > 0),
      step(10, allRoundsAssigned),
      step(11, visitCount > 0),
      // Step 12 (Review & Launch) is the final action — complete === setupCompleted
      step(12, settings?.setupCompleted ?? false),
    ];

    // Step 12 (Review & Launch) is the completion action itself — exclude it
    // from allRequiredComplete so POST /setup/complete doesn't deadlock on it.
    const allRequiredComplete = steps
      .filter((s) => !s.deferred && s.step < 12)
      .every((s) => s.complete);

    return {
      setupCompleted: settings?.setupCompleted ?? false,
      allRequiredComplete,
      steps,
    };
  }

  async assertSetupIncomplete(_profileId: string): Promise<void> {
    const settings = await this.getSettings();
    if (settings?.setupCompleted) {
      throw new AppError(
        403,
        "Setup is already complete; wizard endpoints are locked."
      );
    }
  }

  async completeSetup(profileId: string): Promise<void> {
    const status = await this.getStatus(profileId);
    if (status.setupCompleted) {
      throw new AppError(409, "Setup is already complete.");
    }
    if (!status.allRequiredComplete) {
      const missing = status.steps
        .filter((s) => !s.deferred && !s.complete)
        .map((s) => s.step);
      throw new AppError(
        400,
        `Setup cannot be completed — required steps incomplete: ${missing.join(", ")}`
      );
    }
    await this.prisma.businessSettings.upsert({
      where: { uniqueId: "singleton" },
      update: { setupCompleted: true },
      create: { setupCompleted: true },
    });
  }

  async saveBusinessProfile(
    _profileId: string,
    input: BusinessProfileInput
  ): Promise<BusinessSettings> {
    const data = {
      businessName: input.businessName,
      phone: input.phone,
      email: input.email,
      companyNumber: input.companyNumber,
      vatRegistered: input.vatRegistered,
      vatRegistration: input.vatRegistration,
      defaultWorkingDays: input.defaultWorkingDays,
      timezone: input.timezone,
      currency: input.currency,
    };
    return this.prisma.businessSettings.upsert({
      where: { uniqueId: "singleton" },
      update: data,
      create: { ...data },
    });
  }

  async getBusinessSettings(_profileId: string): Promise<BusinessSettings | null> {
    return this.getSettings();
  }

  async getServices(_profileId: string): Promise<Service[]> {
    return this.prisma.service.findMany({ orderBy: { createdAt: "asc" } });
  }

  async saveServices(
    _profileId: string,
    input: ServiceInput[]
  ): Promise<Service[]> {
    for (const s of input) {
      if (
        s.category &&
        !(Object.values(ServiceCategory) as string[]).includes(s.category)
      ) {
        throw new AppError(400, `Invalid service category: ${s.category}`);
      }
    }
    // "create/replace" the whole catalogue. Safe during setup: no ServicePlan
    // or Visit references the catalogue yet (guarded by assertSetupIncomplete).
    return this.prisma.$transaction(async (tx) => {
      await tx.service.deleteMany({});
      if (input.length > 0) {
        await tx.service.createMany({
          data: input.map((s) => ({
            name: s.name,
            category: (s.category as ServiceCategory) ?? ServiceCategory.DEFAULT,
            description: s.description ?? null,
            defaultPrice: s.defaultPrice,
            active: s.active ?? true,
          })),
        });
      }
      return tx.service.findMany({ orderBy: { createdAt: "asc" } });
    });
  }

  async saveRoundSettings(
    _profileId: string,
    input: RoundSettingsInput
  ): Promise<BusinessSettings> {
    const data = {
      defaultCycleLength: input.defaultCycleLength,
      defaultWorkingDays: input.defaultWorkingDays,
    };
    return this.prisma.businessSettings.upsert({
      where: { uniqueId: "singleton" },
      update: data,
      create: { ...data },
    });
  }

  async getPaymentSetup(_profileId: string): Promise<BusinessSettings | null> {
    return this.getSettings();
  }

  async savePaymentSetup(
    _profileId: string,
    input: PaymentSetupInput
  ): Promise<BusinessSettings> {
    // Same singleton upsert as saveBusinessProfile. Connect toggles
    // (gocardless/stripe) are Phase-1 stubs — booleans only, no real OAuth.
    const data = {
      paymentRule: input.paymentRule,
      debtHoldEnabled: input.debtHoldEnabled,
      vatInInvoices: input.vatInInvoices,
      gocardlessConnected: input.gocardlessConnected,
      stripeConnected: input.stripeConnected,
    };
    return this.prisma.businessSettings.upsert({
      where: { uniqueId: "singleton" },
      update: data,
      create: { ...data },
    });
  }

  async getTechnicians(_profileId: string): Promise<Technician[]> {
    return this.prisma.technician.findMany({ orderBy: { createdAt: "asc" } });
  }

  async saveTechnicians(
    _profileId: string,
    input: TechnicianInput[]
  ): Promise<Technician[]> {
    // Replace semantics — re-posting step 6 must not append duplicates. Delete
    // only the invite-pending technicians (profileId = null); technicians who
    // have accepted an invite (real profileId) are never touched. Then recreate
    // from the input. Each created technician is invite-pending (profileId = null;
    // name/email arrive when the invite is accepted).
    return this.prisma.$transaction(async (tx) => {
      await tx.technician.deleteMany({ where: { profileId: null } });
      if (input.length > 0) {
        await tx.technician.createMany({
          data: input.map((t) => ({
            profileId: null,
            name: t.name ?? null,
            role: t.role ?? null,
            phone: t.phone ?? null,
            active: t.active ?? true,
          })),
        });
      }
      return tx.technician.findMany({ orderBy: { createdAt: "asc" } });
    });
  }

  async getServiceAreas(_profileId: string): Promise<ServiceArea[]> {
    return this.prisma.serviceArea.findMany({ orderBy: { createdAt: "asc" } });
  }

  async saveServiceAreas(
    _profileId: string,
    input: ServiceAreaInput[]
  ): Promise<ServiceArea[]> {
    // At most one area may be flagged default. Reject before any DB write.
    if (input.filter((a) => a.isDefault === true).length > 1) {
      throw new AppError(400, "Only one service area can be marked as default.");
    }
    // Replace the whole set — re-posting step 7 must not append duplicates.
    // Safe within the wizard: Rounds/Properties that reference ServiceArea are
    // created after step 7, and only once setup is complete —
    // assertSetupIncomplete blocks this POST after completion, so no live FK
    // reference to a deleted area can exist here.
    return this.prisma.$transaction(async (tx) => {
      await tx.serviceArea.deleteMany({});
      if (input.length > 0) {
        await tx.serviceArea.createMany({
          data: input.map((a) => ({
            name: a.name,
            postcodeSector: a.postcodeSector ?? null,
            isDefault: a.isDefault ?? false,
          })),
        });
      }
      return tx.serviceArea.findMany({ orderBy: { createdAt: "asc" } });
    });
  }

  async getActiveRounds(_profileId: string): Promise<Round[]> {
    return this.prisma.round.findMany({
      where: { status: RoundStatus.ACTIVE },
      orderBy: { createdAt: "asc" },
    });
  }

  async saveFirstRound(
    _profileId: string,
    input: FirstRoundInput
  ): Promise<Round> {
    if (
      input.defaultDay &&
      !(Object.values(DayOfWeek) as string[]).includes(input.defaultDay)
    ) {
      throw new AppError(400, `Invalid defaultDay: ${input.defaultDay}`);
    }
    if (
      input.frequency &&
      !(Object.values(CleaningFrequency) as string[]).includes(input.frequency)
    ) {
      throw new AppError(400, `Invalid frequency: ${input.frequency}`);
    }
    if (input.serviceAreaId) {
      const area = await this.prisma.serviceArea.findUnique({
        where: { id: input.serviceAreaId },
      });
      if (!area) {
        throw new AppError(400, `serviceAreaId not found: ${input.serviceAreaId}`);
      }
    }

    const data = {
      name: input.name,
      defaultDay: (input.defaultDay as DayOfWeek) ?? null,
      frequency: (input.frequency as CleaningFrequency) ?? null,
      serviceAreaId: input.serviceAreaId ?? null,
    };

    // Upsert the single setup round — re-posting step 8 must update the existing
    // ACTIVE round, not create a second. If an ACTIVE round exists, update it;
    // otherwise create it (the first round → ACTIVE).
    const existing = await this.prisma.round.findFirst({
      where: { status: RoundStatus.ACTIVE },
      orderBy: { createdAt: "asc" },
    });
    if (existing) {
      return this.prisma.round.update({ where: { id: existing.id }, data });
    }
    return this.prisma.round.create({
      data: { ...data, status: RoundStatus.ACTIVE },
    });
  }

  // ── Step 9: Add Property ────────────────────────────────────────────────

  async getSetupProperties(): Promise<SetupPropertyResult[]> {
    const properties = await this.prisma.property.findMany({
      include: {
        customer: true,
        servicePlans: {
          where: { status: LifecycleStatus.ACTIVE },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return properties.map((p) => ({
      customer: p.customer,
      property: p,
      servicePlan: p.servicePlans[0],
    })).filter((r) => r.servicePlan != null) as SetupPropertyResult[];
  }

  async addSetupProperty(input: SetupPropertyInput): Promise<SetupPropertyResult> {
    if (
      input.propertyType &&
      !(Object.values(PropertyType) as string[]).includes(input.propertyType)
    ) {
      throw new AppError(400, `Invalid propertyType: ${input.propertyType}`);
    }
    if (
      input.cleaningFrequency &&
      !(Object.values(CleaningFrequency) as string[]).includes(input.cleaningFrequency)
    ) {
      throw new AppError(400, `Invalid cleaningFrequency: ${input.cleaningFrequency}`);
    }
    if (
      input.paymentMethod &&
      !(Object.values(PaymentMethod) as string[]).includes(input.paymentMethod)
    ) {
      throw new AppError(400, `Invalid paymentMethod: ${input.paymentMethod}`);
    }
    const area = await this.prisma.serviceArea.findUnique({
      where: { id: input.serviceAreaId },
    });
    if (!area) throw new AppError(400, `serviceAreaId not found: ${input.serviceAreaId}`);
    if (input.roundId) {
      // M-1: Require ACTIVE status — a DRAFT round never appears in step 10's
      // ACTIVE-round query, so properties assigned to it would be orphaned from
      // technician coverage checks.
      const round = await this.prisma.round.findUnique({ where: { id: input.roundId } });
      if (!round) throw new AppError(400, `roundId not found: ${input.roundId}`);
      if (round.status !== RoundStatus.ACTIVE) {
        throw new AppError(400, "roundId must reference an ACTIVE round");
      }
    }
    if (input.price < 0) throw new AppError(400, "price must be >= 0");

    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          name: input.customerName,
          phone: input.phone ?? null,
          email: input.email ?? null,
          paymentMethod: (input.paymentMethod as PaymentMethod) ?? null,
        },
      });
      const property = await tx.property.create({
        data: {
          customerId: customer.id,
          propertyName: input.propertyName ?? null,
          addressLine: input.fullAddress,
          postcode: input.postcode,
          serviceAreaId: input.serviceAreaId,
          propertyType: (input.propertyType as PropertyType) ?? null,
          accessNotes: input.accessNotes ?? null,
          riskNotes: input.riskNotes ?? null,
          roundId: input.roundId,
        },
      });
      const servicePlan = await tx.servicePlan.create({
        data: {
          propertyId: property.id,
          serviceId: input.serviceId ?? null,
          price: input.price,
          paymentMethod: (input.paymentMethod as PaymentMethod) ?? null,
          cleaningFrequency: (input.cleaningFrequency as CleaningFrequency) ?? null,
        },
      });
      return { customer, property, servicePlan };
    });
  }

  // ── Step 10: Assign Technicians to Rounds ───────────────────────────────

  private async buildStep10Result(): Promise<Step10Result> {
    const [rounds, technicians] = await Promise.all([
      this.prisma.round.findMany({
        where: { status: RoundStatus.ACTIVE },
        include: {
          serviceArea: { select: { name: true } },
          _count: { select: { properties: true } },
          roundTechnicians: {
            include: { technician: { select: { id: true, name: true } } },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.technician.findMany({
        where: { active: true },
        include: { roundTechnicians: { select: { roundId: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const assignments: RoundAssignmentResult[] = rounds.map((r) => ({
      roundId: r.id,
      roundName: r.name,
      defaultDay: r.defaultDay,
      serviceAreaName: r.serviceArea?.name ?? null,
      propertyCount: r._count.properties,
      technicianIds: r.roundTechnicians.map((rt) => rt.technicianId),
      technicians: r.roundTechnicians.map((rt) => rt.technician),
    }));

    const workload: WorkloadEntry[] = technicians.map((t) => ({
      technicianId: t.id,
      name: t.name,
      roundCount: t.roundTechnicians.length,
    }));

    const unassignedCount = rounds.filter((r) => r.roundTechnicians.length === 0).length;

    return {
      totalRounds: rounds.length,
      technicianCount: technicians.length,
      unassignedCount,
      assignments,
      workload,
    };
  }

  async getSetupRoundAssignments(): Promise<Step10Result> {
    return this.buildStep10Result();
  }

  async assignTechniciansToRounds(
    assignments: RoundTechnicianAssignment[]
  ): Promise<Step10Result> {
    // H-2: Reject duplicate roundIds up front — a second entry for the same round
    // would deleteMany the technicians just written by the first, silently losing data.
    const seenRoundIds = new Set<string>();
    for (const a of assignments) {
      if (seenRoundIds.has(a.roundId)) {
        throw new AppError(400, `Duplicate roundId in assignments: ${a.roundId}`);
      }
      seenRoundIds.add(a.roundId);
    }

    // Validate all round and technician IDs up front.
    const allRoundIds = assignments.map((a) => a.roundId);
    const allTechIds = assignments.flatMap((a) => a.technicianIds);
    const [roundHits, techHits] = await Promise.all([
      this.prisma.round.findMany({
        where: { id: { in: allRoundIds }, status: RoundStatus.ACTIVE },
        select: { id: true },
      }),
      allTechIds.length > 0
        ? this.prisma.technician.findMany({
            // M-2: Only allow active technicians to be assigned.
            where: { id: { in: allTechIds }, active: true },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);
    const validRoundIds = new Set(roundHits.map((r) => r.id));
    const validTechIds = new Set(techHits.map((t) => t.id));
    for (const a of assignments) {
      if (!validRoundIds.has(a.roundId)) {
        throw new AppError(400, `roundId not found or not an ACTIVE round: ${a.roundId}`);
      }
      for (const tid of a.technicianIds) {
        if (!validTechIds.has(tid)) {
          throw new AppError(400, `technicianId not found or inactive: ${tid}`);
        }
      }
    }

    // Replace assignments for each supplied round (idempotent).
    await this.prisma.$transaction(async (tx) => {
      for (const a of assignments) {
        // H-3: Deduplicate technicianIds to avoid P2002 on the composite PK.
        const uniqueTechIds = [...new Set(a.technicianIds)];
        await tx.roundTechnician.deleteMany({ where: { roundId: a.roundId } });
        if (uniqueTechIds.length > 0) {
          await tx.roundTechnician.createMany({
            data: uniqueTechIds.map((tid) => ({
              roundId: a.roundId,
              technicianId: tid,
            })),
          });
        }
      }
    });

    return this.buildStep10Result();
  }

  // ── Step 11: Activate System & Generate Visits ──────────────────────────

  async getActivationStatus(): Promise<{ activated: boolean; visitsGenerated: number }> {
    const count = await this.prisma.visit.count({
      where: { status: VisitStatus.SCHEDULED },
    });
    return { activated: count > 0, visitsGenerated: count };
  }

  async activateSystem(input: ActivationInput): Promise<ActivationResult> {
    if (input.cycleWeeks < 1 || input.cycleWeeks > 52 || !Number.isInteger(input.cycleWeeks)) {
      throw new AppError(400, "cycleWeeks must be an integer between 1 and 52");
    }

    // H-1: Use setupCompleted as the canonical activation guard, not visit.count().
    // An unrelated visit (e.g. created during testing) must not permanently block activation.
    const settings = await this.getSettings();
    if (settings?.setupCompleted) {
      throw new AppError(409, "System is already activated — setup is complete");
    }

    const startDate = new Date(input.startDate);
    if (Number.isNaN(startDate.getTime())) {
      throw new AppError(400, "startDate must be a valid ISO date string");
    }
    // M-3: Reject past start dates — they generate immediately-overdue visits.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (startDate < today) {
      throw new AppError(400, "startDate must be today or in the future");
    }
    const cycleEndDate = new Date(startDate);
    cycleEndDate.setDate(cycleEndDate.getDate() + input.cycleWeeks * 7);

    if (!input.generateAll && (!input.roundIds || input.roundIds.length === 0)) {
      throw new AppError(400, "roundIds is required when generateAll is false");
    }

    const roundWhere = input.generateAll
      ? { status: RoundStatus.ACTIVE }
      : { status: RoundStatus.ACTIVE, id: { in: input.roundIds ?? [] } };

    const rounds = await this.prisma.round.findMany({
      where: roundWhere,
      include: {
        properties: {
          where: { status: LifecycleStatus.ACTIVE, roundId: { not: null } },
          include: {
            servicePlans: {
              where: { status: LifecycleStatus.ACTIVE },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    });

    // M-4: When targeting specific rounds, fail early if none matched.
    if (!input.generateAll && rounds.length === 0) {
      throw new AppError(404, "None of the specified roundIds were found");
    }

    const visitData: Array<{
      date: Date;
      status: VisitStatus;
      price: typeof rounds[0]["properties"][0]["servicePlans"][0]["price"];
      propertyId: string;
      roundId: string;
      servicePlanId: string;
      paymentMethod: PaymentMethod | null;
    }> = [];

    for (const round of rounds) {
      for (const property of round.properties) {
        const plan = property.servicePlans[0];
        if (!plan) continue;

        const firstDate = round.defaultDay
          ? nextOccurrenceOfDay(startDate, round.defaultDay as DayOfWeek)
          : new Date(startDate);

        const freqWeeks = plan.cleaningFrequency
          ? frequencyToWeeks(plan.cleaningFrequency as CleaningFrequency)
          : null;

        let visitDate = new Date(firstDate);
        while (visitDate <= cycleEndDate) {
          visitData.push({
            date: new Date(visitDate),
            status: VisitStatus.SCHEDULED,
            price: plan.price,
            propertyId: property.id,
            roundId: round.id,
            servicePlanId: plan.id,
            paymentMethod: plan.paymentMethod,
          });
          if (!freqWeeks) break;
          visitDate = new Date(visitDate);
          visitDate.setDate(visitDate.getDate() + freqWeeks * 7);
        }
      }
    }

    if (visitData.length > 0) {
      await this.prisma.visit.createMany({ data: visitData });
    }

    return { visitsGenerated: visitData.length };
  }

  // ── Step 12: Review & Launch checklist ─────────────────────────────────

  async getReviewChecklist(): Promise<{
    checklist: Array<{ label: string; complete: boolean }>;
    allComplete: boolean;
  }> {
    const status = await this.getStatus("");
    const checklist = [
      { label: "Business profile completed", complete: status.steps[0].complete },
      { label: "Payment setup configured", complete: status.steps[1].complete },
      { label: "Service catalogue created", complete: status.steps[2].complete },
      { label: "Round settings saved", complete: status.steps[3].complete },
      { label: "Technicians added", complete: status.steps[5].complete },
      { label: "Service areas created", complete: status.steps[6].complete },
      { label: "Rounds configured", complete: status.steps[7].complete },
      { label: "Properties added", complete: status.steps[8].complete },
      { label: "Technicians assigned to rounds", complete: status.steps[9].complete },
      { label: "Visits generated", complete: status.steps[10].complete },
    ];
    const allComplete = checklist.every((c) => c.complete);
    return { checklist, allComplete };
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────────

function nextOccurrenceOfDay(from: Date, day: DayOfWeek): Date {
  const dayIndex: Record<DayOfWeek, number> = {
    SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
  };
  const target = dayIndex[day];
  const current = from.getDay();
  const daysUntil = (target - current + 7) % 7;
  const result = new Date(from);
  result.setDate(from.getDate() + daysUntil);
  return result;
}

function frequencyToWeeks(freq: CleaningFrequency): number {
  switch (freq) {
    case CleaningFrequency.FORTNIGHTLY:   return 2;
    case CleaningFrequency.FOUR_WEEKLY:   return 4;
    case CleaningFrequency.SIX_WEEKLY:    return 6;
    case CleaningFrequency.EIGHT_WEEKLY:  return 8;
    // L-2: MONTHLY is approximated as 4 weeks (28 days). This generates 13
    // visits/year instead of 12. Use calendar-month arithmetic if exact billing
    // cycles are required in a future milestone.
    case CleaningFrequency.MONTHLY:       return 4;
  }
}

export function createSetupService(prisma: TenantPrismaClient): ISetupService {
  return new SetupService(prisma);
}
