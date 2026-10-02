import { InvoiceStatus, IssueType, VisitStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";

export interface IJobTrackerService {
  startVisit(visitId: string, technicianProfileId: string): Promise<void>;
  markArrived(visitId: string): Promise<void>;
  skipVisit(visitId: string, reason: string, description?: string): Promise<void>;
  reportAccessIssue(visitId: string, issueType: IssueType, description: string): Promise<void>;
  adjustPrice(visitId: string, price: number): Promise<void>;
}

class JobTrackerService implements IJobTrackerService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async startVisit(visitId: string, _technicianProfileId: string): Promise<void> {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      include: { property: { select: { customerId: true } } },
    });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.status !== VisitStatus.SCHEDULED) {
      throw new AppError(409, `Cannot start a visit with status ${visit.status}`);
    }

    const settings = await this.prisma.businessSettings.findFirst({
      select: { debtHoldEnabled: true, debtHoldMaxInvoices: true, debtHoldMaxAmount: true },
    });

    if (settings?.debtHoldEnabled) {
      const invoices = await this.prisma.invoice.findMany({
        where: {
          customerId: visit.property.customerId,
          status: { in: [InvoiceStatus.DRAFT, InvoiceStatus.SENT] },
        },
        select: { amount: true },
      });

      if (invoices.length > 0) {
        const count = invoices.length;
        const total = invoices.reduce((s, i) => s + i.amount.toNumber(), 0);
        const maxCount = settings.debtHoldMaxInvoices;
        const maxAmount = settings.debtHoldMaxAmount?.toNumber() ?? null;

        const blockedByCount  = maxCount  === null ? true : count  > maxCount;
        const blockedByAmount = maxAmount === null ? true : total > maxAmount;

        if (blockedByCount || blockedByAmount) {
          throw new AppError(403, "Cannot start visit: customer has outstanding debt");
        }
      }
    }

    await this.prisma.visit.update({
      where: { id: visitId },
      data: { status: VisitStatus.IN_PROGRESS, startedAt: new Date() },
    });
  }

  async markArrived(visitId: string): Promise<void> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId } });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.status !== VisitStatus.IN_PROGRESS) {
      throw new AppError(409, `Cannot mark arrived for a visit with status ${visit.status}`);
    }
    await this.prisma.visit.update({
      where: { id: visitId },
      data: { arrivedAt: new Date() },
    });
  }

  async skipVisit(visitId: string, reason: string, description?: string): Promise<void> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId } });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.status === VisitStatus.COMPLETED) throw new AppError(409, "Cannot skip a completed visit");
    if (visit.status === VisitStatus.SKIPPED) return;
    const skipReason = description ? `${reason}: ${description}` : reason;
    await this.prisma.visit.update({ where: { id: visitId }, data: { status: VisitStatus.SKIPPED, skipReason } });
  }

  async reportAccessIssue(visitId: string, issueType: IssueType, description: string): Promise<void> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId } });
    if (!visit) throw new AppError(404, "Visit not found");
    await this.prisma.issue.create({ data: { visitId, type: issueType, note: description } });
  }

  async adjustPrice(visitId: string, price: number): Promise<void> {
    if (price < 0) throw new AppError(400, "Price cannot be negative");
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId }, select: { id: true, status: true } });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.status !== VisitStatus.SCHEDULED && visit.status !== VisitStatus.IN_PROGRESS) {
      throw new AppError(409, `Cannot adjust price of a ${visit.status} visit`);
    }
    await this.prisma.visit.update({ where: { id: visitId }, data: { price } });
  }
}

export function createJobTrackerService(prisma: TenantPrismaClient): IJobTrackerService {
  return new JobTrackerService(prisma);
}
