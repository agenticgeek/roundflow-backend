import {
  ServiceCategory,
  DayOfWeek,
  CleaningFrequency,
  RoundStatus,
} from "@prisma/client";
import type {
  BusinessSettings,
  Service,
  Technician,
  ServiceArea,
  Round,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
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

export interface ServiceInput {
  name: string;
  category?: string;
  description?: string | null;
  defaultPrice: number;
  active?: boolean;
}

export interface TechnicianInput {
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

  getTechnicians(profileId: string): Promise<Technician[]>;
  createTechnicians(
    profileId: string,
    input: TechnicianInput[]
  ): Promise<Technician[]>;

  getServiceAreas(profileId: string): Promise<ServiceArea[]>;
  createServiceAreas(
    profileId: string,
    input: ServiceAreaInput[]
  ): Promise<ServiceArea[]>;

  getActiveRounds(profileId: string): Promise<Round[]>;
  createFirstRound(profileId: string, input: FirstRoundInput): Promise<Round>;
}

const SINGLETON = { uniqueId: "singleton" } as const;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
//
// NOTE ON `profileId`: every method takes it as the first argument — this is
// the deliberate OCP seam for Phase 2 multi-tenancy. In Phase 1 the business is
// a single tenant, so config lives in the `BusinessSettings` singleton and
// `profileId` is not yet used to scope reads/writes. Phase 2 swaps in an
// implementation that resolves a tenant from `profileId` and scopes every query.
class SetupService implements ISetupService {
  private async getSettings(): Promise<BusinessSettings | null> {
    return prisma.businessSettings.findUnique({ where: SINGLETON });
  }

  async getStatus(_profileId: string): Promise<SetupStatus> {
    const [settings, serviceCount, technicianCount, serviceAreaCount, activeRoundCount] =
      await Promise.all([
        this.getSettings(),
        prisma.service.count(),
        prisma.technician.count(),
        prisma.serviceArea.count(),
        prisma.round.count({ where: { status: RoundStatus.ACTIVE } }),
      ]);

    const step = (n: number, complete: boolean, deferred = false): StepStatus => ({
      step: n,
      complete,
      deferred,
    });

    const steps: StepStatus[] = [
      step(1, settings?.businessName != null), // Business Profile
      step(2, false, true), // Payment Setup — deferred
      step(3, serviceCount > 0), // Service Catalogue
      step(4, settings?.defaultCycleLength != null), // Round Settings
      step(5, false, true), // SMS Templates — deferred
      step(6, technicianCount > 0), // Technicians
      step(7, serviceAreaCount > 0), // Service Areas
      step(8, activeRoundCount > 0), // First Round (ACTIVE)
    ];

    const allRequiredComplete = steps
      .filter((s) => !s.deferred)
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
    await prisma.businessSettings.update({
      where: SINGLETON,
      data: { setupCompleted: true },
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
    return prisma.businessSettings.upsert({
      where: SINGLETON,
      update: data,
      create: { ...SINGLETON, ...data },
    });
  }

  async getBusinessSettings(_profileId: string): Promise<BusinessSettings | null> {
    return this.getSettings();
  }

  async getServices(_profileId: string): Promise<Service[]> {
    return prisma.service.findMany({ orderBy: { createdAt: "asc" } });
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
    return prisma.$transaction(async (tx) => {
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
    return prisma.businessSettings.upsert({
      where: SINGLETON,
      update: data,
      create: { ...SINGLETON, ...data },
    });
  }

  async getTechnicians(_profileId: string): Promise<Technician[]> {
    return prisma.technician.findMany({ orderBy: { createdAt: "asc" } });
  }

  async createTechnicians(
    _profileId: string,
    input: TechnicianInput[]
  ): Promise<Technician[]> {
    // Each technician is invite-pending: profileId = null. Name/email arrive
    // when the invite is accepted (Profile + auth.users), so are not stored here.
    await prisma.technician.createMany({
      data: input.map((t) => ({
        profileId: null,
        role: t.role ?? null,
        phone: t.phone ?? null,
        active: t.active ?? true,
      })),
    });
    return prisma.technician.findMany({ orderBy: { createdAt: "asc" } });
  }

  async getServiceAreas(_profileId: string): Promise<ServiceArea[]> {
    return prisma.serviceArea.findMany({ orderBy: { createdAt: "asc" } });
  }

  async createServiceAreas(
    _profileId: string,
    input: ServiceAreaInput[]
  ): Promise<ServiceArea[]> {
    await prisma.serviceArea.createMany({
      data: input.map((a) => ({
        name: a.name,
        postcodeSector: a.postcodeSector ?? null,
        isDefault: a.isDefault ?? false,
      })),
    });
    return prisma.serviceArea.findMany({ orderBy: { createdAt: "asc" } });
  }

  async getActiveRounds(_profileId: string): Promise<Round[]> {
    return prisma.round.findMany({
      where: { status: RoundStatus.ACTIVE },
      orderBy: { createdAt: "asc" },
    });
  }

  async createFirstRound(
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
      const area = await prisma.serviceArea.findUnique({
        where: { id: input.serviceAreaId },
      });
      if (!area) {
        throw new AppError(400, `serviceAreaId not found: ${input.serviceAreaId}`);
      }
    }
    return prisma.round.create({
      data: {
        name: input.name,
        defaultDay: (input.defaultDay as DayOfWeek) ?? null,
        frequency: (input.frequency as CleaningFrequency) ?? null,
        serviceAreaId: input.serviceAreaId ?? null,
        status: RoundStatus.ACTIVE, // this is the first round → ACTIVE
      },
    });
  }
}

// Single shared instance, exported behind the interface (the swap point).
export const setupService: ISetupService = new SetupService();
