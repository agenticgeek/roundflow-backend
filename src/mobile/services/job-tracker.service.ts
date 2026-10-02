import { IssueType, VisitStatus } from "../../generated/tenant-client";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";

export interface IJobTrackerService {
  startVisit(visitId: string, technicianProfileId: string): Promise<void>;
  markArrived(visitId: string): Promise<void>;
  skipVisit(visitId: string, reason: string, description?: string): Promise<void>;
  reportAccessIssue(visitId: string, issueType: IssueType, description: string): Promise<void>;
}

class JobTrackerService implements IJobTrackerService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async startVisit(visitId: string, _technicianProfileId: string): Promise<void> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId } });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.status !== VisitStatus.SCHEDULED) {
      throw new AppError(409, `Cannot start a visit with status ${visit.status}`);
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
}

export function createJobTrackerService(prisma: TenantPrismaClient): IJobTrackerService {
  return new JobTrackerService(prisma);
}
