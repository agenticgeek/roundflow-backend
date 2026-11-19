import { IssueType, NoteType, PhotoType, VisitStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";
import { evaluateDebtGate } from "./debt-gate";
import { notifyAdmins } from "../../services/notify";
import { STOP_ORDER, stopWhere } from "../../services/stops";

class JobTrackerService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  // Every visit in `visit`'s stop (same property, day and technician) with one of `statuses`, in stop order.
  private async stopIds(visit: { propertyId: string; date: Date; technicianId: string | null }, statuses: VisitStatus[]) {
    const stop = await this.prisma.visit.findMany({ where: stopWhere(visit), select: { id: true, status: true }, orderBy: STOP_ORDER });
    return stop.filter((v) => statuses.includes(v.status)).map((v) => v.id);
  }

  // Starting any service at a property starts every service still SCHEDULED there (one door, one start).
  async startVisit(visitId: string, _technicianProfileId: string): Promise<void> {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      include: { property: { select: { customerId: true } } },
    });
    if (!visit) throw new AppError(404, "Visit not found");
    const ids = await this.stopIds(visit, [VisitStatus.SCHEDULED]);
    if (ids.length === 0) {
      throw new AppError(409, `Cannot start a visit with status ${visit.status}`);
    }

    const gate = await evaluateDebtGate(this.prisma, visit.property.customerId);
    if (!gate.canStart) {
      throw new AppError(403, gate.blockReason ?? "Cannot start visit: customer has outstanding debt");
    }

    await this.prisma.visit.updateMany({
      where: { id: { in: ids }, status: VisitStatus.SCHEDULED },
      data: { status: VisitStatus.IN_PROGRESS, startedAt: new Date() },
    });
  }

  async markArrived(visitId: string): Promise<void> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId } });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.status !== VisitStatus.IN_PROGRESS) {
      throw new AppError(409, `Cannot mark arrived for a visit with status ${visit.status}`);
    }
    const ids = await this.stopIds(visit, [VisitStatus.IN_PROGRESS]);
    await this.prisma.visit.updateMany({
      where: { id: { in: ids }, status: VisitStatus.IN_PROGRESS },
      data: { arrivedAt: new Date() },
    });
  }

  // `stop: true` skips every open service at the property (the app's "Skip job" on a stop); otherwise just this
  // one service, as older app builds expect.
  async skipVisit(visitId: string, reason: string, description?: string, opts: { stop?: boolean } = {}): Promise<void> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId } });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.status === VisitStatus.COMPLETED) throw new AppError(409, "Cannot skip a completed visit");
    if (visit.status === VisitStatus.CANCELLED) throw new AppError(409, "Cannot skip a cancelled visit");
    if (visit.status === VisitStatus.SKIPPED) return;
    const skipReason = description ? `${reason}: ${description}` : reason;
    if (opts.stop) {
      const open = [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS];
      await this.prisma.visit.updateMany({
        where: { id: { in: await this.stopIds(visit, open) }, status: { in: open } },
        data: { status: VisitStatus.SKIPPED, skipReason },
      });
    } else {
      await this.prisma.visit.update({ where: { id: visitId }, data: { status: VisitStatus.SKIPPED, skipReason } });
    }
    // NOTIF-03: the office sees why a visit was skipped. Best effort.
    await notifyAdmins(this.prisma, {
      type: "SCHEDULE",
      title: "Visit skipped",
      body: skipReason,
      data: {
        visitId,
        propertyId: visit.propertyId,
        ...(visit.roundId ? { roundId: visit.roundId } : {}),
        date: visit.date.toISOString().slice(0, 10),
      },
    });
  }

  // photoPaths: storage paths from POST /photos/upload-url (type ACCESS_ISSUE),
  // stored as ACCESS_ISSUE Photo rows linked to the issue in the same insert.
  // C3: the issue is linked to the property (Issue.propertyId) and a dated
  // PropertyNote "<date> - Access problem (<type>) reported by <technician>: <description>"
  // is written in the same transaction, so it shows on the property's Notes tab.
  async reportAccessIssue(
    visitId: string,
    issueType: IssueType,
    description: string,
    photoPaths: string[] = [],
    reporter: { technicianName?: string | null; profileId?: string | null } = {}
  ): Promise<{ id: string }> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId } });
    if (!visit) throw new AppError(404, "Visit not found");
    const photos = photoPaths.map((url) => ({ url, type: PhotoType.ACCESS_ISSUE, visitId, propertyId: visit.propertyId }));
    const date = new Date().toISOString().slice(0, 10);
    const who = reporter.technicianName?.trim() || "technician";
    const [issue] = await this.prisma.$transaction([
      this.prisma.issue.create({
        data: {
          visitId,
          propertyId: visit.propertyId,
          type: issueType,
          note: description,
          ...(photos.length ? { photos: { create: photos } } : {}),
        },
        select: { id: true },
      }),
      this.prisma.propertyNote.create({
        data: {
          propertyId: visit.propertyId,
          type: NoteType.INTERNAL,
          body: `${date} - Access problem (${issueType}) reported by ${who}: ${description}`,
          authorProfileId: reporter.profileId ?? null,
        },
      }),
    ]);
    // NOTIF-03: access problems need the office's attention. Best effort.
    await notifyAdmins(this.prisma, {
      type: "ACCESS_ISSUE",
      title: "Access problem reported",
      body: `${who}: ${issueType} - ${description.length > 120 ? `${description.slice(0, 117)}...` : description}`,
      data: { visitId, propertyId: visit.propertyId, ...(visit.roundId ? { roundId: visit.roundId } : {}) },
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
