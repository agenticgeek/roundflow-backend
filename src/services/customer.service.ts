import {
  LifecycleStatus,
  VisitStatus,
  PaymentStatus,
  PaymentMethod,
  PhotoType,
  NoteType,
  PropertyType,
  RoundStatus,
  Prisma,
} from "../generated/tenant-client";
import type {
  Customer,
  Property,
  ServicePlan,
  PropertyNote,
  CleaningFrequency,
  PaymentTiming,
} from "../generated/tenant-client";
import { UserRole } from "@prisma/client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

// Human-readable labels for CleaningFrequency values — used when naming
// auto-created rounds in the frequency-change reassignment flow (FR-FREQ-4).
const FREQUENCY_LABELS: Record<CleaningFrequency, string> = {
  FORTNIGHTLY: "Fortnightly",
  FOUR_WEEKLY: "Four Weekly",
  SIX_WEEKLY: "Six Weekly",
  EIGHT_WEEKLY: "Eight Weekly",
  MONTHLY: "Monthly",
};

// ---------------------------------------------------------------------------
// M2 — Customers & Properties (Screens 14 & 15, modals M4/M9/M19/M20).
//
// Same OCP seam as SetupService / SettingsService: routes depend on the
// ICustomerService abstraction, every method is profileId-first. In Phase 1 a
// Customer has exactly ONE active Property; the aggregate reads return that
// property (multi-property navigation is a Phase 2 concern).
// ---------------------------------------------------------------------------

// ---- input types ----------------------------------------------------------

export interface CustomerListFilters {
  search?: string;
  roundId?: string;
  status?: string; // ACTIVE | PAUSED | CANCELLED | HOLD
  page?: number;     // 1-based, default 1
  pageSize?: number; // default 50, max 100
}

export interface CustomerCreateInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  paymentMethod?: PaymentMethod | null;
}

export interface PropertyAddInput {
  addressLine: string;
  postcode: string;
  propertyName?: string | null;
  propertyType?: PropertyType | null;
  serviceAreaId: string;
  serviceId?: string | null;
  price: number;
  cleanMethod?: string | null;
  paymentMethod?: PaymentMethod | null;
  nextDueDate?: Date | null;
  accessNotes?: string | null;
  riskNotes?: string | null;
  roundId?: string | null;
}

export interface PropertyCreateInput {
  customerName: string;
  phone?: string | null;
  email?: string | null;
  addressLine: string;
  postcode: string;
  propertyName?: string | null;
  propertyType?: PropertyType | null;
  serviceAreaId: string;
  serviceId?: string | null;
  price: number;
  cleanMethod?: string | null;
  paymentMethod?: PaymentMethod | null;
  nextDueDate?: Date | null;
  accessNotes?: string | null;
  riskNotes?: string | null;
  roundId?: string | null;
}

export interface PropertyUpdateInput {
  addressLine?: string;
  postcode?: string;
  propertyName?: string | null;
  propertyType?: PropertyType | null;
  serviceAreaId?: string | null;
  accessNotes?: string | null;
  riskNotes?: string | null;
  roundId?: string | null;
  cleaningFrequency?: CleaningFrequency | null;
}

export interface CustomerUpdateInput {
  // Customer
  name?: string;
  phone?: string | null;
  email?: string | null;
  // Property
  addressLine?: string;
  postcode?: string;
  propertyType?: PropertyType | null;
  accessNotes?: string | null;
  riskNotes?: string | null;
  roundId?: string | null;
  // ServicePlan
  price?: number;
  cleanMethod?: string | null;
  paymentMethod?: PaymentMethod | null;
}

export interface PauseInput {
  pauseStartDate: Date;
  pauseEndDate?: Date | null;
}

export interface NoteCreateInput {
  type: NoteType;
  body: string;
  authorProfileId: string | null;
}

// ---- output types ---------------------------------------------------------

export interface CustomerListRow {
  customerId: string;
  customerName: string;
  status: LifecycleStatus;
  propertyId: string;
  addressLine: string;
  postcode: string;
  roundId: string | null;
  roundName: string | null;
  frequency: CleaningFrequency | null;
  price: number | null;
  technicianId: string | null;
  technicianName: string | null;
  nextDueDate: Date | null;
  paymentStatus: string;
  onHold: boolean;
  amountDue?: number; // financial — omitted for TECHNICIAN viewers
}

export interface CustomerListResult {
  summary: {
    totalCustomers: number;
    active: number;
    paymentHolds: number;
    amountDue?: number; // financial — omitted for TECHNICIAN viewers
  };
  customers: CustomerListRow[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;       // total matching the applied filters
    totalPages: number;
  };
}

export interface ServicePlanView {
  id: string;
  serviceId: string | null;
  serviceName: string | null;
  price: number | null;
  cleanMethod: string | null;
  paymentMethod: PaymentMethod | null;
  cleaningFrequency: CleaningFrequency | null;
  status: LifecycleStatus;
  nextDueDate: Date | null;
  lastCompleted: Date | null;
  pauseStartDate: Date | null;
  pauseEndDate: Date | null;
  paymentRule: PaymentTiming | null;
}

export interface PaymentRow {
  visitId: string;
  visitDate: Date;
  technicianName: string | null;
  amount: number | null;
  paymentStatus: PaymentStatus | null;
  paymentId: string | null;
  invoiceStatus: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  transactionId: string | null;
  canGenerate: boolean;
  canDownload: boolean;
}

export interface VisitHistoryRow {
  visitId: string;
  date: Date;
  roundName: string | null;
  status: VisitStatus;
  paymentStatus: PaymentStatus | null;
  notes: string | null;
}

export interface CustomerDetail {
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    status: LifecycleStatus;
    ghlContactId: string | null;
  };
  property: {
    id: string;
    addressLine: string;
    postcode: string;
    propertyType: string | null;
    accessNotes: string | null;
    riskNotes: string | null;
    status: LifecycleStatus;
    roundId: string | null;
    roundName: string | null;
    serviceAreaId: string | null;
  } | null;
  servicePlan: ServicePlanView | null;
  standingInfo: {
    frequency: CleaningFrequency | null;
    assignedRound: string | null;
    technicianName: string | null;
    paymentStatus: string;
    outstandingBalance?: number; // financial — omitted for TECHNICIAN viewers
    lastPaymentDate: Date | null;
    issuesCount: number;
    nextVisitStatus: VisitStatus | null;
  };
  tabs: {
    overview: {
      addressLine: string;
      postcode: string;
      propertyType: string | null;
      accessNotes: string | null;
      riskNotes: string | null;
      contact: { name: string; phone: string | null; email: string | null };
    } | null;
    servicePlan: ServicePlanView | null;
    visitHistory: VisitHistoryRow[];
    payments?: { rows: PaymentRow[] }; // full payment history + transaction ids — omitted for TECHNICIAN viewers
    notes: Array<PropertyNote & { authorName: string | null }>;
    photos: unknown[];
  };
}

// ---- contract -------------------------------------------------------------

export interface ICustomerService {
  getCustomers(
    profileId: string,
    filters: CustomerListFilters,
    viewerRole: UserRole
  ): Promise<CustomerListResult>;
  getCustomerDetail(
    profileId: string,
    customerId: string,
    viewerRole: UserRole
  ): Promise<CustomerDetail>;
  createCustomer(profileId: string, input: CustomerCreateInput): Promise<Customer>;
  updateCustomer(
    profileId: string,
    customerId: string,
    input: CustomerUpdateInput
  ): Promise<{ customerId: string; propertyId: string | null; servicePlanId: string | null }>;
  deleteCustomer(profileId: string, customerId: string): Promise<void>;

  createProperty(
    profileId: string,
    input: PropertyCreateInput
  ): Promise<{ customerId: string; propertyId: string; servicePlanId: string; assigned: boolean }>;
  addPropertyToCustomer(
    profileId: string,
    customerId: string,
    input: PropertyAddInput
  ): Promise<{ propertyId: string; servicePlanId: string; assigned: boolean }>;
  updateProperty(
    profileId: string,
    propertyId: string,
    input: PropertyUpdateInput
  ): Promise<Property>;
  deleteProperty(profileId: string, propertyId: string): Promise<void>;
  pauseService(profileId: string, propertyId: string, input: PauseInput): Promise<ServicePlan>;
  resumeService(profileId: string, propertyId: string): Promise<ServicePlan>;
  getNotes(profileId: string, propertyId: string): Promise<PropertyNote[]>;
  addNote(profileId: string, propertyId: string, input: NoteCreateInput): Promise<PropertyNote>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const OPEN_VISIT: VisitStatus[] = [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS];
const DUE_PAYMENT: PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.OVERDUE,
  PaymentStatus.FAILED,
];

class CustomerService implements ICustomerService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  /** Decimal | number | null → number | null. */
  private num(d: Prisma.Decimal | number | null | undefined): number | null {
    return d == null ? null : Number(d);
  }

  /** Derive the badge string shown on the list/detail. */
  private derivePaymentStatus(
    onHold: boolean,
    latest: PaymentStatus | null | undefined
  ): string {
    if (onHold) return "hold";
    switch (latest) {
      case PaymentStatus.PAID:
        return "paid";
      case PaymentStatus.PENDING:
        return "pending";
      case PaymentStatus.OVERDUE:
        return "overdue";
      case PaymentStatus.FAILED:
        return "failed";
      default:
        return "none"; // NOT_DUE / no payment history → render blank/dash, not a Paid badge
    }
  }

  // ---- list ----

  async getCustomers(
    _profileId: string,
    filters: CustomerListFilters,
    viewerRole: UserRole
  ): Promise<CustomerListResult> {
    const hideFinancials = viewerRole === UserRole.TECHNICIAN;
    const { search, roundId, status } = filters;
    if (status && !["ACTIVE", "PAUSED", "CANCELLED", "HOLD"].includes(status)) {
      throw new AppError(400, `Invalid status: ${status}. Use ACTIVE|PAUSED|CANCELLED|HOLD.`);
    }

    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 50));
    const skip = (page - 1) * pageSize;

    const where: Prisma.CustomerWhereInput = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { properties: { some: { addressLine: { contains: search, mode: "insensitive" } } } },
        { properties: { some: { postcode: { contains: search, mode: "insensitive" } } } },
      ];
    }
    if (roundId) where.properties = { some: { roundId } };
    if (status && status !== "HOLD") where.status = status as LifecycleStatus;

    // Summary KPIs are always business-wide — never filtered or paginated.
    const [totalCustomers, active, paymentHolds, dueAgg] = await Promise.all([
      this.prisma.customer.count(),
      this.prisma.customer.count({
        where: {
          status: LifecycleStatus.ACTIVE,
          NOT: {
            properties: {
              some: { visits: { some: { paymentHold: true, status: { in: OPEN_VISIT } } } },
            },
          },
        },
      }),
      this.prisma.customer.count({
        where: {
          properties: { some: { visits: { some: { paymentHold: true, status: { in: OPEN_VISIT } } } } },
        },
      }),
      this.prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: { in: DUE_PAYMENT }, customer: { status: LifecycleStatus.ACTIVE } },
      }),
    ]);

    // Shared include for both list paths.
    const listInclude = {
      payments: { orderBy: { createdAt: "desc" as const } },
      properties: {
        orderBy: { createdAt: "asc" as const },
        include: {
          round: true,
          servicePlans: { orderBy: { createdAt: "desc" as const } },
          visits: {
            where: { status: { in: OPEN_VISIT } },
            orderBy: { date: "asc" as const },
            include: { technician: true },
          },
        },
      },
    } satisfies Prisma.CustomerInclude;

    type FetchedCustomer = Prisma.CustomerGetPayload<{ include: typeof listInclude }>;

    const toRow = (c: FetchedCustomer): CustomerListRow | null => {
      const property =
        c.properties.find((p) => p.status === LifecycleStatus.ACTIVE) ?? c.properties[0];
      if (!property) return null;

      const plan =
        property.servicePlans.find((p) => p.status === LifecycleStatus.ACTIVE) ??
        property.servicePlans[0] ??
        null;
      const nextVisit = property.visits[0] ?? null;
      const onHold = property.visits.some((v) => v.paymentHold);
      const amountDue = Number(
        c.payments
          .filter((p) => DUE_PAYMENT.includes(p.status))
          .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0))
      );

      return {
        customerId: c.id,
        customerName: c.name,
        status: c.status,
        propertyId: property.id,
        addressLine: property.addressLine,
        postcode: property.postcode,
        roundId: property.roundId,
        roundName: property.round?.name ?? null,
        frequency: plan?.cleaningFrequency ?? property.round?.frequency ?? null,
        price: this.num(plan?.price),
        technicianId: nextVisit?.technicianId ?? null,
        technicianName: nextVisit?.technician?.name ?? null,
        nextDueDate: plan?.nextDueDate ?? null,
        paymentStatus: this.derivePaymentStatus(onHold, c.payments[0]?.status),
        onHold,
        amountDue: hideFinancials ? undefined : amountDue,
      };
    };

    let rows: CustomerListRow[];
    let total: number;

    if (status === "HOLD") {
      // HOLD is a derived filter (paymentHold lives on Visit, not Customer).
      // Must fetch all matching customers, filter in memory, then slice.
      const all = await this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: "asc" },
        include: listInclude,
      });
      const held = all.map(toRow).filter((r): r is CustomerListRow => r !== null && r.onHold);
      total = held.length;
      rows = held.slice(skip, skip + pageSize);
    } else {
      // DB-level pagination for all other filters.
      const [count, customers] = await Promise.all([
        this.prisma.customer.count({ where }),
        this.prisma.customer.findMany({
          where,
          orderBy: { createdAt: "asc" },
          take: pageSize,
          skip,
          include: listInclude,
        }),
      ]);
      total = count;
      rows = customers.map(toRow).filter((r): r is CustomerListRow => r !== null);
    }

    return {
      summary: {
        totalCustomers,
        active,
        paymentHolds,
        amountDue: hideFinancials ? undefined : Number(dueAgg._sum.amount ?? 0),
      },
      customers: rows,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  // ---- detail aggregate ----

  async getCustomerDetail(
    _profileId: string,
    customerId: string,
    viewerRole: UserRole
  ): Promise<CustomerDetail> {
    // TECHNICIAN viewers must not see financial data (debt + processor ids).
    const hideFinancials = viewerRole === UserRole.TECHNICIAN;
    const [customer, settings] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { id: customerId },
        include: {
          payments: { orderBy: { createdAt: "desc" } },
          properties: {
            orderBy: { createdAt: "asc" },
            include: {
              round: true,
              serviceArea: true,
              servicePlans: { orderBy: { createdAt: "desc" }, include: { service: true } },
              notes: { orderBy: { createdAt: "desc" } },
              photos: { where: { type: PhotoType.PROPERTY }, orderBy: { createdAt: "desc" } },
              visits: {
                orderBy: { date: "desc" },
                include: {
                  round: true,
                  technician: true,
                  invoice: true,
                  payment: true,
                  issues: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.businessSettings.findFirst(),
    ]);
    if (!customer) throw new AppError(404, "Customer not found");

    // Phase 1: one active property per customer.
    const property =
      customer.properties.find((p) => p.status === LifecycleStatus.ACTIVE) ??
      customer.properties[0] ??
      null;
    const plan = property
      ? property.servicePlans.find((p) => p.status === LifecycleStatus.ACTIVE) ??
        property.servicePlans[0] ??
        null
      : null;

    const paymentRule = settings?.paymentRule ?? null;

    const servicePlanView: ServicePlanView | null = plan
      ? {
          id: plan.id,
          serviceId: plan.serviceId,
          serviceName: plan.service?.name ?? null,
          price: this.num(plan.price),
          cleanMethod: plan.cleanMethod,
          paymentMethod: plan.paymentMethod,
          cleaningFrequency: plan.cleaningFrequency,
          status: plan.status,
          nextDueDate: plan.nextDueDate,
          lastCompleted: plan.lastCompleted,
          pauseStartDate: plan.pauseStartDate,
          pauseEndDate: plan.pauseEndDate,
          paymentRule,
        }
      : null;

    const visits = property?.visits ?? [];
    const scheduled = visits
      .filter((v) => OPEN_VISIT.includes(v.status))
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const nextScheduled = scheduled[0] ?? null;
    const onHold = visits.some((v) => v.paymentHold && OPEN_VISIT.includes(v.status));

    const outstandingBalance = Number(
      customer.payments
        .filter((p) => DUE_PAYMENT.includes(p.status))
        .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0))
    );
    const lastPaymentDate =
      customer.payments
        .filter((p) => p.paidAt != null)
        .map((p) => p.paidAt as Date)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const issuesCount = visits.reduce((n, v) => n + v.issues.length, 0);
    const technicianName =
      nextScheduled?.technician?.name ?? null;

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        status: customer.status,
        ghlContactId: customer.ghlContactId,
      },
      property: property
        ? {
            id: property.id,
            addressLine: property.addressLine,
            postcode: property.postcode,
            propertyType: property.propertyType,
            accessNotes: property.accessNotes,
            riskNotes: property.riskNotes,
            status: property.status,
            roundId: property.roundId,
            roundName: property.round?.name ?? null,
            serviceAreaId: property.serviceAreaId,
          }
        : null,
      servicePlan: servicePlanView,
      standingInfo: {
        frequency: plan?.cleaningFrequency ?? property?.round?.frequency ?? null,
        assignedRound: property?.round?.name ?? null,
        technicianName,
        paymentStatus: this.derivePaymentStatus(onHold, customer.payments[0]?.status),
        outstandingBalance: hideFinancials ? undefined : outstandingBalance,
        lastPaymentDate,
        issuesCount,
        nextVisitStatus: nextScheduled?.status ?? null,
      },
      tabs: {
        overview: property
          ? {
              addressLine: property.addressLine,
              postcode: property.postcode,
              propertyType: property.propertyType,
              accessNotes: property.accessNotes,
              riskNotes: property.riskNotes,
              contact: { name: customer.name, phone: customer.phone, email: customer.email },
            }
          : null,
        servicePlan: servicePlanView,
        visitHistory: visits.slice(0, 50).map((v) => ({
          visitId: v.id,
          date: v.date,
          roundName: v.round?.name ?? null,
          status: v.status,
          paymentStatus: v.payment?.status ?? null,
          notes: v.notes,
        })),
        payments: hideFinancials
          ? undefined
          : {
              rows: visits.slice(0, 50).map((v) => ({
                visitId: v.id,
                visitDate: v.date,
                technicianName: v.technician?.name ?? null,
                amount: this.num(v.payment?.amount ?? v.price),
                paymentStatus: v.payment?.status ?? null,
                paymentId: v.payment?.id ?? null,
                invoiceStatus: v.invoice?.status ?? null,
                invoiceId: v.invoice?.id ?? null,
                invoiceNumber: v.invoice?.invoiceNumber ?? null,
                transactionId: v.payment?.gocardlessId ?? v.payment?.stripeId ?? null,
                canGenerate: v.status === VisitStatus.COMPLETED && v.invoice == null,
                canDownload: v.invoice != null,
              })),
            },
        notes: (property?.notes ?? []).map((n) => ({
          ...n,
          authorName: null, // cross-schema: Profile.name resolved via public client in future step
        })),
        photos: property?.photos ?? [],
      },
    };
  }

  // ---- create standalone customer ----

  async createCustomer(_profileId: string, input: CustomerCreateInput): Promise<Customer> {
    return this.prisma.customer.create({
      data: {
        name: input.name,
        phone: input.phone ?? null,
        email: input.email ?? null,
        paymentMethod: input.paymentMethod ?? null,
        status: LifecycleStatus.ACTIVE,
      },
    });
  }

  // ---- M19: edit customer (Customer + Property + ServicePlan, atomic) ----

  async updateCustomer(
    _profileId: string,
    customerId: string,
    input: CustomerUpdateInput
  ): Promise<{ customerId: string; propertyId: string | null; servicePlanId: string | null }> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        properties: {
          orderBy: { createdAt: "asc" },
          include: { servicePlans: { orderBy: { createdAt: "desc" } } },
        },
      },
    });
    if (!customer) throw new AppError(404, "Customer not found");

    const property =
      customer.properties.find((p) => p.status === LifecycleStatus.ACTIVE) ??
      customer.properties[0] ??
      null;
    const plan = property
      ? property.servicePlans.find((p) => p.status === LifecycleStatus.ACTIVE) ??
        property.servicePlans[0] ??
        null
      : null;

    // FR-FREQ-1: when switching rounds, sync service plan frequency to the new
    // round's cadence. Unassigning (null) clears it; undefined = no change.
    let roundFrequency: CleaningFrequency | null | undefined = undefined;
    if (input.roundId !== undefined) {
      if (input.roundId === null) {
        roundFrequency = null; // unassigning — clear the inherited frequency
      } else {
        const round = await this.prisma.round.findUnique({ where: { id: input.roundId } });
        if (!round) throw new AppError(404, `Round not found: ${input.roundId}`);
        roundFrequency = round.frequency ?? null;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Build data objects only with defined fields so Prisma skips unchanged columns.
      const customerData: Partial<Prisma.CustomerUpdateInput> = {};
      if (input.name !== undefined) customerData.name = input.name;
      if (input.phone !== undefined) customerData.phone = input.phone;
      if (input.email !== undefined) customerData.email = input.email;
      if (Object.keys(customerData).length > 0) {
        await tx.customer.update({ where: { id: customer.id }, data: customerData });
      }

      if (property) {
        const propertyData: Partial<Prisma.PropertyUpdateInput> = {};
        if (input.addressLine !== undefined) propertyData.addressLine = input.addressLine;
        if (input.postcode !== undefined) propertyData.postcode = input.postcode;
        if (input.propertyType !== undefined) propertyData.propertyType = input.propertyType ?? null;
        if (input.accessNotes !== undefined) propertyData.accessNotes = input.accessNotes;
        if (input.riskNotes !== undefined) propertyData.riskNotes = input.riskNotes;
        if (input.roundId !== undefined) {
          propertyData.round = input.roundId === null
            ? { disconnect: true }
            : { connect: { id: input.roundId } };
        }
        if (Object.keys(propertyData).length > 0) {
          await tx.property.update({ where: { id: property.id }, data: propertyData });
        }
      }

      if (plan) {
        const planData: Partial<Prisma.ServicePlanUpdateInput> = {};
        if (input.price !== undefined) planData.price = input.price;
        if (input.cleanMethod !== undefined) planData.cleanMethod = input.cleanMethod;
        if (input.paymentMethod !== undefined) planData.paymentMethod = input.paymentMethod;
        if (roundFrequency !== undefined) planData.cleaningFrequency = roundFrequency;
        if (Object.keys(planData).length > 0) {
          await tx.servicePlan.update({ where: { id: plan.id }, data: planData });
        }
      }

      return {
        customerId: customer.id,
        propertyId: property?.id ?? null,
        servicePlanId: plan?.id ?? null,
      };
    });
  }

  // ---- soft-delete customer (CANCELLED + cascades to properties + plans) ----

  async deleteCustomer(_profileId: string, customerId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
      if (!c) throw new AppError(404, "Customer not found");
      const propertyIds = (
        await tx.property.findMany({ where: { customerId }, select: { id: true } })
      ).map((p) => p.id);
      if (propertyIds.length > 0) {
        await tx.visit.updateMany({
          where: { propertyId: { in: propertyIds }, status: { in: [...OPEN_VISIT] } },
          data: { status: VisitStatus.SKIPPED },
        });
        await tx.servicePlan.updateMany({
          where: { propertyId: { in: propertyIds }, status: { not: LifecycleStatus.CANCELLED } },
          data: { status: LifecycleStatus.CANCELLED },
        });
        await tx.property.updateMany({
          where: { id: { in: propertyIds } },
          data: { status: LifecycleStatus.CANCELLED },
        });
      }
      await tx.customer.update({
        where: { id: customerId },
        data: { status: LifecycleStatus.CANCELLED },
      });
    });
  }

  // ---- M6: create property (Customer + Property + ServicePlan, atomic) ----

  // Private helper shared by createProperty and addPropertyToCustomer.
  // FR-FREQ-1 round frequency lookup is done by the caller before the transaction.
  private async resolveRoundFrequency(roundId: string | null | undefined): Promise<CleaningFrequency | null> {
    if (!roundId) return null;
    const round = await this.prisma.round.findUnique({ where: { id: roundId } });
    if (!round) throw new AppError(404, `Round not found: ${roundId}`);
    return round.frequency;
  }

  private async createPropertyAndPlan(
    tx: Parameters<Parameters<TenantPrismaClient["$transaction"]>[0]>[0],
    customerId: string,
    input: PropertyAddInput,
    roundFrequency: CleaningFrequency | null
  ): Promise<{ propertyId: string; servicePlanId: string }> {
    const property = await tx.property.create({
      data: {
        customerId,
        addressLine: input.addressLine,
        postcode: input.postcode,
        propertyName: input.propertyName ?? null,
        propertyType: input.propertyType ?? null,
        serviceAreaId: input.serviceAreaId,
        accessNotes: input.accessNotes ?? null,
        riskNotes: input.riskNotes ?? null,
        roundId: input.roundId ?? null,
        status: LifecycleStatus.ACTIVE,
      },
    });
    const plan = await tx.servicePlan.create({
      data: {
        propertyId: property.id,
        serviceId: input.serviceId ?? null,
        price: input.price,
        cleanMethod: input.cleanMethod ?? null,
        paymentMethod: input.paymentMethod ?? null,
        nextDueDate: input.nextDueDate ?? null,
        cleaningFrequency: roundFrequency,
        status: LifecycleStatus.ACTIVE,
      },
    });
    return { propertyId: property.id, servicePlanId: plan.id };
  }

  async createProperty(
    _profileId: string,
    input: PropertyCreateInput
  ): Promise<{ customerId: string; propertyId: string; servicePlanId: string; assigned: boolean }> {
    const roundFrequency = await this.resolveRoundFrequency(input.roundId);
    await this.assertServiceAreaExists(input.serviceAreaId);

    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          name: input.customerName,
          phone: input.phone ?? null,
          email: input.email ?? null,
          paymentMethod: input.paymentMethod ?? null,
          status: LifecycleStatus.ACTIVE,
        },
      });
      const { propertyId, servicePlanId } = await this.createPropertyAndPlan(
        tx, customer.id, input, roundFrequency
      );
      return { customerId: customer.id, propertyId, servicePlanId, assigned: input.roundId != null };
    });
  }

  // ---- add property to existing customer (Property + ServicePlan, atomic) ----

  async addPropertyToCustomer(
    _profileId: string,
    customerId: string,
    input: PropertyAddInput
  ): Promise<{ propertyId: string; servicePlanId: string; assigned: boolean }> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new AppError(404, "Customer not found");
    if (customer.status === LifecycleStatus.CANCELLED) {
      throw new AppError(409, "Cannot add a property to a cancelled customer");
    }
    const roundFrequency = await this.resolveRoundFrequency(input.roundId);
    await this.assertServiceAreaExists(input.serviceAreaId);

    return this.prisma.$transaction(async (tx) => {
      const { propertyId, servicePlanId } = await this.createPropertyAndPlan(
        tx, customerId, input, roundFrequency
      );
      return { propertyId, servicePlanId, assigned: input.roundId != null };
    });
  }

  // ---- soft-delete property (CANCELLED + cancels active service plans) ----

  async deleteProperty(_profileId: string, propertyId: string): Promise<void> {
    await this.assertPropertyExists(propertyId);
    await this.prisma.$transaction(async (tx) => {
      await tx.visit.updateMany({
        where: { propertyId, status: { in: [...OPEN_VISIT] } },
        data: { status: VisitStatus.SKIPPED },
      });
      await tx.servicePlan.updateMany({
        where: { propertyId, status: { not: LifecycleStatus.CANCELLED } },
        data: { status: LifecycleStatus.CANCELLED },
      });
      await tx.property.update({
        where: { id: propertyId },
        data: { status: LifecycleStatus.CANCELLED },
      });
    });
  }

  async updateProperty(
    _profileId: string,
    propertyId: string,
    input: PropertyUpdateInput
  ): Promise<Property> {
    const existing = await this.prisma.property.findUnique({
      where: { id: propertyId },
      include: {
        round: { include: { roundTechnicians: true } },
        servicePlans: {
          where: { status: { not: LifecycleStatus.CANCELLED } },
          orderBy: { createdAt: "desc" as const },
        },
      },
    });
    if (!existing) throw new AppError(404, "Property not found");

    const plan =
      existing.servicePlans.find(
        (p) => p.status === LifecycleStatus.ACTIVE || p.status === LifecycleStatus.PAUSED
      ) ?? existing.servicePlans[0] ?? null;

    if (input.serviceAreaId) await this.assertServiceAreaExists(input.serviceAreaId);

    // Determine the target round and whether the service plan frequency needs updating.
    let targetRoundId: string | null = existing.roundId;
    let newFrequency: CleaningFrequency | null | undefined = undefined; // undefined = no plan update
    let caseB = false; // FR-FREQ-4: must create a new round inside the transaction

    if (input.roundId !== undefined) {
      // Explicit round assignment / unassignment (FR-FREQ-1)
      if (input.roundId === null) {
        targetRoundId = null;
      } else {
        const round = await this.prisma.round.findUnique({ where: { id: input.roundId } });
        if (!round) throw new AppError(404, `Round not found: ${input.roundId}`);
        targetRoundId = round.id;
        if (round.frequency) newFrequency = round.frequency;
      }
    } else if (input.cleaningFrequency !== undefined) {
      // Frequency change (FR-FREQ-2..6) — mutually exclusive with explicit roundId.
      newFrequency = input.cleaningFrequency;
      if (existing.roundId && !existing.serviceAreaId) {
        throw new AppError(409, "Property has no service area; cannot auto-reassign round on frequency change");
      } else if (!existing.roundId) {
        // FR-FREQ-5: no round assigned — just update the plan field, no round change.
      } else if (existing.round?.frequency === input.cleaningFrequency) {
        // FR-FREQ-6: frequency matches current round — just update the plan field.
      } else {
        // FR-FREQ-2: frequency differs from current round → find or create a matching round.
        const matchingRound = await this.prisma.round.findFirst({
          where: {
            frequency: input.cleaningFrequency,
            serviceAreaId: existing.serviceAreaId,
            status: RoundStatus.ACTIVE,
            NOT: { id: existing.roundId },
          },
        });
        if (matchingRound) {
          targetRoundId = matchingRound.id; // FR-FREQ-3 (Case A): reuse existing round
        } else {
          caseB = true; // FR-FREQ-4 (Case B): create new round in the transaction below
        }
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (caseB && existing.round) {
        // FR-FREQ-4: create a new round by copying the current one with the new frequency.
        const label = FREQUENCY_LABELS[input.cleaningFrequency!];
        const baseName = `${existing.round.name} (${label})`;
        // Ensure the generated name is unique — a round with this name may already exist.
        const nameConflict = await tx.round.findFirst({
          where: { name: baseName, serviceAreaId: existing.round.serviceAreaId },
          select: { id: true },
        });
        const roundName = nameConflict ? `${baseName} 2` : baseName;
        const newRound = await tx.round.create({
          data: {
            name: roundName,
            frequency: input.cleaningFrequency!,
            serviceAreaId: existing.round.serviceAreaId,
            defaultDay: existing.round.defaultDay,
            status: RoundStatus.ACTIVE,
          },
        });
        if (existing.round.roundTechnicians.length > 0) {
          await tx.roundTechnician.createMany({
            data: existing.round.roundTechnicians.map((rt) => ({
              roundId: newRound.id,
              technicianId: rt.technicianId,
            })),
          });
        }
        targetRoundId = newRound.id;
      }

      if (plan && newFrequency !== undefined) {
        await tx.servicePlan.update({
          where: { id: plan.id },
          data: { cleaningFrequency: newFrequency },
        });
      }

      return tx.property.update({
        where: { id: propertyId },
        data: {
          addressLine: input.addressLine,
          postcode: input.postcode,
          propertyName: input.propertyName,
          propertyType: input.propertyType ?? undefined,
          serviceAreaId: input.serviceAreaId,
          accessNotes: input.accessNotes,
          riskNotes: input.riskNotes,
          roundId: targetRoundId,
        },
      });
    });
  }

  // ---- M9: pause / resume ----

  async pauseService(
    _profileId: string,
    propertyId: string,
    input: PauseInput
  ): Promise<ServicePlan> {
    const plan = await this.primaryPlan(propertyId);
    if (plan.status === LifecycleStatus.PAUSED) {
      throw new AppError(409, "Service plan is already paused");
    }
    return this.prisma.servicePlan.update({
      where: { id: plan.id },
      data: {
        status: LifecycleStatus.PAUSED,
        pauseStartDate: input.pauseStartDate,
        pauseEndDate: input.pauseEndDate ?? null,
      },
    });
  }

  async resumeService(_profileId: string, propertyId: string): Promise<ServicePlan> {
    const plan = await this.primaryPlan(propertyId);
    if (plan.status !== LifecycleStatus.PAUSED) {
      throw new AppError(409, "Service plan is not paused");
    }
    return this.prisma.servicePlan.update({
      where: { id: plan.id },
      data: {
        status: LifecycleStatus.ACTIVE,
        pauseStartDate: null,
        pauseEndDate: null,
      },
    });
  }

  // ---- M20: notes ----

  async getNotes(_profileId: string, propertyId: string): Promise<PropertyNote[]> {
    await this.assertPropertyExists(propertyId);
    return this.prisma.propertyNote.findMany({
      where: { propertyId },
      orderBy: { createdAt: "desc" },
    });
  }

  async addNote(
    _profileId: string,
    propertyId: string,
    input: NoteCreateInput
  ): Promise<PropertyNote> {
    await this.assertPropertyExists(propertyId);
    return this.prisma.propertyNote.create({
      data: {
        propertyId,
        type: input.type,
        body: input.body,
        authorProfileId: input.authorProfileId,
      },
    });
  }

  // ---- shared guards ----

private async assertServiceAreaExists(id: string): Promise<void> {
    if (!(await this.prisma.serviceArea.findUnique({ where: { id } }))) {
      throw new AppError(404, `Service area not found: ${id}`);
    }
  }
  private async assertPropertyExists(id: string): Promise<void> {
    if (!(await this.prisma.property.findUnique({ where: { id } }))) {
      throw new AppError(404, "Property not found");
    }
  }
  /** The property's primary service plan (active, else most recent). 404 if none. */
  private async primaryPlan(propertyId: string): Promise<ServicePlan> {
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      include: { servicePlans: { orderBy: { createdAt: "desc" } } },
    });
    if (!property) throw new AppError(404, "Property not found");
    const plan =
      property.servicePlans.find(
        (p) => p.status === LifecycleStatus.ACTIVE || p.status === LifecycleStatus.PAUSED
      ) ?? property.servicePlans[0];
    if (!plan) throw new AppError(404, "Property has no service plan");
    return plan;
  }
}

export function createCustomerService(prisma: TenantPrismaClient): ICustomerService {
  return new CustomerService(prisma);
}
