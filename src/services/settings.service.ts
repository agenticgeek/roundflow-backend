import { ServiceCategory, PaymentTiming, MessageChannel, RoundStatus } from "../generated/tenant-client";
import type { ReminderMode, CleanMethod, PaymentMethod, NoDirectDebitAction } from "../generated/tenant-client";
import type {
  BusinessSettings,
  Service,
  ServiceArea,
  Technician,
  MessageTemplate,
} from "../generated/tenant-client";

import { Prisma as TenantPrisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { deriveAppStatus, techInclude, mapServiceAreas } from "./technician.service";
import type { TechnicianServiceAreaRow } from "./technician.service";

// This is the post-completion editing surface for the same data the Setup
// Wizard seeds (see docs/SETTINGS_API_DESIGN.md). Separate from SetupService:
// no assertSetupIncomplete guard here.

export interface BankDetails {
  accountName: string;
  bankName?: string | null;
  accountNumber: string;
  sortCode: string;
}

export interface BusinessProfileUpdateInput {
  businessName?: string | null;
  phone?: string | null;
  email?: string | null;
  companyNumber?: string | null;
  vatRegistered?: boolean;
  vatRegistration?: string | null;
  timezone?: string | null;
  currency?: string | null;
  defaultWorkingDays?: string[];
  bankDetails?: BankDetails | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  town?: string | null;
  postcode?: string | null;
  vatRate?: number;
}

export interface RoundSettingsUpdateInput {
  defaultCycleLength?: number | null;
  defaultWorkingDays?: string[];
  /** @deprecated use reminderMode/reminderTime (B2). Still stored for old clients. */
  preCleanReminderTimings?: string[];
  reminderMode?: ReminderMode;
  reminderTime?: string;
  defaultCleanMethod?: CleanMethod | null;
  autoCreateNextVisit?: boolean;
}

export interface ServiceCreateInput {
  name: string;
  defaultPrice: number;
  category?: ServiceCategory;
  description?: string | null;
  active?: boolean;
}

export interface ServiceUpdateInput {
  name?: string;
  defaultPrice?: number;
  category?: ServiceCategory;
  description?: string | null;
  active?: boolean;
}

export interface ServiceAreaCreateInput {
  name: string;
  postcodeSector?: string | null;
  isDefault?: boolean;
}

export interface ServiceAreaUpdateInput {
  name?: string;
  postcodeSector?: string | null;
  isDefault?: boolean;
}

export interface TechnicianCreateInput {
  name?: string | null;
  phone?: string | null;
  role?: string | null;
  email?: string | null;
  active?: boolean;
  serviceAreaIds?: string[];
}

export interface TechnicianUpdateInput {
  name?: string | null;
  phone?: string | null;
  role?: string | null;
  email?: string | null;
  active?: boolean;
  // undefined = no change; [] = clear all areas; non-empty = replace with these
  serviceAreaIds?: string[];
}

export interface PaymentRulesUpdateInput {
  paymentRule?: PaymentTiming | null;
  vatInInvoices?: boolean;
  debtHoldEnabled?: boolean;
  debtHoldMaxInvoices?: number | null;
  debtHoldMaxAmount?: number | null;
  defaultPaymentMethod?: PaymentMethod | null;
  invoiceDueDays?: number;
  noDirectDebitAction?: NoDirectDebitAction;
}

/** ServiceArea + a derived, read-only summary of Rounds that reference it. */
export interface ServiceAreaWithRounds extends ServiceArea {
  linkedRounds: { count: number; names: string[] };
}

export type AppStatus = "PENDING_INVITE" | "ACTIVE" | "INACTIVE";

/** Technician + derived display name / app status.
 *  Profile is in the public schema (cross-schema) — name falls back to the
 *  admin label on Technician.name until per-request profile lookup is wired. */
export interface TechnicianWithDisplayName extends Technician {
  displayName: string | null;
  appStatus: AppStatus;
  serviceAreas: TechnicianServiceAreaRow[];
}

export interface MessageTemplateInput {
  name: string;
  channel: MessageChannel;
  body: string;
  subject?: string | null;
}

export interface MessageTemplateUpdateInput {
  name?: string;
  channel?: MessageChannel;
  body?: string;
  subject?: string | null;
}

export interface MessageTemplateView {
  id: string;
  name: string;
  channel: MessageChannel | null;
  subject: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}


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

/** The scalar fields any singleton write may touch (plain values, not Prisma ops). */
type SettingsWritable = {
  businessName?: string | null;
  phone?: string | null;
  email?: string | null;
  companyNumber?: string | null;
  vatRegistered?: boolean;
  vatRegistration?: string | null;
  timezone?: string | null;
  currency?: string | null;
  defaultWorkingDays?: string[];
  defaultCycleLength?: number | null;
  paymentRule?: PaymentTiming | null;
  vatInInvoices?: boolean;
  debtHoldEnabled?: boolean;
  debtHoldMaxInvoices?: number | null;
  debtHoldMaxAmount?: number | null;
  gocardlessConnected?: boolean;
  stripeConnected?: boolean;
  preCleanReminderTimings?: string[];
  bankDetails?: TenantPrisma.InputJsonValue | typeof TenantPrisma.JsonNull;
  addressLine1?: string | null;
  addressLine2?: string | null;
  town?: string | null;
  postcode?: string | null;
  vatRate?: number;
  reminderMode?: ReminderMode;
  reminderTime?: string;
  defaultCleanMethod?: CleanMethod | null;
  autoCreateNextVisit?: boolean;
  defaultPaymentMethod?: PaymentMethod | null;
  invoiceDueDays?: number;
  noDirectDebitAction?: NoDirectDebitAction;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Short-TTL, positive-only cache of the BusinessSettings singleton, keyed by
// TenantPrismaClient instance rather than tenant schema name. This is the ONE
// cache for this row — every reader (SettingsService.getSettings() below,
// and the direct-call-site readers in customer.service.ts, invoice.service.ts,
// today.service.ts) goes through getCachedBusinessSettings(), and every
// writer (writeSettings() below, plus every direct businessSettings.update*/
// upsert call across the codebase — see invalidateCachedBusinessSettings())
// invalidates the same entry. (A previous version of this cache was split in
// two — one keyed by schema name for SettingsService, one keyed by client
// instance for the direct readers — which meant a request touching both
// paths could double-miss, and a write through one path could leave the
// other's entry stale. Collapsed into one.)
//
// Keying by client instance works because getTenantPrismaForSchema()
// (tenant-prisma-manager.ts) returns the SAME client instance per tenant
// schema for as long as it stays in that LRU (max 100) — instance identity is
// a reliable per-tenant key; a cache miss after eviction just costs one extra
// DB read, never a cross-tenant leak.
//
// Positive-only by construction: only a *found* settings row is ever cached,
// so a tenant that just completed the Setup Wizard is never stuck behind a
// stale "not set up" null for this TTL window.
//
// TTL matches profileCache's 30s (requireTenantAccess.ts) — same staleness
// trade-off rationale, and business settings change even less often than a
// user's role/profile does, so there's no reason to go shorter.
const SETTINGS_CACHE_TTL_MS = 30_000;
const settingsCache = new WeakMap<
  TenantPrismaClient,
  { value: BusinessSettings; expiresAt: number }
>();

/** Cached read of the BusinessSettings singleton. Never caches a null result.
 *  Not for use inside a `$transaction` callback — the `tx` client there is a
 *  distinct, short-lived object each call, and transactional reads that gate
 *  a mutation (e.g. an idempotency check) need a fresh row anyway. */
export async function getCachedBusinessSettings(
  prisma: TenantPrismaClient
): Promise<BusinessSettings | null> {
  const entry = settingsCache.get(prisma);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  const settings = await prisma.businessSettings.findFirst();
  if (settings) {
    settingsCache.set(prisma, { value: settings, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  } else {
    settingsCache.delete(prisma);
  }
  return settings;
}

/** Invalidate the cached BusinessSettings row for this tenant's prisma
 *  client. Call this after ANY successful direct `businessSettings.update*`/
 *  `upsert` write that doesn't go through SettingsService.writeSettings()
 *  (which already calls this itself) — otherwise a cached read elsewhere
 *  (customer/invoice/today services, SettingsService.getSettings()) can
 *  serve a stale row for up to SETTINGS_CACHE_TTL_MS after the write. */
export function invalidateCachedBusinessSettings(prisma: TenantPrismaClient): void {
  settingsCache.delete(prisma);
}

class SettingsService {
  constructor(
    private readonly prisma: TenantPrismaClient,
    // Unused by caching now (collapsed onto the client-instance-keyed cache
    // above), but kept to avoid touching every call site's/test's signature
    // again for no behavioral benefit.
    private readonly schemaName: string
  ) {}

  // ---- singleton seam (the ONLY two methods that know the singleton key) ----

  /** Read the BusinessSettings singleton (cached — see getCachedBusinessSettings). */
  async getSettings(): Promise<BusinessSettings | null> {
    return getCachedBusinessSettings(this.prisma);
  }

  /** Partial upsert of the BusinessSettings singleton. Undefined fields are
   *  left unchanged; null clears the field. Invalidates the cache after a
   *  successful write, forcing the next getSettings() call to refetch. */
  private async writeSettings(data: SettingsWritable): Promise<BusinessSettings> {
    const result = await this.prisma.businessSettings.upsert({
      where: { uniqueId: "singleton" },
      update: data,
      create: { ...data },
    });
    invalidateCachedBusinessSettings(this.prisma);
    return result;
  }

  // ---- guard ----

  /** Mutating Settings endpoints require setup to be complete. Reads the
   *  singleton via the existing getSettings() seam (no extra findUnique). */
  async assertSetupComplete(): Promise<void> {
    const settings = await this.getSettings();
    if (!settings || settings.setupCompleted === false) {
      throw new AppError(
        403,
        "Setup must be completed before editing settings. Complete the Setup Wizard first."
      );
    }
  }

  // ---- Business Profile ----

  async updateBusinessProfile(
    input: BusinessProfileUpdateInput
  ): Promise<BusinessSettings> {
    // Step-1 fields only — never touches the round-settings fields.
    return this.writeSettings({
      businessName: input.businessName,
      phone: input.phone,
      email: input.email,
      companyNumber: input.companyNumber,
      vatRegistered: input.vatRegistered,
      vatRegistration: input.vatRegistration,
      timezone: input.timezone,
      currency: input.currency,
      defaultWorkingDays: input.defaultWorkingDays,
      bankDetails:
        input.bankDetails === undefined
          ? undefined
          : input.bankDetails === null
          ? TenantPrisma.JsonNull
          : (input.bankDetails as unknown as TenantPrisma.InputJsonValue),
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      town: input.town,
      postcode: input.postcode,
      vatRate: input.vatRate,
    });
  }

  // ---- Round Settings ----

  async updateRoundSettings(
    input: RoundSettingsUpdateInput
  ): Promise<BusinessSettings> {
    return this.writeSettings({
      defaultCycleLength: input.defaultCycleLength,
      defaultWorkingDays: input.defaultWorkingDays,
      preCleanReminderTimings: input.preCleanReminderTimings,
      reminderMode: input.reminderMode,
      reminderTime: input.reminderTime,
      defaultCleanMethod: input.defaultCleanMethod,
      autoCreateNextVisit: input.autoCreateNextVisit,
    });
  }

  // ---- Service Catalogue ----

  async getServices(): Promise<Service[]> {
    return this.prisma.service.findMany({ orderBy: { createdAt: "asc" } });
  }

  async createService(
    input: ServiceCreateInput
  ): Promise<Service> {
    return this.prisma.service.create({
      data: {
        name: input.name,
        defaultPrice: input.defaultPrice,
        category: input.category ?? ServiceCategory.DEFAULT,
        description: input.description ?? null,
        active: input.active ?? true,
      },
    });
  }

  async updateService(
    id: string,
    input: ServiceUpdateInput
  ): Promise<Service> {
    const existing = await this.prisma.service.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Service not found");
    return this.prisma.service.update({
      where: { id },
      data: {
        name: input.name,
        defaultPrice: input.defaultPrice,
        category: input.category,
        description: input.description,
        active: input.active,
      },
    });
  }

  async deleteService(id: string): Promise<void> {
    const existing = await this.prisma.service.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Service not found");
    const [planRefs, visitRefs] = await Promise.all([
      this.prisma.servicePlan.count({ where: { serviceId: id } }),
      this.prisma.visit.count({ where: { serviceId: id } }),
    ]);
    if (planRefs > 0 || visitRefs > 0) {
      throw new AppError(409, "Service is in use and cannot be deleted");
    }
    await this.prisma.service.delete({ where: { id } });
  }

  // ---- Service Areas ----

  async getServiceAreas(): Promise<ServiceAreaWithRounds[]> {
    const areas = await this.prisma.serviceArea.findMany({
      orderBy: { createdAt: "asc" },
      include: { rounds: { where: { status: RoundStatus.ACTIVE }, select: { id: true, name: true } } },
    });
    // linkedRounds is a derived, read-only field (not stored).
    return areas.map(({ rounds, ...rest }) => ({
      ...rest,
      linkedRounds: { count: rounds.length, names: rounds.map((r) => r.name) },
    }));
  }

  async createServiceArea(
    input: ServiceAreaCreateInput
  ): Promise<ServiceArea> {
    const data = {
      name: input.name,
      postcodeSector: input.postcodeSector ?? null,
      isDefault: input.isDefault ?? false,
    };
    if (input.isDefault === true) {
      // Single-default invariant: clear every existing default, then insert the
      // new one — atomically (array-form transaction).
      const [, created] = await this.prisma.$transaction([
        this.prisma.serviceArea.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        }),
        this.prisma.serviceArea.create({ data }),
      ]);
      return created;
    }
    return this.prisma.serviceArea.create({ data });
  }

  async updateServiceArea(
    id: string,
    input: ServiceAreaUpdateInput
  ): Promise<ServiceArea> {
    const existing = await this.prisma.serviceArea.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Service area not found");
    const data = {
      name: input.name,
      postcodeSector: input.postcodeSector,
      isDefault: input.isDefault,
    };
    if (input.isDefault === true) {
      // Single-default invariant: clear the default flag on every OTHER area
      // before setting it here — atomically (array-form transaction).
      const [, updated] = await this.prisma.$transaction([
        this.prisma.serviceArea.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        }),
        this.prisma.serviceArea.update({ where: { id }, data }),
      ]);
      return updated;
    }
    return this.prisma.serviceArea.update({ where: { id }, data });
  }

  async deleteServiceArea(id: string): Promise<void> {
    const existing = await this.prisma.serviceArea.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Service area not found");
    const [roundRefs, propertyRefs, techRefs] = await Promise.all([
      this.prisma.round.count({ where: { serviceAreaId: id } }),
      this.prisma.property.count({ where: { serviceAreaId: id } }),
      this.prisma.technicianServiceArea.count({ where: { serviceAreaId: id } }),
    ]);
    if (roundRefs > 0 || propertyRefs > 0 || techRefs > 0) {
      throw new AppError(409, "Service area is in use and cannot be deleted");
    }
    await this.prisma.serviceArea.delete({ where: { id } });
  }

  // ---- Technician Management ----

  // Validates every id in `areaIds` exists; throws AppError(404) naming
  // whichever ones don't.
  private async assertServiceAreasExist(areaIds: string[]): Promise<void> {
    if (areaIds.length === 0) return;
    const found = await this.prisma.serviceArea.findMany({
      where: { id: { in: areaIds } },
      select: { id: true },
    });
    if (found.length === areaIds.length) return;
    const foundSet = new Set(found.map((a) => a.id));
    const missing = areaIds.filter((id) => !foundSet.has(id));
    throw new AppError(404, `Service area(s) not found: ${missing.join(", ")}`);
  }

  async getTechnicians(): Promise<TechnicianWithDisplayName[]> {
    const techs = await this.prisma.technician.findMany({
      include: techInclude,
      orderBy: { createdAt: "asc" },
    });
    return techs.map((t) => ({
      ...t,
      // Profile.name resolution is deferred until per-request tenant client is
      // wired (cross-schema lookup required). Use admin label for now.
      displayName: t.name ?? null,
      appStatus: deriveAppStatus(t.active, t.profileId),
      serviceAreas: mapServiceAreas(t),
    }));
  }

  async createTechnician(
    input: TechnicianCreateInput
  ): Promise<TechnicianWithDisplayName> {
    const areaIds = [...new Set(input.serviceAreaIds ?? [])];
    await this.assertServiceAreasExist(areaIds);

    // Single invite-pending create (profileId = null) — not the wizard's bulk replace.
    let tech;
    try {
      tech = await this.prisma.technician.create({
        data: {
          profileId: null,
          name: input.name ?? null,
          phone: input.phone ?? null,
          role: input.role ?? null,
          email: input.email ?? null,
          active: input.active ?? true,
          ...(areaIds.length > 0
            ? { serviceAreas: { create: areaIds.map((serviceAreaId) => ({ serviceAreaId })) } }
            : {}),
        },
        include: techInclude,
      });
    } catch (err) {
      // Mirrors technician.service.ts's createTechnician: without this, a
      // duplicate-email @unique violation here falls through to the generic
      // 500 handler instead of a clean 409 (see updateTechnician below —
      // this path was previously missing it entirely).
      if (err instanceof TenantPrisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError(409, "A technician with this email already exists");
      }
      throw err;
    }
    return {
      ...tech,
      displayName: tech.name ?? null,
      appStatus: deriveAppStatus(tech.active, tech.profileId),
      serviceAreas: mapServiceAreas(tech),
    };
  }

  async updateTechnician(
    id: string,
    input: TechnicianUpdateInput
  ): Promise<TechnicianWithDisplayName> {
    const existing = await this.prisma.technician.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Technician not found");

    const areaIds =
      input.serviceAreaIds !== undefined ? [...new Set(input.serviceAreaIds)] : undefined;
    if (areaIds !== undefined) {
      await this.assertServiceAreasExist(areaIds);
    }

    let tech;
    try {
      tech = await this.prisma.technician.update({
        where: { id },
        data: {
          name: input.name,
          phone: input.phone,
          role: input.role,
          email: input.email,
          active: input.active,
          // Replace-semantics for service areas: [] = clear all, non-empty =
          // replace. Nested deleteMany+create on a single update() is one
          // query — Prisma applies it atomically, no explicit $transaction
          // needed.
          ...(areaIds !== undefined
            ? {
                serviceAreas: {
                  deleteMany: {},
                  create: areaIds.map((serviceAreaId) => ({ serviceAreaId })),
                },
              }
            : {}),
        },
        include: techInclude,
      });
    } catch (err) {
      // Regression fix (RF-05 / QA bug report): updating a technician to an
      // email already used by another technician hits the @unique
      // constraint on Technician.email. createTechnician already mapped
      // that P2002 to a 409 (see above); this path didn't, so it fell
      // through to the generic 500 handler as a raw "Internal Server Error"
      // instead of a clean, actionable message — the same class of bug
      // technician.service.ts's updateTechnician already had to fix.
      if (err instanceof TenantPrisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError(409, "A technician with this email already exists");
      }
      throw err;
    }

    return {
      ...tech,
      displayName: tech.name ?? null,
      appStatus: deriveAppStatus(tech.active, tech.profileId),
      serviceAreas: mapServiceAreas(tech),
    };
  }

  async deleteTechnician(id: string): Promise<void> {
    const existing = await this.prisma.technician.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Technician not found");
    if (existing.profileId !== null) {
      throw new AppError(
        409,
        "Cannot delete a technician who has accepted their invite. Deactivate them instead."
      );
    }
    await this.prisma.technician.delete({ where: { id } });
  }

  // ---- Payment Setup ----

  async updatePaymentRules(
    input: PaymentRulesUpdateInput
  ): Promise<BusinessSettings> {
    // Rules only — never touches the gocardless/stripe connect booleans.
    return this.writeSettings({
      paymentRule: input.paymentRule,
      vatInInvoices: input.vatInInvoices,
      debtHoldEnabled: input.debtHoldEnabled,
      debtHoldMaxInvoices: input.debtHoldMaxInvoices,
      debtHoldMaxAmount: input.debtHoldMaxAmount,
      defaultPaymentMethod: input.defaultPaymentMethod,
      invoiceDueDays: input.invoiceDueDays,
      noDirectDebitAction: input.noDirectDebitAction,
    });
  }

  // ---- Message Templates ----

  async getMessageTemplates(): Promise<MessageTemplateView[]> {
    const rows = await this.prisma.messageTemplate.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(toTemplateView);
  }

  async createMessageTemplate(
    input: MessageTemplateInput
  ): Promise<MessageTemplateView> {
    const row = await this.prisma.messageTemplate.create({
      data: {
        name: input.name,
        channel: input.channel,
        body: input.body,
        subject: input.subject ?? null,
      },
    });
    return toTemplateView(row);
  }

  async updateMessageTemplate(
    id: string,
    input: MessageTemplateUpdateInput
  ): Promise<MessageTemplateView> {
    if (!(await this.prisma.messageTemplate.findUnique({ where: { id } }))) {
      throw new AppError(404, "Message template not found");
    }
    const row = await this.prisma.messageTemplate.update({
      where: { id },
      data: {
        name: input.name,
        channel: input.channel,
        body: input.body,
        subject: input.subject,
      },
    });
    return toTemplateView(row);
  }

  async deleteMessageTemplate(id: string): Promise<void> {
    if (!(await this.prisma.messageTemplate.findUnique({ where: { id } }))) {
      throw new AppError(404, "Message template not found");
    }
    await this.prisma.messageTemplate.delete({ where: { id } });
  }

  async replaceTemplates(
    templates: MessageTemplateInput[]
  ): Promise<MessageTemplateView[]> {
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.messageTemplate.deleteMany();
      if (templates.length === 0) return [];
      await tx.messageTemplate.createMany({
        data: templates.map((t) => ({
          name: t.name,
          channel: t.channel,
          body: t.body,
          subject: t.subject ?? null,
        })),
      });
      return tx.messageTemplate.findMany({ orderBy: { createdAt: "asc" } });
    });
    return rows.map(toTemplateView);
  }
}

function toTemplateView(t: MessageTemplate): MessageTemplateView {
  return {
    id: t.id,
    name: t.name,
    channel: t.channel,
    subject: t.subject,
    body: t.body,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function createSettingsService(prisma: TenantPrismaClient, schemaName: string) {
  return new SettingsService(prisma, schemaName);
}
