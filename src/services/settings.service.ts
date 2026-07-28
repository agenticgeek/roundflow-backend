import { ServiceCategory, PaymentTiming, MessageChannel, RoundStatus, LifecycleStatus } from "../generated/tenant-client";
import type {
  BusinessSettings,
  Service,
  ServiceArea,
  Technician,
  MessageTemplate,
} from "../generated/tenant-client";
import type { Profile } from "@prisma/client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
//
// This is the **post-completion editing surface** for the same data the Setup
// Wizard seeds (see docs/SETTINGS_API_DESIGN.md). It is a SEPARATE service from
// SetupService — same discipline (profileId-first, singleton seam, thin routes)
// but no `assertSetupIncomplete` guard: Settings is always open.

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
}

export interface RoundSettingsUpdateInput {
  defaultCycleLength?: number | null;
  defaultWorkingDays?: string[];
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
  active?: boolean;
}

export interface TechnicianUpdateInput {
  name?: string | null;
  phone?: string | null;
  role?: string | null;
  active?: boolean;
}

export interface PaymentRulesUpdateInput {
  paymentRule?: PaymentTiming | null;
  vatInInvoices?: boolean;
  debtHoldEnabled?: boolean;
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
}

export interface DeferredStub {
  status: string;
  source: string;
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

// The service contract. Routes depend on this abstraction, never on the
// concrete class — so Phase 2 (multi-tenancy) can bind a different
// implementation (one that resolves a tenant from profileId and scopes every
// query) without any route changes. Every method takes profileId first.
export interface ISettingsService {
  // Guard — mutating Settings operations require setup to be complete.
  assertSetupComplete(profileId: string): Promise<void>;

  // Business Profile
  getBusinessProfile(profileId: string): Promise<BusinessSettings | null>;
  updateBusinessProfile(
    profileId: string,
    input: BusinessProfileUpdateInput
  ): Promise<BusinessSettings>;

  // Round Settings
  getRoundSettings(profileId: string): Promise<BusinessSettings | null>;
  updateRoundSettings(
    profileId: string,
    input: RoundSettingsUpdateInput
  ): Promise<BusinessSettings>;

  // Service Catalogue (per-item)
  getServices(profileId: string): Promise<Service[]>;
  createService(profileId: string, input: ServiceCreateInput): Promise<Service>;
  updateService(
    profileId: string,
    id: string,
    input: ServiceUpdateInput
  ): Promise<Service>;
  deleteService(profileId: string, id: string): Promise<void>;

  // Service Areas (per-item)
  getServiceAreas(profileId: string): Promise<ServiceAreaWithRounds[]>;
  createServiceArea(
    profileId: string,
    input: ServiceAreaCreateInput
  ): Promise<ServiceArea>;
  updateServiceArea(
    profileId: string,
    id: string,
    input: ServiceAreaUpdateInput
  ): Promise<ServiceArea>;
  deleteServiceArea(profileId: string, id: string): Promise<void>;

  // Technician Management (per-item)
  getTechnicians(profileId: string): Promise<TechnicianWithDisplayName[]>;
  createTechnician(
    profileId: string,
    input: TechnicianCreateInput
  ): Promise<Technician>;
  updateTechnician(
    profileId: string,
    id: string,
    input: TechnicianUpdateInput
  ): Promise<Technician>;
  deleteTechnician(profileId: string, id: string): Promise<void>;

  // Payment Setup
  getPaymentSetup(profileId: string): Promise<BusinessSettings | null>;
  updatePaymentRules(
    profileId: string,
    input: PaymentRulesUpdateInput
  ): Promise<BusinessSettings>;
  connectProvider(
    profileId: string,
    provider: "gocardless" | "stripe"
  ): Promise<{ status: string; connectUrl?: string }>;

  // Message Templates (SMS / WhatsApp / Email via Resend)
  getMessageTemplates(profileId: string): Promise<MessageTemplateView[]>;
  createMessageTemplate(profileId: string, input: MessageTemplateInput): Promise<MessageTemplateView>;
  updateMessageTemplate(profileId: string, id: string, input: MessageTemplateUpdateInput): Promise<MessageTemplateView>;
  deleteMessageTemplate(profileId: string, id: string): Promise<void>;
  replaceTemplates(profileId: string, templates: MessageTemplateInput[]): Promise<MessageTemplateView[]>;
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
  gocardlessConnected?: boolean;
  stripeConnected?: boolean;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SettingsService implements ISettingsService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  // ---- singleton seam (the ONLY two methods that know the singleton key) ----

  /** Read the BusinessSettings singleton. */
  private async getSettings(): Promise<BusinessSettings | null> {
    return this.prisma.businessSettings.findFirst();
  }

  /** Partial upsert of the BusinessSettings singleton. Undefined fields are
   *  left unchanged; null clears the field. */
  private async writeSettings(data: SettingsWritable): Promise<BusinessSettings> {
    return this.prisma.businessSettings.upsert({
      where: { uniqueId: "singleton" },
      update: data,
      create: { ...data },
    });
  }

  // ---- guard ----

  /** Mutating Settings endpoints require setup to be complete. Reads the
   *  singleton via the existing getSettings() seam (no extra findUnique). */
  async assertSetupComplete(_profileId: string): Promise<void> {
    const settings = await this.getSettings();
    if (!settings || settings.setupCompleted === false) {
      throw new AppError(
        403,
        "Setup must be completed before editing settings. Complete the Setup Wizard first."
      );
    }
  }

  // ---- Business Profile ----

  async getBusinessProfile(_profileId: string): Promise<BusinessSettings | null> {
    return this.getSettings();
  }

  async updateBusinessProfile(
    _profileId: string,
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
    });
  }

  // ---- Round Settings ----

  async getRoundSettings(_profileId: string): Promise<BusinessSettings | null> {
    return this.getSettings();
  }

  async updateRoundSettings(
    _profileId: string,
    input: RoundSettingsUpdateInput
  ): Promise<BusinessSettings> {
    // Round fields only. defaultCleanMethod / autoGenerateVisits (P1-nice) and
    // preCleanReminder* (P2) are NOT in the schema yet — deliberately omitted.
    return this.writeSettings({
      defaultCycleLength: input.defaultCycleLength,
      defaultWorkingDays: input.defaultWorkingDays,
    });
  }

  // ---- Service Catalogue ----

  async getServices(_profileId: string): Promise<Service[]> {
    return this.prisma.service.findMany({ orderBy: { createdAt: "asc" } });
  }

  async createService(
    _profileId: string,
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
    _profileId: string,
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

  async deleteService(_profileId: string, id: string): Promise<void> {
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

  async getServiceAreas(_profileId: string): Promise<ServiceAreaWithRounds[]> {
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
    _profileId: string,
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
    _profileId: string,
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

  async deleteServiceArea(_profileId: string, id: string): Promise<void> {
    const existing = await this.prisma.serviceArea.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Service area not found");
    const [roundRefs, propertyRefs, techRefs] = await Promise.all([
      this.prisma.round.count({ where: { serviceAreaId: id } }),
      this.prisma.property.count({ where: { serviceAreaId: id, status: LifecycleStatus.ACTIVE } }),
      this.prisma.technicianServiceArea.count({ where: { serviceAreaId: id } }),
    ]);
    if (roundRefs > 0 || propertyRefs > 0 || techRefs > 0) {
      throw new AppError(409, "Service area is in use and cannot be deleted");
    }
    await this.prisma.serviceArea.delete({ where: { id } });
  }

  // ---- Technician Management ----

  async getTechnicians(
    _profileId: string
  ): Promise<TechnicianWithDisplayName[]> {
    const techs = await this.prisma.technician.findMany({
      orderBy: { createdAt: "asc" },
    });
    return techs.map((t) => ({
      ...t,
      // Profile.name resolution is deferred until per-request tenant client is
      // wired (cross-schema lookup required). Use admin label for now.
      displayName: t.name ?? null,
      appStatus:
        t.profileId === null
          ? "PENDING_INVITE"
          : t.active
            ? "ACTIVE"
            : "INACTIVE",
    }));
  }

  async createTechnician(
    _profileId: string,
    input: TechnicianCreateInput
  ): Promise<Technician> {
    // Single invite-pending create (profileId = null) — not the wizard's bulk replace.
    return this.prisma.technician.create({
      data: {
        profileId: null,
        name: input.name ?? null,
        phone: input.phone ?? null,
        role: input.role ?? null,
        active: input.active ?? true,
      },
    });
  }

  async updateTechnician(
    _profileId: string,
    id: string,
    input: TechnicianUpdateInput
  ): Promise<Technician> {
    const existing = await this.prisma.technician.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Technician not found");
    return this.prisma.technician.update({
      where: { id },
      data: {
        name: input.name,
        phone: input.phone,
        role: input.role,
        active: input.active,
      },
    });
  }

  async deleteTechnician(_profileId: string, id: string): Promise<void> {
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

  async getPaymentSetup(_profileId: string): Promise<BusinessSettings | null> {
    return this.getSettings();
  }

  async updatePaymentRules(
    _profileId: string,
    input: PaymentRulesUpdateInput
  ): Promise<BusinessSettings> {
    // Rules only — never touches the gocardless/stripe connect booleans.
    return this.writeSettings({
      paymentRule: input.paymentRule,
      vatInInvoices: input.vatInInvoices,
      debtHoldEnabled: input.debtHoldEnabled,
    });
  }

  async connectProvider(
    _profileId: string,
    provider: "gocardless" | "stripe"
  ): Promise<{ status: string; connectUrl?: string }> {
    // Phase-1 stub: flip the boolean; no OAuth, no URL. The response shape is
    // provider-agnostic and swap-neutral for Phase 2 (where a real connectUrl
    // will come from GHL) — see docs/SETTINGS_API_DESIGN.md §6.1.
    await this.writeSettings(
      provider === "gocardless"
        ? { gocardlessConnected: true }
        : { stripeConnected: true }
    );
    return { status: "connected" };
  }

  // ---- Message Templates ----

  async getMessageTemplates(_profileId: string): Promise<MessageTemplateView[]> {
    const rows = await this.prisma.messageTemplate.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(toTemplateView);
  }

  async createMessageTemplate(
    _profileId: string,
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
    _profileId: string,
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

  async deleteMessageTemplate(_profileId: string, id: string): Promise<void> {
    if (!(await this.prisma.messageTemplate.findUnique({ where: { id } }))) {
      throw new AppError(404, "Message template not found");
    }
    await this.prisma.messageTemplate.delete({ where: { id } });
  }

  async replaceTemplates(
    _profileId: string,
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

export function createSettingsService(prisma: TenantPrismaClient): ISettingsService {
  return new SettingsService(prisma);
}
