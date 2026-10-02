import { InvoiceStatus, PaymentMethod, PaymentStatus, Prisma, VisitStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";
import type { ActivityLogEntry, OutstandingInvoice } from "../types";
import { todayRange } from "./utils";

const visitDetailInclude = {
  property: {
    select: {
      id: true, addressLine: true, postcode: true,
      customer: {
        select: {
          id: true, name: true, badDebt: true,
          invoices: {
            where: { status: { in: [InvoiceStatus.DRAFT, InvoiceStatus.SENT] } },
            select: { id: true, invoiceNumber: true, amount: true, dueDate: true },
          },
        },
      },
      notes: { select: { id: true, type: true, body: true } },
    },
  },
  round: { select: { id: true, name: true } },
  service: { select: { id: true, name: true } },
  technician: { select: { name: true, role: true } },
  _count: { select: { issues: true } },
} satisfies Prisma.VisitInclude;

type VisitDetailBase = Prisma.VisitGetPayload<{ include: typeof visitDetailInclude }>;

export interface VisitDetail extends VisitDetailBase {
  lastClean: Date | null;
  roundPosition: { position: number; total: number } | null;
  activityLog: ActivityLogEntry[];
  outstandingInvoices: OutstandingInvoice[];
  debtAmount: number;
}

export interface IJobDetailService {
  getVisitDetail(visitId: string): Promise<VisitDetail>;
  collectDebtPayment(visitId: string): Promise<{ cleared: boolean; amountPaid: number }>;
}

class JobDetailService implements IJobDetailService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async getVisitDetail(visitId: string): Promise<VisitDetail> {
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
      const { start, end } = todayRange();
      const roundVisits = await this.prisma.visit.findMany({
        where: { roundId: visit.roundId, date: { gte: start, lt: end } },
        orderBy: { createdAt: "asc" },
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

    return { ...visit, lastClean: lastVisit?.completedAt ?? null, roundPosition, activityLog, outstandingInvoices, debtAmount };
  }

  async collectDebtPayment(visitId: string): Promise<{ cleared: boolean; amountPaid: number }> {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      select: { property: { select: { customer: { select: { id: true } } } } },
    });
    if (!visit) throw new AppError(404, "Visit not found");

    const customerId = visit.property.customer.id;
    const invoices = await this.prisma.invoice.findMany({
      where: { customerId, status: { in: [InvoiceStatus.DRAFT, InvoiceStatus.SENT] } },
      select: { id: true, amount: true },
    });

    const totalAmount = invoices.reduce((sum, inv) => sum + inv.amount.toNumber(), 0);

    if (invoices.length === 0) {
      await this.prisma.customer.update({ where: { id: customerId }, data: { badDebt: false } });
      return { cleared: true, amountPaid: 0 };
    }

    await this.prisma.$transaction([
      this.prisma.invoice.updateMany({
        where: { id: { in: invoices.map(i => i.id) } },
        data: { status: InvoiceStatus.PAID },
      }),
      this.prisma.payment.create({
        data: { customerId, amount: totalAmount, method: PaymentMethod.CASH, status: PaymentStatus.PAID, paidAt: new Date() },
      }),
      this.prisma.customer.update({
        where: { id: customerId },
        data: { badDebt: false },
      }),
    ]);

    return { cleared: true, amountPaid: totalAmount };
  }
}

export function createJobDetailService(prisma: TenantPrismaClient): IJobDetailService {
  return new JobDetailService(prisma);
}
