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
  ReminderMode,
  CleanMethod,
  NoDirectDebitAction,
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
} from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { Prisma as TenantPrisma } from "../generated/tenant-client";
import { AppError } from "../lib/app-error";
import { randomUUID } from "crypto";
import { addWeeks, initialNextDueDate, nextOccurrenceOfDay, startOfUtcDay } from "../lib/schedule";
import { CustomerIndex } from "../lib/customer-match";
import { rowError, type RowError } from "../lib/row-error";
import { buildActivationPlan, loadActivationInputs } from "./activation-plan";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepStatus {
  step: number;
  complete: boolean;
  deferred: boolean;
}

export interface WizardStepStatus {
  key: string;
  step: number;
  complete: boolean;
}

export interface SetupStatus {
  setupCompleted: boolean;
  allRequiredComplete: boolean;
  steps: StepStatus[];
  // GAP-002: the web's 10-step wizard, in its display order (keys match
  // roundflow-frontend/src/content/setup-wizard.ts `steps[].id`).
  wizardSteps: WizardStepStatus[];
}

export const WIZARD_STEPS: ReadonlyArray<{ key: string; step: number }> = [
  { key: "business-profile", step: 1 },
  { key: "service-area", step: 7 },
  { key: "round-settings", step: 4 },
  { key: "first-round", step: 8 },
  { key: "service-catalogue", step: 3 },
  { key: "technician-management", step: 6 },
  { key: "payment-setup", step: 2 },
  { key: "sms-templates", step: 5 },
  { key: "add-property", step: 9 },
  { key: "generate-visits", step: 11 },
];

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
  bankDetails?: { accountName: string; bankName?: string | null; accountNumber: string; sortCode: string } | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  town?: string | null;
  postcode?: string | null;
  vatRate?: number;
}

export interface RoundSettingsInput {
  defaultCycleLength?: number | null;
  defaultWorkingDays?: string[];
  reminderMode?: ReminderMode;
  reminderTime?: string;
  defaultCleanMethod?: CleanMethod | null;
  autoCreateNextVisit?: boolean;
}

// Connection flags (gocardlessConnected / stripeConnected) are no longer
// accepted here (A6) — they only change through the real connect flows.
export interface PaymentSetupInput {
  paymentRule?: PaymentTiming | null;
  debtHoldEnabled?: boolean;
  vatInInvoices?: boolean;
  defaultPaymentMethod?: PaymentMethod | null;
  invoiceDueDays?: number;
  noDirectDebitAction?: NoDirectDebitAction;
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
  email?: string | null;
  active?: boolean;
  serviceAreaIds?: string[];
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
  landline?: string | null;
  email?: string | null;
  fullAddress: string;
  postcode: string;
  serviceAreaId: string;
  propertyType?: string | null;
  // Service plan: `price` is the combined/total price across whichever
  // service(s) this row represents.
  price: number;
  cleaningFrequency?: string | null;
  paymentMethod?: string | null;
  serviceId?: string | null;
  // When given (non-empty), one ServicePlan is created per id instead of a
  // single plan for `serviceId`, splitting `price` evenly across them
  // (remainder pence assigned to the last plan so the total stays exact).
  serviceIds?: string[] | null;
  // Notes
  accessNotes?: string | null;
  riskNotes?: string | null;
  // Round assignment — required during setup (property must be schedulable)
  roundId: string;
  // GAP-010: attach to this existing customer. Without it, an existing
  // customer with the same mobile or email is reused.
  customerId?: string | null;
  // A2: ISO date of the last clean, used to place the first nextDueDate.
  lastCleanedDate?: string | null;
}

export interface RoundTechnicianAssignment {
  roundId: string;
  technicianIds: string[];
}

export interface ActivationWindowInput {
  startDate: string; // ISO date string
  cycleWeeks: number;
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
  // Kept for backward compatibility with existing callers: the first/only
  // plan. Equal to servicePlans[0].
  servicePlan: ServicePlan;
  // Every plan created for this property — length > 1 only when the row
  // supplied serviceIds with more than one entry.
  servicePlans: ServicePlan[];
  // true when the property was attached to an existing customer (explicit
  // customerId, or matched by mobile/email) instead of creating a new one.
  customerMatched: boolean;
}

export type SetupPropertyRowError = RowError;

export interface ActivationPreview {
  rounds: Array<{ roundId: string; name: string; firstVisit: string | null; visits: number }>;
  total: number;
}

export interface BulkSetupPropertyResult {
  created: number;
  failed: number;
  results: SetupPropertyResult[];
  errors: SetupPropertyRowError[];
  // true when this exact idempotencyKey was already processed by an earlier
  // call — `results` is empty in that case (not reconstructed), but
  // `created` reflects the original run's count.
  idempotent?: boolean;
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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
//
// Tenancy is schema-per-tenant (each signup provisions its own `t_<hex>`
// schema), so every query here is already tenant-scoped by the client it runs
// on. BusinessSettings is a singleton within that schema.

// Splits `total` across `count` plans, each rounded to 2dp; the last plan
// absorbs the rounding remainder so the parts always sum back to `total`.
function splitPrice(total: number, index: number, count: number): number {
  if (count <= 1) return total;
  const base = Math.floor((total / count) * 100) / 100;
  if (index < count - 1) return base;
  return Math.round((total - base * (count - 1)) * 100) / 100;
}

// One row's service-plan entries: a single plan for `serviceId` by default,
// or one plan per id in `serviceIds` (splitting `price` evenly) when given.
function servicePlanEntries(
  input: Pick<SetupPropertyInput, "serviceId" | "serviceIds" | "price">
): { serviceId: string | null; price: number }[] {
  if (input.serviceIds && input.serviceIds.length > 0) {
    const ids = input.serviceIds;
    return ids.map((serviceId, index) => ({
      serviceId,
      price: splitPrice(input.price, index, ids.length),
    }));
  }
  return [{ serviceId: input.serviceId ?? null, price: input.price }];
}

// A2 / X-2: a plan's first nextDueDate. With a frequency (the plan's own, or
// the round's) and a lastCleanedDate: one cycle after it, on the round day;
// otherwise the round's next defaultDay on or after today (today when the
// round has no day).
function planNextDueDate(input: {
  frequency: CleaningFrequency | null;
  defaultDay: DayOfWeek | null;
  lastCleanedDate: Date | null;
  today: Date;
}): Date {
  if (input.frequency) {
    return initialNextDueDate({
      lastCleanedDate: input.lastCleanedDate,
      frequency: input.frequency,
      roundDefaultDay: input.defaultDay,
      today: input.today,
    });
  }
  return input.defaultDay ? nextOccurrenceOfDay(input.today, input.defaultDay) : startOfUtcDay(input.today);
}

// Parses an optional ISO lastCleanedDate; returns undefined when invalid.
function parseLastCleaned(v: string | null | undefined): Date | null | undefined {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

class SetupService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  // Memoized for the lifetime of this request-scoped instance (one
  // SetupService is created per request via createSetupService — see
  // routes/setup.ts). Avoids re-fetching the singleton when a step handler
  // calls assertSetupIncomplete() and then reads/writes settings again.
  // Writes go through upsertSettings(), which refreshes this cache from the
  // upsert's own return value rather than invalidating it, so no extra read
  // is needed within the same request.
  private settingsCache: BusinessSettings | null | undefined = undefined;

  private async getSettings(): Promise<BusinessSettings | null> {
    if (this.settingsCache !== undefined) return this.settingsCache;
    this.settingsCache = await this.prisma.businessSettings.findFirst();
    return this.settingsCache;
  }

  private async upsertSettings(
    data: TenantPrisma.BusinessSettingsUpsertArgs["create"]
  ): Promise<BusinessSettings> {
    const result = await this.prisma.businessSettings.upsert({
      where: { uniqueId: "singleton" },
      update: data,
      create: { ...data },
    });
    this.settingsCache = result;
    return result;
  }

  // GAP-002: steps are complete once saved, not when matching rows exist
  // (seeded services/templates used to tick steps on their own).
  private async completedStepsWith(step: number): Promise<number[]> {
    const current = (await this.getSettings())?.completedSteps ?? [];
    return current.includes(step) ? current : [...current, step].sort((a, b) => a - b);
  }

  async markStepComplete(step: number): Promise<void> {
    const current = (await this.getSettings())?.completedSteps ?? [];
    if (current.includes(step)) return;
    await this.upsertSettings({ completedSteps: await this.completedStepsWith(step) });
  }

  async getStatus(): Promise<SetupStatus> {
    const [settings, activeRounds] = await Promise.all([
      this.getSettings(),
      // Step 10: also complete when all ACTIVE rounds have ≥1 technician
      // (technicians are now assigned from the Round Planner after setup).
      this.prisma.round.findMany({
        where: { status: RoundStatus.ACTIVE },
        include: { roundTechnicians: { select: { technicianId: true } } },
      }),
    ]);

    const done = new Set(settings?.completedSteps ?? []);
    const allRoundsAssigned =
      activeRounds.length > 0 &&
      activeRounds.every((r) => r.roundTechnicians.length > 0);

    const step = (n: number, complete: boolean, deferred = false): StepStatus => ({
      step: n,
      complete,
      deferred,
    });

    const steps: StepStatus[] = [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => step(n, done.has(n))),
      // Deferred: tenants can go live without technicians assigned to rounds.
      // `complete` still reflects reality so the wizard can show progress.
      step(10, done.has(10) || allRoundsAssigned, true),
      step(11, done.has(11)),
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
      wizardSteps: WIZARD_STEPS.map((w) => ({ key: w.key, step: w.step, complete: done.has(w.step) })),
    };
  }

  async assertSetupIncomplete(): Promise<void> {
    const settings = await this.getSettings();
    if (settings?.setupCompleted) {
      throw new AppError(
        403,
        "Setup is already complete; wizard endpoints are locked."
      );
    }
  }

  async completeSetup(): Promise<void> {
    const status = await this.getStatus();
    if (status.setupCompleted) {
      throw new AppError(409, "Setup is already complete.");
    }
    if (!status.allRequiredComplete) {
      // Step 12 (Review & Launch) is this very action — it can never be
      // "complete" beforehand, so it's excluded from allRequiredComplete
      // above. Apply the same exclusion here, otherwise it always shows up
      // in the error message alongside any genuinely missing step, even
      // though the wizard UI never numbers it as a step the user can act on.
      const missing = status.steps
        .filter((s) => !s.deferred && !s.complete && s.step < 12)
        .map((s) => s.step);
      throw new AppError(
        400,
        `Setup cannot be completed — required steps incomplete: ${missing.join(", ")}`
      );
    }
    await this.upsertSettings({ setupCompleted: true });
  }

  async saveBusinessProfile(
    input: BusinessProfileInput
  ): Promise<BusinessSettings> {
    const bankDetails =
      input.bankDetails === undefined
        ? undefined
        : input.bankDetails === null
        ? TenantPrisma.JsonNull
        : (input.bankDetails as unknown as TenantPrisma.InputJsonValue);
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
      bankDetails,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      town: input.town,
      postcode: input.postcode,
      vatRate: input.vatRate,
      completedSteps: await this.completedStepsWith(1),
    };
    return this.upsertSettings(data);
  }

  async getBusinessSettings(): Promise<BusinessSettings | null> {
    return this.getSettings();
  }

  async getServices(): Promise<Service[]> {
    return this.prisma.service.findMany({ orderBy: { createdAt: "asc" } });
  }

  async saveServices(
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
    const services = await this.prisma.$transaction(async (tx) => {
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
    await this.markStepComplete(3);
    return services;
  }

  async saveRoundSettings(
    input: RoundSettingsInput
  ): Promise<BusinessSettings> {
    const data = {
      defaultCycleLength: input.defaultCycleLength,
      defaultWorkingDays: input.defaultWorkingDays,
      reminderMode: input.reminderMode,
      reminderTime: input.reminderTime,
      defaultCleanMethod: input.defaultCleanMethod,
      autoCreateNextVisit: input.autoCreateNextVisit,
      completedSteps: await this.completedStepsWith(4),
    };
    return this.upsertSettings(data);
  }

  async getPaymentSetup(): Promise<BusinessSettings | null> {
    return this.getSettings();
  }

  async savePaymentSetup(
    input: PaymentSetupInput
  ): Promise<BusinessSettings> {
    // Same singleton upsert as saveBusinessProfile. Rules and defaults only:
    // the gocardless/stripe connection flags change only through the real
    // connect flows (A6).
    const data = {
      paymentRule: input.paymentRule,
      debtHoldEnabled: input.debtHoldEnabled,
      vatInInvoices: input.vatInInvoices,
      defaultPaymentMethod: input.defaultPaymentMethod,
      invoiceDueDays: input.invoiceDueDays,
      noDirectDebitAction: input.noDirectDebitAction,
      completedSteps: await this.completedStepsWith(2),
    };
    return this.upsertSettings(data);
  }

  async getTechnicians(): Promise<Technician[]> {
    return this.prisma.technician.findMany({ orderBy: { createdAt: "asc" } });
  }

  async saveTechnicians(
    input: TechnicianInput[]
  ): Promise<Technician[]> {
    // Validate every referenced service area up front, outside the
    // transaction, so a typo'd id fails fast with a clear 400 instead of
    // surfacing as an FK-violation mid-transaction.
    const distinctAreaIds = [...new Set(input.flatMap((t) => t.serviceAreaIds ?? []))];
    if (distinctAreaIds.length > 0) {
      const found = await this.prisma.serviceArea.findMany({
        where: { id: { in: distinctAreaIds } },
        select: { id: true },
      });
      const foundSet = new Set(found.map((a) => a.id));
      const missing = distinctAreaIds.filter((id) => !foundSet.has(id));
      if (missing.length > 0) {
        throw new AppError(400, `serviceAreaId(s) not found: ${missing.join(", ")}`);
      }
    }

    // IDs generated up front (same reasoning as bulkAddSetupProperties above)
    // so the service-area join rows can be inserted with createMany in the
    // same transaction, instead of a second round of per-row lookups.
    const rows = input.map((t) => ({ ...t, id: randomUUID() }));

    // Replace semantics — re-posting step 6 must not append duplicates. Delete
    // only the invite-pending technicians (profileId = null); technicians who
    // have accepted an invite (real profileId) are never touched. Then recreate
    // from the input. Each created technician is invite-pending (profileId = null;
    // name/email arrive when the invite is accepted, unless set here directly).
    let technicians: Technician[];
    try {
      technicians = await this.prisma.$transaction(async (tx) => {
        await tx.technician.deleteMany({ where: { profileId: null } });
        if (rows.length > 0) {
          await tx.technician.createMany({
            data: rows.map((t) => ({
              id: t.id,
              profileId: null,
              name: t.name ?? null,
              role: t.role ?? null,
              phone: t.phone ?? null,
              email: t.email ?? null,
              active: t.active ?? true,
            })),
          });
          const areaRows = rows.flatMap((t) =>
            (t.serviceAreaIds ?? []).map((serviceAreaId) => ({ technicianId: t.id, serviceAreaId }))
          );
          if (areaRows.length > 0) {
            await tx.technicianServiceArea.createMany({ data: areaRows });
          }
        }
        return tx.technician.findMany({ orderBy: { createdAt: "asc" } });
      });
    } catch (err) {
      // Same class of bug as the technician-service/settings-service P2002
      // fixes above: two rows sharing an email (or colliding with an
      // already-invited technician's email) previously hit Technician.email's
      // @unique constraint and surfaced as a raw 500.
      if (err instanceof TenantPrisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError(409, "Two or more technicians share the same email address.");
      }
      throw err;
    }
    await this.markStepComplete(6);
    return technicians;
  }

  async getServiceAreas(): Promise<ServiceArea[]> {
    return this.prisma.serviceArea.findMany({ orderBy: { createdAt: "asc" } });
  }

  async saveServiceAreas(
    input: ServiceAreaInput[]
  ): Promise<ServiceArea[]> {
    // At most one area may be flagged default. Reject before any DB write.
    if (input.filter((a) => a.isDefault === true).length > 1) {
      throw new AppError(400, "Only one service area can be marked as default.");
    }
    // Upsert by name so re-posting step 7 after step 8 doesn't delete referenced areas.
    // Areas whose names are absent from the new input are deleted only if unreferenced.
    const areas = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.serviceArea.findMany({ select: { id: true, name: true } });
      const incomingNames = new Set(input.map((a) => a.name));

      // Remove areas not in the new input — only allowed if unreferenced.
      for (const area of existing.filter((e) => !incomingNames.has(e.name))) {
        const [roundRefs, propRefs] = await Promise.all([
          tx.round.count({ where: { serviceAreaId: area.id } }),
          tx.property.count({ where: { serviceAreaId: area.id } }),
        ]);
        if (roundRefs > 0 || propRefs > 0) {
          throw new AppError(
            409,
            `Cannot remove service area "${area.name}" — it is referenced by existing rounds or properties. ` +
            `Rename it instead, or remove the reference first.`
          );
        }
        await tx.serviceArea.delete({ where: { id: area.id } });
      }

      // Upsert each incoming area by name.
      for (const a of input) {
        const match = existing.find((e) => e.name === a.name);
        const data = {
          name: a.name,
          postcodeSector: a.postcodeSector ?? null,
          isDefault: a.isDefault ?? false,
        };
        if (match) {
          await tx.serviceArea.update({ where: { id: match.id }, data });
        } else {
          await tx.serviceArea.create({ data });
        }
      }

      return tx.serviceArea.findMany({ orderBy: { createdAt: "asc" } });
    });
    await this.markStepComplete(7);
    return areas;
  }

  async getActiveRounds(): Promise<Round[]> {
    return this.prisma.round.findMany({
      where: { status: RoundStatus.ACTIVE },
      orderBy: { createdAt: "asc" },
    });
  }

  async saveFirstRound(
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
      await this.assertServiceAreaExists(input.serviceAreaId);
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
    const round = existing
      ? await this.prisma.round.update({ where: { id: existing.id }, data })
      : await this.prisma.round.create({ data: { ...data, status: RoundStatus.ACTIVE } });
    await this.markStepComplete(8);
    return round;
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
      servicePlans: p.servicePlans,
      customerMatched: false,
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
    await this.assertServiceAreaExists(input.serviceAreaId);
    // M-1: Require ACTIVE status — a DRAFT round never appears in step 10's
    // ACTIVE-round query, so properties assigned to it would be orphaned from
    // technician coverage checks.
    const round = await this.prisma.round.findUnique({ where: { id: input.roundId } });
    if (!round) throw new AppError(400, `roundId not found: ${input.roundId}`);
    if (round.status !== RoundStatus.ACTIVE) {
      throw new AppError(400, "roundId must reference an ACTIVE round");
    }
    if (input.price < 0) throw new AppError(400, "price must be >= 0");
    const lastCleanedDate = parseLastCleaned(input.lastCleanedDate);
    if (lastCleanedDate === undefined) {
      throw new AppError(400, "lastCleanedDate must be a valid ISO date");
    }

    // GAP-010: explicit customerId must exist; otherwise reuse a customer
    // with the same mobile or email.
    let existingCustomer: Customer | null = null;
    if (input.customerId) {
      existingCustomer = await this.prisma.customer.findUnique({ where: { id: input.customerId } });
      if (!existingCustomer) throw new AppError(404, `Customer not found: ${input.customerId}`);
    } else if (input.phone || input.email) {
      const matchedId = (await this.loadCustomerIndex()).find(input);
      if (matchedId) existingCustomer = await this.prisma.customer.findUnique({ where: { id: matchedId } });
    }

    // GAP-009: no plan frequency → the round's.
    const cleaningFrequency = (input.cleaningFrequency as CleaningFrequency) ?? round.frequency ?? null;
    const nextDueDate = planNextDueDate({
      frequency: cleaningFrequency,
      defaultDay: round.defaultDay,
      lastCleanedDate,
      today: new Date(),
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const customer = existingCustomer ?? await tx.customer.create({
        data: {
          name: input.customerName,
          phone: input.phone ?? null,
          landline: input.landline ?? null,
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
      const servicePlans: ServicePlan[] = [];
      for (const entry of servicePlanEntries(input)) {
        servicePlans.push(
          await tx.servicePlan.create({
            data: {
              propertyId: property.id,
              serviceId: entry.serviceId,
              price: entry.price,
              paymentMethod: (input.paymentMethod as PaymentMethod) ?? null,
              cleaningFrequency,
              nextDueDate,
            },
          })
        );
      }
      return { customer, property, servicePlan: servicePlans[0], servicePlans, customerMatched: existingCustomer !== null };
    });
    await this.markStepComplete(9);
    return result;
  }

  // Every existing customer's mobile/email, for GAP-010 matching. Setup-sized
  // data (one tenant's customer list), so one query beats per-row lookups.
  private async loadCustomerIndex(): Promise<CustomerIndex> {
    const rows = await this.prisma.customer.findMany({
      where: { OR: [{ phone: { not: null } }, { email: { not: null } }] },
      select: { id: true, phone: true, email: true },
    });
    return new CustomerIndex(rows);
  }

  async bulkAddSetupProperties(
    inputs: SetupPropertyInput[],
    idempotencyKey?: string,
    opts: { allowFrequencyMismatch?: boolean } = {}
  ): Promise<BulkSetupPropertyResult> {
    if (idempotencyKey) {
      const existing = await this.prisma.bulkImportAttempt.findUnique({ where: { idempotencyKey } });
      if (existing) {
        return { created: existing.createdCount, failed: 0, results: [], errors: [], idempotent: true };
      }
    }

    if (inputs.length === 0) return { created: 0, failed: 0, results: [], errors: [] };

    const errors: SetupPropertyRowError[] = [];
    const today = new Date();

    // Per-row enum/value validation. Unlike the old all-or-nothing version,
    // an invalid row is recorded and excluded — it no longer aborts every
    // other (valid) row in the same request.
    type Candidate = { input: SetupPropertyInput; originalIndex: number; lastCleanedDate: Date | null };
    const candidates: Candidate[] = [];
    inputs.forEach((inp, i) => {
      if (inp.propertyType && !(Object.values(PropertyType) as string[]).includes(inp.propertyType)) {
        errors.push(rowError(i, "propertyType", `Invalid propertyType: ${inp.propertyType}`));
        return;
      }
      if (inp.cleaningFrequency && !(Object.values(CleaningFrequency) as string[]).includes(inp.cleaningFrequency)) {
        errors.push(rowError(i, "cleaningFrequency", `Invalid cleaningFrequency: ${inp.cleaningFrequency}`));
        return;
      }
      if (inp.paymentMethod && !(Object.values(PaymentMethod) as string[]).includes(inp.paymentMethod)) {
        errors.push(rowError(i, "paymentMethod", `Invalid paymentMethod: ${inp.paymentMethod}`));
        return;
      }
      if (inp.price < 0) {
        errors.push(rowError(i, "price", "price must be >= 0"));
        return;
      }
      const lastCleanedDate = parseLastCleaned(inp.lastCleanedDate);
      if (lastCleanedDate === undefined) {
        errors.push(rowError(i, "lastCleanedDate", "lastCleanedDate must be a valid ISO date"));
        return;
      }
      candidates.push({ input: inp, originalIndex: i, lastCleanedDate });
    });

    // Per-row FK existence/status checks, batched across all still-valid rows.
    type Resolved = Candidate & {
      cleaningFrequency: CleaningFrequency | null;
      nextDueDate: Date;
    };
    const resolved: Resolved[] = [];
    if (candidates.length > 0) {
      const distinctAreaIds = [...new Set(candidates.map((c) => c.input.serviceAreaId))];
      const foundAreas = await this.prisma.serviceArea.findMany({
        where: { id: { in: distinctAreaIds } },
        select: { id: true },
      });
      const foundAreaSet = new Set(foundAreas.map((a) => a.id));

      const distinctRoundIds = [...new Set(candidates.map((c) => c.input.roundId))];
      const foundRounds = await this.prisma.round.findMany({
        where: { id: { in: distinctRoundIds } },
        select: { id: true, status: true, frequency: true, defaultDay: true },
      });
      const foundRoundMap = new Map(foundRounds.map((r) => [r.id, r]));

      const distinctCustomerIds = [
        ...new Set(candidates.map((c) => c.input.customerId).filter((id): id is string => !!id)),
      ];
      const foundCustomers = distinctCustomerIds.length
        ? await this.prisma.customer.findMany({ where: { id: { in: distinctCustomerIds } }, select: { id: true } })
        : [];
      const foundCustomerSet = new Set(foundCustomers.map((c) => c.id));

      for (const c of candidates) {
        if (!foundAreaSet.has(c.input.serviceAreaId)) {
          errors.push(rowError(c.originalIndex, "serviceAreaId", `serviceAreaId not found: ${c.input.serviceAreaId}`));
          continue;
        }
        const round = foundRoundMap.get(c.input.roundId);
        if (!round) {
          errors.push(rowError(c.originalIndex, "roundId", `roundId not found: ${c.input.roundId}`));
          continue;
        }
        if (round.status !== RoundStatus.ACTIVE) {
          errors.push(rowError(c.originalIndex, "roundId", "roundId must reference an ACTIVE round"));
          continue;
        }
        if (c.input.customerId && !foundCustomerSet.has(c.input.customerId)) {
          errors.push(rowError(c.originalIndex, "customerId", `Customer not found: ${c.input.customerId}`));
          continue;
        }
        // GAP-009: an omitted frequency inherits the round's; a different one
        // is rejected unless the caller opted in with allowFrequencyMismatch.
        const rowFrequency = (c.input.cleaningFrequency as CleaningFrequency | null | undefined) ?? null;
        if (rowFrequency && round.frequency && rowFrequency !== round.frequency && !opts.allowFrequencyMismatch) {
          errors.push(rowError(
            c.originalIndex,
            "cleaningFrequency",
            `cleaningFrequency ${rowFrequency} doesn't match the round's ${round.frequency}. ` +
            `Send allowFrequencyMismatch: true to import it anyway.`
          ));
          continue;
        }
        const cleaningFrequency = rowFrequency ?? round.frequency;
        resolved.push({
          ...c,
          cleaningFrequency,
          nextDueDate: planNextDueDate({
            frequency: cleaningFrequency,
            defaultDay: round.defaultDay,
            lastCleanedDate: c.lastCleanedDate,
            today,
          }),
        });
      }
    }

    // GAP-010: rows reuse an existing customer (or one created earlier in
    // this same import) with the same mobile or email.
    const committed = resolved.length > 0 ? await this.loadCustomerIndex() : new CustomerIndex();

    const BATCH_SIZE = 100;
    const allResults: SetupPropertyResult[] = [];

    for (let batchStart = 0; batchStart < resolved.length; batchStart += BATCH_SIZE) {
      const batch = resolved.slice(batchStart, batchStart + BATCH_SIZE);
      // Customers created by this batch — only merged into `committed` once
      // the batch commits, so a failed batch can't leave later rows pointing
      // at a customer that was never written.
      const pending = new CustomerIndex();

      // IDs generated up front so customer/property/servicePlan rows can be
      // inserted with createMany (3 queries per batch) instead of looping
      // create() per row inside an interactive transaction (3 * batch.length
      // round trips). The old loop routinely ran past Prisma's default 5s
      // interactive-transaction timeout on a 100-row batch, so the engine
      // closed the transaction mid-batch and the next query in it failed with
      // "Transaction API error: Transaction not found ... old closed
      // transaction". The array form of $transaction below sends all three
      // createMany statements as one batched (non-interactive) request, so
      // there's no long-lived transaction to time out.
      const rows = batch.map((c) => {
        const matchedId = c.input.customerId || committed.find(c.input) || pending.find(c.input);
        const customerId = matchedId ?? randomUUID();
        if (!matchedId) pending.add(customerId, c.input);
        return {
          ...c,
          inp: c.input,
          customerId,
          isNewCustomer: !matchedId,
          propertyId: randomUUID(),
          plans: servicePlanEntries(c.input).map((entry) => ({ ...entry, id: randomUUID() })),
        };
      });
      const newCustomerRows = rows.filter((r) => r.isNewCustomer);

      try {
        await this.prisma.$transaction([
          this.prisma.customer.createMany({
            data: newCustomerRows.map(({ inp, customerId }) => ({
              id: customerId,
              name: inp.customerName,
              phone: inp.phone ?? null,
              landline: inp.landline ?? null,
              email: inp.email ?? null,
              paymentMethod: (inp.paymentMethod as PaymentMethod) ?? null,
            })),
          }),
          this.prisma.property.createMany({
            data: rows.map(({ inp, customerId, propertyId }) => ({
              id: propertyId,
              customerId,
              propertyName: inp.propertyName ?? null,
              addressLine: inp.fullAddress,
              postcode: inp.postcode,
              serviceAreaId: inp.serviceAreaId,
              propertyType: (inp.propertyType as PropertyType) ?? null,
              accessNotes: inp.accessNotes ?? null,
              riskNotes: inp.riskNotes ?? null,
              roundId: inp.roundId,
            })),
          }),
          this.prisma.servicePlan.createMany({
            data: rows.flatMap(({ inp, propertyId, plans, cleaningFrequency, nextDueDate }) =>
              plans.map((plan) => ({
                id: plan.id,
                propertyId,
                serviceId: plan.serviceId,
                price: plan.price,
                paymentMethod: (inp.paymentMethod as PaymentMethod) ?? null,
                cleaningFrequency,
                nextDueDate,
              }))
            ),
          }),
        ]);
      } catch (err) {
        // Array-form $transaction is all-or-nothing per batch: nothing in
        // this batch was committed, but earlier batches (and the next ones)
        // are unaffected — report every row in this batch as failed and
        // keep going instead of aborting the whole import.
        const message = err instanceof Error ? err.message : String(err);
        for (const { originalIndex } of batch) {
          errors.push(rowError(originalIndex, "batch", message));
        }
        continue;
      }
      committed.merge(pending);

      // createMany doesn't return the created rows — refetch by the IDs we
      // just assigned so the response shape (full customer/property/plan
      // records) is unchanged for callers.
      const allPlanIds = rows.flatMap((r) => r.plans.map((p) => p.id));
      const [customers, properties, servicePlans] = await Promise.all([
        this.prisma.customer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.customerId))] } } }),
        this.prisma.property.findMany({ where: { id: { in: rows.map((r) => r.propertyId) } } }),
        this.prisma.servicePlan.findMany({ where: { id: { in: allPlanIds } } }),
      ]);
      const customerById = new Map(customers.map((c) => [c.id, c]));
      const propertyById = new Map(properties.map((p) => [p.id, p]));
      const servicePlanById = new Map(servicePlans.map((sp) => [sp.id, sp]));

      for (const row of rows) {
        const plans = row.plans.map((p) => servicePlanById.get(p.id)!);
        allResults.push({
          customer: customerById.get(row.customerId)!,
          property: propertyById.get(row.propertyId)!,
          servicePlan: plans[0],
          servicePlans: plans,
          customerMatched: !row.isNewCustomer,
        });
      }
    }

    const createdCount = allResults.length;

    if (idempotencyKey) {
      await this.prisma.bulkImportAttempt
        .create({ data: { idempotencyKey, createdCount } })
        .catch(() => {
          // Best-effort: a race against a concurrent identical retry means
          // the import already happened either way — nothing to recover.
        });
    }
    if (createdCount > 0) await this.markStepComplete(9);

    return {
      created: createdCount,
      failed: inputs.length - createdCount,
      results: allResults,
      errors,
    };
  }

  // ── Step 10: Assign Technicians to Rounds ───────────────────────────────

  private async assertServiceAreaExists(id: string): Promise<void> {
    const area = await this.prisma.serviceArea.findUnique({ where: { id }, select: { id: true } });
    if (!area) throw new AppError(400, `serviceAreaId not found: ${id}`);
  }

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

    await this.markStepComplete(10);
    return this.buildStep10Result();
  }

  // ── Step 11: Activate System & Generate Visits ──────────────────────────

  async getActivationStatus(): Promise<{ activated: boolean; visitsGenerated: number }> {
    const count = await this.prisma.visit.count({
      where: { status: VisitStatus.SCHEDULED },
    });
    return { activated: count > 0, visitsGenerated: count };
  }

  // Validates the activation window (shared by activation and its preview).
  // Dates are UTC-midnight date values (lib/schedule.ts), never local time.
  private parseActivationWindow(input: ActivationWindowInput): { startDate: Date; cycleEndDate: Date } {
    if (input.cycleWeeks < 1 || input.cycleWeeks > 52 || !Number.isInteger(input.cycleWeeks)) {
      throw new AppError(400, "cycleWeeks must be an integer between 1 and 52");
    }
    const parsed = new Date(input.startDate);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError(400, "startDate must be a valid ISO date string");
    }
    const startDate = startOfUtcDay(parsed);
    // M-3: Reject past start dates — they generate immediately-overdue visits.
    if (startDate < startOfUtcDay(new Date())) {
      throw new AppError(400, "startDate must be today or in the future");
    }
    // Exclusive end (GAP-016) — see enumerateActivationVisits.
    return { startDate, cycleEndDate: addWeeks(startDate, input.cycleWeeks) };
  }

  // GET /setup/step/11/preview — the same plan activation would write, counted.
  async previewActivation(input: ActivationWindowInput): Promise<ActivationPreview> {
    const window = this.parseActivationWindow(input);
    const { rounds, windows } = await loadActivationInputs(this.prisma, { status: RoundStatus.ACTIVE }, window);
    const plan = buildActivationPlan(rounds, { ...window, windows });
    return {
      rounds: plan.rounds.map((r) => ({
        roundId: r.roundId,
        name: r.name,
        firstVisit: r.firstVisit ? isoDay(r.firstVisit) : null,
        visits: r.visits,
      })),
      total: plan.total,
    };
  }

  async activateSystem(input: ActivationInput): Promise<ActivationResult> {
    const window = this.parseActivationWindow(input);

    // H-1: Use setupCompleted as the canonical activation guard, not visit.count().
    // An unrelated visit (e.g. created during testing) must not permanently block activation.
    const settings = await this.getSettings();
    if (settings?.setupCompleted) {
      throw new AppError(409, "System is already activated — setup is complete");
    }

    if (!input.generateAll && (!input.roundIds || input.roundIds.length === 0)) {
      throw new AppError(400, "roundIds is required when generateAll is false");
    }

    const roundWhere = input.generateAll
      ? { status: RoundStatus.ACTIVE }
      : { status: RoundStatus.ACTIVE, id: { in: input.roundIds } };

    const { rounds, windows } = await loadActivationInputs(this.prisma, roundWhere, window);

    // M-4: When targeting specific rounds, fail early if none matched.
    if (!input.generateAll && rounds.length === 0) {
      throw new AppError(404, "None of the specified roundIds were found");
    }

    // X-1: technicianId is stamped per visit (property allocation → sole
    // round technician → unassigned), paymentHold from customer.holdNextClean,
    // and X-2: each plan's nextDueDate continues the series after the window
    // so the nightly generator picks it up.
    const plan = buildActivationPlan(rounds, { ...window, windows });

    if (plan.visits.length > 0) {
      await this.prisma.$transaction([
        this.prisma.visit.createMany({ data: plan.visits }),
        ...plan.nextDueDates.map((u) =>
          this.prisma.servicePlan.update({ where: { id: u.servicePlanId }, data: { nextDueDate: u.nextDueDate } })
        ),
      ]);
      await this.markStepComplete(11);
    }

    return { visitsGenerated: plan.total };
  }

  // ── Step 12: Review & Launch checklist ─────────────────────────────────

  async getReviewChecklist(): Promise<{
    checklist: Array<{ label: string; complete: boolean }>;
    allComplete: boolean;
  }> {
    const status = await this.getStatus();
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

export function createSetupService(prisma: TenantPrismaClient) {
  return new SetupService(prisma);
}
