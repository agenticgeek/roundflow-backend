import {
  InvoiceStatus,
  LifecycleStatus,
  VisitStatus,
  PaymentStatus,
  PaymentMethod,
  PhotoType,
  NoteType,
  PropertyType,
  CleaningFrequency,
  Prisma,
} from "../generated/tenant-client";
import type {
  Customer,
  Property,
  ServicePlan,
  PropertyNote,
  DayOfWeek,
  PaymentTiming,
} from "../generated/tenant-client";
import { UserRole } from "@prisma/client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { getCachedBusinessSettings } from "./settings.service";
import { geocodePostcode } from "../integrations/geocoding/client";
import { initialNextDueDate } from "../lib/schedule";
import {
  deriveCustomerPaymentStatus,
  invoiceAmountDue,
  type CustomerPaymentStatus,
} from "./customer-payment-status";
import {
  pausePlan,
  resumePlan,
  updatePlan,
  type PauseResult,
  type PlanUpdateResult,
} from "./service-plan-lifecycle";

// Fire-and-forget: geocodes `postcode` and writes the result onto the
// property. Never thrown by the caller — always chained with
// `.catch(console.error)` so a slow/broken geocoding provider never delays
// or fails the request that created/edited the property. A failed or
// not-found lookup just bumps `geocodeAttempts`; `geocodeBackfill.ts` retries
// it later. Called with `this.prisma` (never a transaction client) and only
// after the triggering transaction has committed.
async function triggerGeocode(tp: TenantPrismaClient, propertyId: string, postcode: string): Promise<void> {
  let coords: { latitude: number; longitude: number } | null = null;
  let error: string | null = null;
  try {
    coords = await geocodePostcode(postcode);
    if (!coords) error = "postcode not found";
  } catch (err) {
    error = String(err);
  }

  await tp.property.update({
    where: { id: propertyId },
    data: coords
      ? { latitude: coords.latitude, longitude: coords.longitude, geocodedAt: new Date(), geocodeError: null }
      : { geocodeAttempts: { increment: 1 }, geocodeError: error },
  });
}

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
  // A2: when nextDueDate is omitted it is derived from this (last clean + one
  // cycle, snapped to the round day) or, without it, the round's next day.
  lastCleanedDate?: Date | null;
  accessNotes?: string | null;
  riskNotes?: string | null;
  roundId?: string | null;
}

export interface PropertyCreateInput {
  customerName: string;
  phone?: string | null;
  landline?: string | null;
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
  lastCleanedDate?: Date | null;
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
  // B3: with cleaningFrequency, create "<Area> <Day> <N>wk" when no matching round exists (else 409).
  createRoundIfMissing?: boolean;
}

export type PropertyUpdateResult = Property & { movedToRound: PlanUpdateResult["movedToRound"] };

export interface CustomerUpdateInput {
  // Customer
  name?: string;
  phone?: string | null;
  landline?: string | null;
  email?: string | null;
  messagesOptOut?: boolean; // opt out of automated messages (reminders, visit-completed)
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

// Per-plan write — unlike CustomerUpdateInput/PropertyUpdateInput (which
// always resolve to the property's "primary" plan via primaryPlan()), this
// targets one specific ServicePlan by its own id, so a property with 2+
// plans can have each one edited independently.
export interface ServicePlanUpdateInput {
  price?: number;
  cleanMethod?: string | null;
  paymentMethod?: PaymentMethod | null;
  cleaningFrequency?: CleaningFrequency | null;
  // B3: create "<Area> <Day> <N>wk" when no matching round exists (else 409).
  createRoundIfMissing?: boolean;
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
  latitude: number | null;
  longitude: number | null;
  roundId: string | null;
  roundName: string | null;
  frequency: CleaningFrequency | null;
  price: number | null;
  technicianId: string | null;
  technicianName: string | null;
  nextDueDate: Date | null;
  // GAP-021: plan nextDueDate, else the next open visit's date.
  nextDue: Date | null;
  paymentStatus: CustomerPaymentStatus;
  onHold: boolean;
  badDebt: boolean;
  amountDue?: number; // unpaid SENT invoice totals — omitted for TECHNICIAN viewers
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
  // True for the one plan that property/customer-level writes (Edit Customer,
  // Change Frequency, Pause/Resume) currently target — see primaryPlan().
  // Lets the frontend stop guessing which plan a property-level write affects
  // until per-plan write endpoints exist.
  isPrimary: boolean;
}

export interface PaymentRow {
  visitId: string;
  visitDate: Date;
  technicianName: string | null;
  amount: number | null;
  paymentStatus: PaymentStatus | null;
  paymentId: string | null;
  method: PaymentMethod | null;
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
  cancelReason: string | null;
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
    badDebt: boolean;
  };
  property: {
    id: string;
    addressLine: string;
    postcode: string;
    latitude: number | null;
    longitude: number | null;
    propertyType: string | null;
    accessNotes: string | null;
    riskNotes: string | null;
    status: LifecycleStatus;
    roundId: string | null;
    roundName: string | null;
    serviceAreaId: string | null;
  } | null;
  servicePlans: ServicePlanView[];
  standingInfo: {
    frequency: CleaningFrequency | null;
    assignedRound: string | null;
    technicianName: string | null;
    paymentStatus: CustomerPaymentStatus;
    outstandingBalance?: number; // = amountDue (kept for existing clients) — omitted for TECHNICIAN viewers
    amountDue?: number; // unpaid SENT invoice totals — omitted for TECHNICIAN viewers
    nextDue: Date | null; // primary plan nextDueDate, else next open visit date
    lastPaymentDate: Date | null;
    issuesCount: number;
    nextVisitStatus: VisitStatus | null;
  };
  tabs: {
    overview: {
      addressLine: string;
      postcode: string;
      latitude: number | null;
      longitude: number | null;
      propertyType: string | null;
      accessNotes: string | null;
      riskNotes: string | null;
      contact: { name: string; phone: string | null; email: string | null };
    } | null;
    servicePlans: ServicePlanView[];
    visitHistory: VisitHistoryRow[];
    payments?: { rows: PaymentRow[] }; // full payment history + transaction ids — omitted for TECHNICIAN viewers
    notes: Array<PropertyNote & { authorName: string | null }>;
    photos: unknown[];
  };
}

// GAP-022: access/risk notes surfaced as pinned entries ahead of PropertyNotes.
export interface PinnedNote {
  pinned: true;
  source: "ACCESS" | "RISK";
  body: string;
}

export type NoteListEntry = PinnedNote | (PropertyNote & { pinned: false });

// GAP-010: customer picker row.
export interface CustomerSearchRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  propertyCount: number;
  postcode: string | null;
}

export interface VisitHistoryPage {
  rows: VisitHistoryRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SEARCH_LIMIT = 10;

const OPEN_VISIT: VisitStatus[] = [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS];

class CustomerService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  /** Decimal | number | null → number | null. */
  private num(d: Prisma.Decimal | number | null | undefined): number | null {
    return d == null ? null : Number(d);
  }

  // ---- list ----

  async getCustomers(
    filters: CustomerListFilters,
    viewerRole: UserRole
  ): Promise<CustomerListResult> {
    const hideFinancials = viewerRole === UserRole.TECHNICIAN;
    const now = new Date();
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
    if (status === "HOLD") {
      // HOLD is a derived filter (paymentHold lives on Visit, not Customer) —
      // push it into `where` as a semi-join, same pattern as the paymentHolds
      // summary count above, so it flows through the standard count+findMany path.
      where.properties = {
        some: {
          ...(roundId ? { roundId } : {}),
          visits: { some: { paymentHold: true, status: { in: OPEN_VISIT } } },
        },
      };
    }

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
      this.prisma.invoice.aggregate({
        _sum: { amount: true },
        where: { status: InvoiceStatus.SENT, customer: { status: LifecycleStatus.ACTIVE } },
      }),
    ]);

    // Shared include for both list paths. Only the latest payment is needed
    // (FAILED badge); amountDue and the rest of the badge come from invoices
    // (GAP-021), which are not take-limited so amountDue can't undercount.
    const listInclude = {
      payments: { orderBy: { createdAt: "desc" as const }, take: 1, select: { status: true } },
      invoices: { select: { status: true, dueDate: true, amount: true } },
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
      // onHold reflects the customer as a whole, not just the primary/displayed
      // property — must match the scope of the status=HOLD filter above
      // (properties.some.visits.some), or a customer could match that filter
      // via a secondary property while this field (and the paymentStatus badge
      // derived from it) stays false.
      const onHold = c.properties.some((p) => p.visits.some((v) => v.paymentHold));
      const amountDue = invoiceAmountDue(c.invoices);

      return {
        customerId: c.id,
        customerName: c.name,
        status: c.status,
        propertyId: property.id,
        addressLine: property.addressLine,
        postcode: property.postcode,
        latitude: property.latitude,
        longitude: property.longitude,
        roundId: property.roundId,
        roundName: property.round?.name ?? null,
        frequency: plan?.cleaningFrequency ?? property.round?.frequency ?? null,
        price: this.num(plan?.price),
        technicianId: nextVisit?.technicianId ?? null,
        technicianName: nextVisit?.technician?.name ?? null,
        nextDueDate: plan?.nextDueDate ?? null,
        nextDue: plan?.nextDueDate ?? nextVisit?.date ?? null,
        paymentStatus: deriveCustomerPaymentStatus({
          onHold: onHold || c.holdNextClean,
          latestPaymentStatus: c.payments[0]?.status,
          invoices: c.invoices,
          now,
        }),
        onHold,
        badDebt: c.badDebt,
        amountDue: hideFinancials ? undefined : amountDue,
      };
    };

    // DB-level pagination for every status filter, including HOLD (pushed into `where` above).
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
    const total = count;
    const rows = customers.map(toRow).filter((r): r is CustomerListRow => r !== null);

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
          invoices: { select: { status: true, dueDate: true, amount: true } },
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
                take: 50,
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
      getCachedBusinessSettings(this.prisma),
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

    const toServicePlanView = (p: NonNullable<typeof plan>): ServicePlanView => ({
      id: p.id,
      serviceId: p.serviceId,
      serviceName: p.service?.name ?? null,
      price: this.num(p.price),
      cleanMethod: p.cleanMethod,
      paymentMethod: p.paymentMethod,
      cleaningFrequency: p.cleaningFrequency,
      status: p.status,
      nextDueDate: p.nextDueDate,
      lastCompleted: p.lastCompleted,
      pauseStartDate: p.pauseStartDate,
      pauseEndDate: p.pauseEndDate,
      paymentRule,
      isPrimary: p.id === plan?.id,
    });

    const servicePlanViews: ServicePlanView[] = property
      ? property.servicePlans.map(toServicePlanView)
      : [];

    // Full-history issue count — NOT derived from `property.visits` below,
    // which is capped to the 50 most recent visits for display. An issue
    // logged against an older visit outside that cap must still count here.
    const issuesCount = property
      ? await this.prisma.issue.count({ where: { visit: { propertyId: property.id } } })
      : 0;

    const visits = property?.visits ?? [];
    const scheduled = visits
      .filter((v) => OPEN_VISIT.includes(v.status))
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const nextScheduled = scheduled[0] ?? null;
    const onHold = visits.some((v) => v.paymentHold && OPEN_VISIT.includes(v.status));

    const amountDue = invoiceAmountDue(customer.invoices);
    const lastPaymentDate =
      customer.payments
        .filter((p) => p.paidAt != null)
        .map((p) => p.paidAt as Date)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
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
        badDebt: customer.badDebt,
      },
      property: property
        ? {
            id: property.id,
            addressLine: property.addressLine,
            postcode: property.postcode,
            latitude: property.latitude,
            longitude: property.longitude,
            propertyType: property.propertyType,
            accessNotes: property.accessNotes,
            riskNotes: property.riskNotes,
            status: property.status,
            roundId: property.roundId,
            roundName: property.round?.name ?? null,
            serviceAreaId: property.serviceAreaId,
          }
        : null,
      servicePlans: servicePlanViews,
      standingInfo: {
        frequency: plan?.cleaningFrequency ?? property?.round?.frequency ?? null,
        assignedRound: property?.round?.name ?? null,
        technicianName,
        paymentStatus: deriveCustomerPaymentStatus({
          onHold: onHold || customer.holdNextClean,
          latestPaymentStatus: customer.payments[0]?.status,
          invoices: customer.invoices,
          now: new Date(),
        }),
        outstandingBalance: hideFinancials ? undefined : amountDue,
        amountDue: hideFinancials ? undefined : amountDue,
        nextDue: plan?.nextDueDate ?? nextScheduled?.date ?? null,
        lastPaymentDate,
        issuesCount,
        nextVisitStatus: nextScheduled?.status ?? null,
      },
      tabs: {
        overview: property
          ? {
              addressLine: property.addressLine,
              postcode: property.postcode,
              latitude: property.latitude,
              longitude: property.longitude,
              propertyType: property.propertyType,
              accessNotes: property.accessNotes,
              riskNotes: property.riskNotes,
              contact: { name: customer.name, phone: customer.phone, email: customer.email },
            }
          : null,
        servicePlans: servicePlanViews,
        visitHistory: visits.map((v) => ({
          visitId: v.id,
          date: v.date,
          roundName: v.round?.name ?? null,
          status: v.status,
          cancelReason: v.cancelReason,
          paymentStatus: v.payment?.status ?? null,
          notes: v.notes,
        })),
        payments: hideFinancials
          ? undefined
          : {
              // Cancelled visits (pause / frequency change) never carry money.
              rows: visits.filter((v) => v.status !== VisitStatus.CANCELLED).map((v) => ({
                visitId: v.id,
                visitDate: v.date,
                technicianName: v.technician?.name ?? null,
                amount: this.num(v.payment?.amount ?? v.price),
                paymentStatus: v.payment?.status ?? null,
                paymentId: v.payment?.id ?? null,
                method: v.payment?.method ?? null,
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

  async createCustomer(input: CustomerCreateInput): Promise<Customer> {
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
      if (input.landline !== undefined) customerData.landline = input.landline;
      if (input.email !== undefined) customerData.email = input.email;
      if (input.messagesOptOut !== undefined) customerData.messagesOptOut = input.messagesOptOut;
      if (Object.keys(customerData).length > 0) {
        await tx.customer.update({ where: { id: customer.id }, data: customerData });
      }

      // Coordinates are keyed on postcode alone (see updateProperty) — only
      // reset/re-geocode when the postcode itself actually changes.
      const postcodeChanged = property != null && input.postcode !== undefined && input.postcode !== property.postcode;

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
        if (postcodeChanged) {
          propertyData.latitude = null;
          propertyData.longitude = null;
          propertyData.geocodedAt = null;
          propertyData.geocodeAttempts = 0;
          propertyData.geocodeError = null;
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
        postcodeChanged,
        newPostcode: input.postcode,
      };
    }).then(({ postcodeChanged, newPostcode, ...result }) => {
      if (postcodeChanged && result.propertyId && newPostcode) {
        triggerGeocode(this.prisma, result.propertyId, newPostcode).catch(console.error);
      }
      return result;
    });
  }

  // ---- soft-delete customer (CANCELLED + cascades to properties + plans) ----

  async deleteCustomer(customerId: string): Promise<void> {
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
  private async resolveRound(
    roundId: string | null | undefined
  ): Promise<{ frequency: CleaningFrequency | null; defaultDay: DayOfWeek | null } | null> {
    if (!roundId) return null;
    const round = await this.prisma.round.findUnique({ where: { id: roundId } });
    if (!round) throw new AppError(404, `Round not found: ${roundId}`);
    return { frequency: round.frequency, defaultDay: round.defaultDay };
  }

  // A2: an explicit nextDueDate wins. Otherwise a plan on a round gets the
  // round's next day on/after today, or last clean + one cycle when
  // lastCleanedDate is given (and the round has a frequency). No round = no
  // date (nothing generates visits for an unassigned property anyway).
  private planNextDueDate(
    input: PropertyAddInput,
    round: { frequency: CleaningFrequency | null; defaultDay: DayOfWeek | null } | null
  ): Date | null {
    if (input.nextDueDate) return input.nextDueDate;
    if (!round) return null;
    return initialNextDueDate({
      lastCleanedDate: round.frequency ? input.lastCleanedDate : null,
      frequency: round.frequency ?? CleaningFrequency.FOUR_WEEKLY,
      roundDefaultDay: round.defaultDay,
      today: new Date(),
    });
  }

  private async createPropertyAndPlan(
    tx: Parameters<Parameters<TenantPrismaClient["$transaction"]>[0]>[0],
    customerId: string,
    input: PropertyAddInput,
    round: { frequency: CleaningFrequency | null; defaultDay: DayOfWeek | null } | null
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
        nextDueDate: this.planNextDueDate(input, round),
        cleaningFrequency: round?.frequency ?? null,
        status: LifecycleStatus.ACTIVE,
      },
    });
    return { propertyId: property.id, servicePlanId: plan.id };
  }

  async createProperty(
    input: PropertyCreateInput
  ): Promise<{ customerId: string; propertyId: string; servicePlanId: string; assigned: boolean }> {
    const round = await this.resolveRound(input.roundId);
    await this.assertServiceAreaExists(input.serviceAreaId);

    const result = await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          name: input.customerName,
          phone: input.phone ?? null,
          landline: input.landline ?? null,
          email: input.email ?? null,
          paymentMethod: input.paymentMethod ?? null,
          status: LifecycleStatus.ACTIVE,
        },
      });
      const { propertyId, servicePlanId } = await this.createPropertyAndPlan(
        tx, customer.id, input, round
      );
      return { customerId: customer.id, propertyId, servicePlanId, assigned: input.roundId != null };
    });
    triggerGeocode(this.prisma, result.propertyId, input.postcode).catch(console.error);
    return result;
  }

  // ---- add property to existing customer (Property + ServicePlan, atomic) ----

  async addPropertyToCustomer(
    customerId: string,
    input: PropertyAddInput
  ): Promise<{ propertyId: string; servicePlanId: string; assigned: boolean }> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new AppError(404, "Customer not found");
    if (customer.status === LifecycleStatus.CANCELLED) {
      throw new AppError(409, "Cannot add a property to a cancelled customer");
    }
    const round = await this.resolveRound(input.roundId);
    await this.assertServiceAreaExists(input.serviceAreaId);

    const result = await this.prisma.$transaction(async (tx) => {
      const { propertyId, servicePlanId } = await this.createPropertyAndPlan(
        tx, customerId, input, round
      );
      return { propertyId, servicePlanId, assigned: input.roundId != null };
    });
    triggerGeocode(this.prisma, result.propertyId, input.postcode).catch(console.error);
    return result;
  }

  // ---- soft-delete property (CANCELLED + cancels active service plans) ----

  async deleteProperty(propertyId: string): Promise<void> {
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
    propertyId: string,
    input: PropertyUpdateInput
  ): Promise<PropertyUpdateResult> {
    const existing = await this.prisma.property.findUnique({
      where: { id: propertyId },
      include: {
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

    // Coordinates are keyed on postcode alone — an addressLine-only edit
    // (e.g. a unit number) doesn't invalidate them, so only reset/re-geocode
    // when the postcode itself actually changes.
    const postcodeChanged = input.postcode !== undefined && input.postcode !== existing.postcode;

    let targetRoundId: string | null = existing.roundId;
    let newFrequency: CleaningFrequency | null | undefined = undefined; // undefined = no plan update
    let movedToRound: PlanUpdateResult["movedToRound"] = null;

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
    } else if (input.cleaningFrequency !== undefined && plan) {
      // Frequency change — same B3 move logic as PATCH /service-plans/:id
      // (matching round in the area, else 409 NO_MATCHING_ROUND unless
      // createRoundIfMissing; future visits on the old round cancelled).
      // Runs before the property write so a 409 leaves the property untouched.
      const result = await updatePlan(
        this.prisma,
        plan.id,
        { cleaningFrequency: input.cleaningFrequency, createRoundIfMissing: input.createRoundIfMissing },
        new Date()
      );
      movedToRound = result.movedToRound;
      if (movedToRound) targetRoundId = movedToRound.id;
    }

    return this.prisma.$transaction(async (tx) => {
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
          ...(postcodeChanged
            ? { latitude: null, longitude: null, geocodedAt: null, geocodeAttempts: 0, geocodeError: null }
            : {}),
        },
      });
    }).then((updated) => {
      if (postcodeChanged) triggerGeocode(this.prisma, updated.id, updated.postcode).catch(console.error);
      return { ...updated, movedToRound };
    });
  }

  // ---- M9: pause / resume ----

  async pauseService(
    propertyId: string,
    input: PauseInput
  ): Promise<PauseResult> {
    const plan = await this.primaryPlan(propertyId);
    if (plan.status === LifecycleStatus.PAUSED) {
      throw new AppError(409, "Service plan is already paused");
    }
    return pausePlan(this.prisma, plan, input, new Date());
  }

  async resumeService(propertyId: string): Promise<ServicePlan> {
    const plan = await this.primaryPlan(propertyId);
    this.assertResumable(plan);
    return resumePlan(this.prisma, plan, new Date());
  }

  // ---- per-plan writes (targets one ServicePlan directly, not the
  // property's guessed "primary" plan) ----

  async updateServicePlan(
    servicePlanId: string,
    input: ServicePlanUpdateInput
  ): Promise<PlanUpdateResult> {
    return updatePlan(this.prisma, servicePlanId, input, new Date());
  }

  async pauseServicePlan(servicePlanId: string, input: PauseInput): Promise<PauseResult> {
    const plan = await this.prisma.servicePlan.findUnique({ where: { id: servicePlanId } });
    if (!plan) throw new AppError(404, "Service plan not found");
    if (plan.status === LifecycleStatus.PAUSED) {
      throw new AppError(409, "Service plan is already paused");
    }
    return pausePlan(this.prisma, plan, input, new Date());
  }

  async resumeServicePlan(servicePlanId: string): Promise<ServicePlan> {
    const plan = await this.prisma.servicePlan.findUnique({ where: { id: servicePlanId } });
    if (!plan) throw new AppError(404, "Service plan not found");
    this.assertResumable(plan);
    return resumePlan(this.prisma, plan, new Date());
  }

  // PAUSED, or ACTIVE with a scheduled (future) pause — resuming the latter
  // cancels the scheduled pause.
  private assertResumable(plan: ServicePlan): void {
    if (plan.status !== LifecycleStatus.PAUSED && plan.pauseStartDate == null) {
      throw new AppError(409, "Service plan is not paused");
    }
  }

  // ---- GAP-022: bad debt flag ----

  async setBadDebt(customerId: string, flag: boolean): Promise<{ id: string; badDebt: boolean }> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new AppError(404, "Customer not found");
    return this.prisma.customer.update({
      where: { id: customerId },
      data: { badDebt: flag },
      select: { id: true, badDebt: true },
    });
  }

  // ---- GAP-010: customer picker search ----

  // Matches name, email or postcode (case-insensitive substring), or the
  // phone/landline by digits only, so "07700 900" finds numbers stored with
  // spaces or a +44 prefix. Cancelled customers are excluded.
  async searchCustomers(q: string): Promise<CustomerSearchRow[]> {
    const term = q.trim();
    if (term === "") return [];
    const digits = term.replace(/\D/g, "");
    const digitsLike = `%${digits}%`;
    const phoneMatches =
      digits.length >= 3
        ? await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Customer"
            WHERE regexp_replace(coalesce("phone", ''), '[^0-9]', '', 'g') LIKE ${digitsLike}
               OR regexp_replace(coalesce("landline", ''), '[^0-9]', '', 'g') LIKE ${digitsLike}
            LIMIT 50
          `
        : [];

    const customers = await this.prisma.customer.findMany({
      where: {
        status: { not: LifecycleStatus.CANCELLED },
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          { email: { contains: term, mode: "insensitive" } },
          { properties: { some: { postcode: { contains: term, mode: "insensitive" } } } },
          ...(phoneMatches.length > 0 ? [{ id: { in: phoneMatches.map((r) => r.id) } }] : []),
        ],
      },
      orderBy: { name: "asc" },
      take: SEARCH_LIMIT,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        properties: {
          where: { status: { not: LifecycleStatus.CANCELLED } },
          orderBy: { createdAt: "asc" },
          select: { postcode: true },
        },
      },
    });
    return customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      propertyCount: c.properties.length,
      postcode: c.properties[0]?.postcode ?? null,
    }));
  }

  // ---- visit history (all statuses, incl. CANCELLED with its reason) ----

  async getVisitHistory(
    customerId: string,
    page: number,
    pageSize: number
  ): Promise<VisitHistoryPage> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new AppError(404, "Customer not found");
    const where: Prisma.VisitWhereInput = { property: { customerId } };
    const [total, visits] = await Promise.all([
      this.prisma.visit.count({ where }),
      this.prisma.visit.findMany({
        where,
        orderBy: { date: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { round: { select: { name: true } }, payment: { select: { status: true } } },
      }),
    ]);
    return {
      rows: visits.map((v) => ({
        visitId: v.id,
        date: v.date,
        roundName: v.round?.name ?? null,
        status: v.status,
        cancelReason: v.cancelReason,
        paymentStatus: v.payment?.status ?? null,
        notes: v.notes,
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  // ---- M20: notes ----

  // GAP-022: the property's access and risk notes come first as pinned
  // entries, then PropertyNotes newest first.
  async getNotes(propertyId: string): Promise<NoteListEntry[]> {
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: { accessNotes: true, riskNotes: true },
    });
    if (!property) throw new AppError(404, "Property not found");
    const notes = await this.prisma.propertyNote.findMany({
      where: { propertyId },
      orderBy: { createdAt: "desc" },
    });
    const pinned: PinnedNote[] = [];
    if (property.accessNotes?.trim()) pinned.push({ pinned: true, source: "ACCESS", body: property.accessNotes });
    if (property.riskNotes?.trim()) pinned.push({ pinned: true, source: "RISK", body: property.riskNotes });
    return [...pinned, ...notes.map((n) => ({ ...n, pinned: false as const }))];
  }

  async addNote(
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

export function createCustomerService(prisma: TenantPrismaClient) {
  return new CustomerService(prisma);
}
