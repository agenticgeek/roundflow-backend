import { IssueType, PhotoType, VisitStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";
import { evaluateDebtGate } from "./debt-gate";

class JobTrackerService {
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

    const gate = await evaluateDebtGate(this.prisma, visit.property.customerId);
    if (!gate.canStart) {
      throw new AppError(403, gate.blockReason ?? "Cannot start visit: customer has outstanding debt");
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
    if (visit.status === VisitStatus.CANCELLED) throw new AppError(409, "Cannot skip a cancelled visit");
    if (visit.status === VisitStatus.SKIPPED) return;
    const skipReason = description ? `${reason}: ${description}` : reason;
    await this.prisma.visit.update({ where: { id: visitId }, data: { status: VisitStatus.SKIPPED, skipReason } });
  }

  // photoPaths: storage paths from POST /photos/upload-url (type ACCESS_ISSUE),
  // stored as ACCESS_ISSUE Photo rows linked to the issue in the same insert.
  async reportAccessIssue(visitId: string, issueType: IssueType, description: string, photoPaths: string[] = []): Promise<{ id: string }> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId } });
    if (!visit) throw new AppError(404, "Visit not found");
    const photos = photoPaths.map((url) => ({ url, type: PhotoType.ACCESS_ISSUE, visitId, propertyId: visit.propertyId }));
    const issue = await this.prisma.issue.create({
      data: { visitId, type: issueType, note: description, ...(photos.length ? { photos: { create: photos } } : {}) },
      select: { id: true },
    });
    return { id: issue.id };
  }

  async adjustPrice(visitId: string, price: number, reason?: string | null): Promise<void> {
    if (price < 0) throw new AppError(400, "Price cannot be negative");
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      select: { status: true, price: true, originalPrice: true },
    });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.status !== VisitStatus.SCHEDULED && visit.status !== VisitStatus.IN_PROGRESS) {
      throw new AppError(409, `Cannot adjust price of a ${visit.status} visit`);
    }
    const current = visit.price.toNumber();
    // First adjustment remembers the full price; later ones keep that original.
    const original = visit.originalPrice ? visit.originalPrice.toNumber() : current;
    if (price === original) {
      // Restored to the full price — clear the adjustment.
      await this.prisma.visit.update({
        where: { id: visitId },
        data: { price, originalPrice: null, priceAdjustmentReason: null },
      });
    } else {
      await this.prisma.visit.update({
        where: { id: visitId },
        data: { price, originalPrice: original, priceAdjustmentReason: reason ?? null },
      });
    }
  }
}

export function createJobTrackerService(prisma: TenantPrismaClient) {
  return new JobTrackerService(prisma);
}
