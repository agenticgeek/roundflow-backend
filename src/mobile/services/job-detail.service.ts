import { InvoiceStatus, PaymentMethod, PaymentStatus, PhotoType, Prisma, VisitStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";
import type { ActivityLogEntry, OutstandingInvoice } from "../types";
import { evaluateDebtGate } from "./debt-gate";
import { getCachedBusinessSettings } from "../../services/settings.service";
import { releaseHoldIfSettled } from "../../services/payment-hold";
import { notifyInvoicePaid } from "../../services/notify";
import { isLocationApproximate } from "../../integrations/geocoding/client";
import { vatOn, vatRateOf, grossOf } from "../../lib/vat";

const visitDetailInclude = {
  property: {
    select: {
      id: true, addressLine: true, postcode: true, latitude: true, longitude: true, geocodePrecision: true,
      // C2: the gate code / risk warning typed on the customer & property forms.
      accessNotes: true, riskNotes: true,
      customer: {
        select: {
          id: true, name: true, badDebt: true, paymentMethod: true,
          invoices: {
            where: { status: { in: [InvoiceStatus.DRAFT, InvoiceStatus.SENT] } },
            select: { id: true, invoiceNumber: true, amount: true, dueDate: true },
          },
        },
      },
      notes: { select: { id: true, type: true, body: true, createdAt: true, authorProfileId: true }, orderBy: { createdAt: "asc" } },
      // The property's own photo (newest PROPERTY photo); the route signs it for the app's job card.
      photos: { where: { type: PhotoType.PROPERTY }, select: { id: true, url: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  },
  round: { select: { id: true, name: true } },
  service: { select: { id: true, name: true } },
  technician: { select: { name: true, role: true } },
  servicePlan: { select: { paymentMethod: true } },
  // Stored paths; GET /mobile/visits/:id adds a signed read url per photo.
  photos: { select: { id: true, type: true, url: true, issueId: true, createdAt: true }, orderBy: { createdAt: "asc" } },
  _count: { select: { issues: true } },
} satisfies Prisma.VisitInclude;

type VisitDetailBase = Prisma.VisitGetPayload<{ include: typeof visitDetailInclude }>;

export interface DebtPaymentResult {
  cleared: boolean;
  amountPaid: number;
  amountPending: number;
  method: "CASH" | "CHEQUE";
}

// C2/D6: who wrote a property note. TECHNICIAN notes (the app's "note for
// office") are not access notes and must be shown separately.
export type VisitNote = {
  id: string;
  type: string;
  body: string;
  createdAt: Date;
  source: "TECHNICIAN" | "OFFICE";
  mine: boolean;
};

export interface VisitDetail extends Omit<VisitDetailBase, "property"> {
  property: Omit<VisitDetailBase["property"], "notes"> & { notes: VisitNote[]; locationApproximate: boolean };
  lastClean: Date | null;
  roundPosition: { position: number; total: number } | null;
  activityLog: ActivityLogEntry[];
  outstandingInvoices: OutstandingInvoice[];
  debtAmount: number;
  // A3: what the customer owes for this visit and what the technician should
  // take: price (net) + VAT when the business adds VAT to invoices.
  vatAmount: number;
  vatRate: number;
  grossTotal: number;
  canStart: boolean;
  blockReason: string | null;
}

class JobDetailService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async getVisitDetail(visitId: string, viewerProfileId?: string): Promise<VisitDetail> {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      include: visitDetailInclude,
    });
    if (!visit) throw new AppError(404, "Visit not found");

    const lastVisit = await this.prisma.visit.findFirst({
      where: { propertyId: visit.propertyId, status: VisitStatus.COMPLETED, id: { not: visitId }, completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    });

    let roundPosition: { position: number; total: number } | null = null;
    if (visit.roundId) {
      // Same scope and order as the Today list and GET /mobile/schedule: this
      // technician's visits in the round on the visit's own day, by createdAt
      // then id (stable - starting the visit does not change it).
      const roundVisits = await this.prisma.visit.findMany({
        where: { roundId: visit.roundId, technicianId: visit.technicianId, date: visit.date, status: { not: VisitStatus.CANCELLED } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const pos = roundVisits.findIndex(v => v.id === visitId);
      if (pos !== -1) roundPosition = { position: pos + 1, total: roundVisits.length };
    }

    const activityLog: ActivityLogEntry[] = [
      { event: "dispatched", timestamp: visit.date },
      ...(visit.startedAt ? [{ event: "started" as const, timestamp: visit.startedAt }] : []),
      ...(visit.arrivedAt ? [{ event: "arrived" as const, timestamp: visit.arrivedAt }] : []),
      ...(visit.completedAt ? [{ event: "completed" as const, timestamp: visit.completedAt }] : []),
    ];

    const outstandingInvoices: OutstandingInvoice[] = visit.property.customer.invoices.map(inv => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      amount: inv.amount.toNumber(),
      dueDate: inv.dueDate ?? null,
    }));
    const debtAmount = outstandingInvoices.reduce((s, i) => s + i.amount, 0);
    const gate = await evaluateDebtGate(this.prisma, visit.property.customer.id);

    // Effective method (visit → plan → customer) drives the app's payment sheet.
    const paymentMethod = visit.paymentMethod ?? visit.servicePlan?.paymentMethod ?? visit.property.customer.paymentMethod ?? null;

    const settings = await getCachedBusinessSettings(this.prisma);
    const net = visit.price.toNumber();
    const vatAmount = vatOn(net, settings);
    const vatRate = settings?.vatInInvoices ? vatRateOf(settings) : 0;

    // Notes written by technicians (their profile is linked to a Technician row) are
    // tagged so the app can keep them out of the ACCESS NOTES card.
    const authorIds = [...new Set(visit.property.notes.map((n) => n.authorProfileId).filter((a): a is string => !!a))];
    const techAuthors = authorIds.length
      ? new Set(
          (await this.prisma.technician.findMany({ where: { profileId: { in: authorIds } }, select: { profileId: true } }))
            .map((t) => t.profileId)
        )
      : new Set<string | null>();
    const notes: VisitNote[] = visit.property.notes.map((n) => ({
      id: n.id,
      type: n.type,
      body: n.body,
      createdAt: n.createdAt,
      source: n.authorProfileId && techAuthors.has(n.authorProfileId) ? "TECHNICIAN" : "OFFICE",
      mine: !!viewerProfileId && n.authorProfileId === viewerProfileId,
    }));

    return { ...visit, property: { ...visit.property, notes, locationApproximate: isLocationApproximate(visit.property.geocodePrecision, visit.property.latitude) }, paymentMethod, vatAmount, vatRate, grossTotal: grossOf(net, settings), lastClean: lastVisit?.completedAt ?? null, roundPosition, activityLog, outstandingInvoices, debtAmount, canStart: gate.canStart, blockReason: gate.blockReason };
  }

  // On-site debt collection. CASH clears the outstanding invoices immediately.
  // CHEQUE records a PENDING cheque payment for the total and leaves the
  // invoices open until the office clears them (POST /invoices/:id/mark-paid).
  async collectDebtPayment(
    visitId: string,
    opts: { method: "CASH" | "CHEQUE"; chequeNumber?: string; actorProfileId?: string },
  ): Promise<DebtPaymentResult> {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      select: { property: { select: { customer: { select: { id: true, name: true } } } } },
    });
    if (!visit) throw new AppError(404, "Visit not found");

    const customerId = visit.property.customer.id;
    const invoices = await this.prisma.invoice.findMany({
      where: { customerId, status: { in: [InvoiceStatus.DRAFT, InvoiceStatus.SENT] } },
      select: { id: true, invoiceNumber: true, amount: true },
    });

    const totalAmount = invoices.reduce((sum, inv) => sum + inv.amount.toNumber(), 0);

    if (invoices.length === 0) {
      await this.prisma.customer.update({ where: { id: customerId }, data: { badDebt: false } });
      return { cleared: true, amountPaid: 0, amountPending: 0, method: opts.method };
    }

    if (opts.method === "CHEQUE") {
      await this.prisma.$transaction([
        this.prisma.payment.create({
          data: {
            customerId,
            amount: totalAmount,
            method: PaymentMethod.CHEQUE,
            status: PaymentStatus.PENDING,
            reference: opts.chequeNumber,
          },
        }),
        this.prisma.activityLog.create({
          data: {
            type: "CHEQUE_RECEIVED",
            message: `Cheque ${opts.chequeNumber} received on site for ${invoices.length} outstanding invoice(s) (£${totalAmount.toFixed(2)}) — ${visit.property.customer.name}`,
            actorId: opts.actorProfileId ?? null,
            actorRole: "TECHNICIAN",
          },
        }),
      ]);
      return { cleared: false, amountPaid: 0, amountPending: totalAmount, method: "CHEQUE" };
    }

    const paidAt = new Date();
    await this.prisma.$transaction([
      this.prisma.invoice.updateMany({
        where: { id: { in: invoices.map(i => i.id) } },
        data: { status: InvoiceStatus.PAID, paidAt }, // A8: paid date was never set here
      }),
      this.prisma.payment.create({
        data: { customerId, amount: totalAmount, method: PaymentMethod.CASH, status: PaymentStatus.PAID, paidAt },
      }),
      this.prisma.customer.update({
        where: { id: customerId },
        data: { badDebt: false },
      }),
    ]);
    await releaseHoldIfSettled(this.prisma, customerId); // A8: same release rule as every other paid path
    // The office hears about cash taken on site like any other paid invoice (best effort, never throws).
    for (const inv of invoices) {
      await notifyInvoicePaid(this.prisma, { id: inv.id, invoiceNumber: inv.invoiceNumber, customerId });
    }

    return { cleared: true, amountPaid: totalAmount, amountPending: 0, method: "CASH" };
  }
}

export function createJobDetailService(prisma: TenantPrismaClient) {
  return new JobDetailService(prisma);
}
