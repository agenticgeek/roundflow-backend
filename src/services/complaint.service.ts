import { ComplaintStatus, MessageChannel, MessageDirection, Prisma, Severity, VisitStatus } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { prisma as publicPrisma } from "../lib/prisma";
import { parseOptionalDateOnly } from "../lib/validation";
import { resolveTechnicianForVisit, technicianIdsUnavailableOn } from "./visit-assignment";

export interface ComplaintCreateInput {
  customerId: string;
  title: string;
  description?: string | null;
  issueType?: string | null;
  severity?: Severity;
  propertyId?: string | null;
  technicianId?: string | null;
}

export interface ComplaintDetail {
  id: string;
  status: string;
  severity: string;
  title: string;
  description: string | null;
  issueType: string | null;
  customerId: string;
  customerName: string;
  propertyId: string | null;
  propertyAddress: string | null;
  technicianId: string | null;
  technicianName: string | null;
  revisitDate: string | null;
  messageCount: number;
  resolvedAt: string | null;
  resolvedBy: { id: string; name: string | null } | null; // Profile (control-plane schema)
  upheld: boolean | null;
  notes: string | null;
  createdAt: string;
}

export interface RevisitResult extends ComplaintDetail {
  visitId: string | null; // null when the complaint has no property
}

export interface ComplaintListFilters {
  search?: string;
  status?: ComplaintStatus;
  technicianId?: string;
  page?: number;
  pageSize?: number;
}

export interface ComplaintPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaginatedComplaints {
  rows: ComplaintDetail[];
  pagination: ComplaintPagination;
}

export interface MessageDetail {
  id: string;
  direction: string;
  channel: string;
  body: string;
  complaintId: string;
  createdAt: string;
}

const INCLUDE = {
  customer: true,
  property: true,
  technician: true,
  _count: { select: { messages: true } },
} as const;
type ComplaintRow = Prisma.ComplaintGetPayload<{ include: typeof INCLUDE }>;
type MessageRow = Prisma.MessageGetPayload<object>;

class ComplaintService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async listComplaints(filters: ComplaintListFilters): Promise<PaginatedComplaints> {
    const where: Record<string, unknown> = {};
    if (filters.status) where.status = filters.status;
    if (filters.technicianId) where.technicianId = filters.technicianId;
    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search, mode: "insensitive" } },
        { customer: { name: { contains: filters.search, mode: "insensitive" } } },
      ];
    }

    const pageNum = Math.max(1, filters.page ?? 1);
    const pageSizeNum = Math.min(100, Math.max(1, filters.pageSize ?? 50));
    const skip = (pageNum - 1) * pageSizeNum;

    const [total, complaints] = await Promise.all([
      this.prisma.complaint.count({ where }),
      this.prisma.complaint.findMany({
        where,
        include: INCLUDE,
        orderBy: { createdAt: "desc" },
        take: pageSizeNum,
        skip,
      }),
    ]);

    return {
      rows: await this.toDetails(complaints),
      pagination: { page: pageNum, pageSize: pageSizeNum, total, totalPages: Math.ceil(total / pageSizeNum) },
    };
  }

  async getComplaint(complaintId: string): Promise<ComplaintDetail> {
    const complaint = await this.prisma.complaint.findUnique({
      where: { id: complaintId },
      include: INCLUDE,
    });
    if (!complaint) throw new AppError(404, "Complaint not found");
    return this.toDetail(complaint);
  }

  async logComplaint(input: ComplaintCreateInput): Promise<ComplaintDetail> {
    const customer = await this.prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new AppError(404, "Customer not found");

    if (input.propertyId) {
      const property = await this.prisma.property.findUnique({ where: { id: input.propertyId } });
      if (!property) throw new AppError(404, "Property not found");
    }

    // Attribution only, so pending-invite technicians are allowed (GAP-029).
    if (input.technicianId) {
      const tech = await this.prisma.technician.findUnique({
        where: { id: input.technicianId },
        select: { id: true },
      });
      if (!tech) throw new AppError(404, "Technician not found");
    }

    const complaint = await this.prisma.complaint.create({
      data: {
        customerId: input.customerId,
        title: input.title,
        description: input.description ?? null,
        issueType: input.issueType ?? null,
        severity: input.severity ?? Severity.LOW,
        status: ComplaintStatus.OPEN,
        propertyId: input.propertyId ?? null,
        technicianId: input.technicianId ?? null,
      },
      include: INCLUDE,
    });

    return this.toDetail(complaint);
  }

  async markInReview(complaintId: string): Promise<ComplaintDetail> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    const complaint = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: { status: ComplaintStatus.IN_REVIEW },
      include: INCLUDE,
    });

    return this.toDetail(complaint);
  }

  // Books the revisit date and (GAP-029) a one-off SCHEDULED visit on the
  // property's round for that date, so it shows in the planner and the app.
  // Rebooking moves the complaint's open revisit visit instead of adding one.
  async scheduleRevisit(complaintId: string, revisitDate: string): Promise<RevisitResult> {
    const existing = await this.prisma.complaint.findUnique({
      where: { id: complaintId },
      select: { id: true, propertyId: true, technicianId: true },
    });
    if (!existing) throw new AppError(404, "Complaint not found");

    const date = parseOptionalDateOnly(revisitDate, "revisitDate")!;

    const { complaint, visitId } = await this.prisma.$transaction(async (tx) => {
      const complaint = await tx.complaint.update({
        where: { id: complaintId },
        data: { status: ComplaintStatus.REVISIT_BOOKED, revisitDate: date },
        include: INCLUDE,
      });
      const visitId = existing.propertyId
        ? await this.upsertRevisitVisit(tx, { ...existing, propertyId: existing.propertyId }, date)
        : null;
      return { complaint, visitId };
    });

    return { ...(await this.toDetail(complaint)), visitId };
  }

  // Technician: the complaint's technician when they can work it (accepted
  // invite, active — a complaint may name a pending-invite technician for
  // attribution only), pinned with technicianOverride so restamping keeps
  // it; otherwise whoever the round would give the property that day.
  private async upsertRevisitVisit(
    tx: Prisma.TransactionClient,
    complaint: { id: string; propertyId: string; technicianId: string | null },
    date: Date
  ): Promise<string> {
    const [property, complaintTech] = await Promise.all([
      tx.property.findUniqueOrThrow({
        where: { id: complaint.propertyId },
        select: {
          roundId: true,
          assignedTechnicianId: true,
          round: { select: { roundTechnicians: { select: { technicianId: true } } } },
        },
      }),
      complaint.technicianId
        ? tx.technician.findUnique({
            where: { id: complaint.technicianId },
            select: { id: true, active: true, profileId: true },
          })
        : null,
    ]);

    const pinned = complaintTech && complaintTech.active && complaintTech.profileId !== null ? complaintTech.id : null;
    const technicianId = pinned ?? resolveTechnicianForVisit({
      assignedTechnicianId: property.assignedTechnicianId,
      roundTechnicianIds: property.round?.roundTechnicians.map((rt) => rt.technicianId) ?? [],
      unavailableTechnicianIds: [...(await technicianIdsUnavailableOn(tx, date))],
    });
    const data = { date, roundId: property.roundId, technicianId, technicianOverride: pinned !== null };

    const open = await tx.visit.findFirst({
      where: { complaintId: complaint.id, status: VisitStatus.SCHEDULED },
      select: { id: true },
    });
    if (open) {
      await tx.visit.update({ where: { id: open.id }, data });
      return open.id;
    }
    const visit = await tx.visit.create({
      data: {
        ...data,
        propertyId: complaint.propertyId,
        complaintId: complaint.id,
        isOneOff: true,
        status: VisitStatus.SCHEDULED,
        price: 0, // a revisit is free
        paymentHold: false,
      },
      select: { id: true },
    });
    return visit.id;
  }

  async reopen(complaintId: string): Promise<ComplaintDetail> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    const complaint = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: { status: ComplaintStatus.OPEN, revisitDate: null, resolvedAt: null, resolvedBy: null, upheld: null },
      include: INCLUDE,
    });

    return this.toDetail(complaint);
  }

  async resolve(
    complaintId: string,
    options?: { notes?: string | null; resolvedBy?: string | null; upheld?: boolean }
  ): Promise<ComplaintDetail> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    const complaint = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: {
        status: ComplaintStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedBy: options?.resolvedBy ?? null,
        upheld: options?.upheld ?? null,
        notes: options?.notes ?? null,
      },
      include: INCLUDE,
    });

    return this.toDetail(complaint);
  }

  async assignTechnician(complaintId: string, technicianId: string): Promise<ComplaintDetail> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    // Attribution only, so pending-invite technicians are allowed (GAP-029).
    const tech = await this.prisma.technician.findUnique({
      where: { id: technicianId },
      select: { id: true },
    });
    if (!tech) throw new AppError(404, "Technician not found");

    const complaint = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: { technicianId },
      include: INCLUDE,
    });

    return this.toDetail(complaint);
  }

  async getMessages(complaintId: string): Promise<MessageDetail[]> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    const messages = await this.prisma.message.findMany({
      where: { complaintId },
      orderBy: { createdAt: "asc" },
    });

    return messages.map((m) => this.toMessageDetail(m));
  }

  async addMessage(complaintId: string, body: string): Promise<MessageDetail> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    const message = await this.prisma.message.create({
      data: {
        complaintId,
        body,
        direction: MessageDirection.OUTBOUND,
        channel: MessageChannel.EMAIL,
      },
    });

    return this.toMessageDetail(message);
  }

  private toMessageDetail(message: MessageRow): MessageDetail {
    return {
      id: message.id,
      direction: message.direction,
      channel: message.channel,
      body: message.body,
      complaintId: message.complaintId!,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private async toDetail(complaint: ComplaintRow): Promise<ComplaintDetail> {
    const [detail] = await this.toDetails([complaint]);
    return detail;
  }

  // resolvedBy references Profile.id in the control-plane (public) schema —
  // resolved with one cross-schema lookup per batch, not a Prisma relation.
  private async toDetails(complaints: ComplaintRow[]): Promise<ComplaintDetail[]> {
    const profileIds = [...new Set(complaints.map((c) => c.resolvedBy).filter((id): id is string => !!id))];
    const profiles = profileIds.length > 0
      ? await publicPrisma.profile.findMany({ where: { id: { in: profileIds } }, select: { id: true, name: true } })
      : [];
    const names = new Map(profiles.map((p) => [p.id, p.name]));

    return complaints.map((complaint) => ({
      id: complaint.id,
      status: complaint.status,
      severity: complaint.severity,
      title: complaint.title,
      description: complaint.description,
      issueType: complaint.issueType,
      customerId: complaint.customerId,
      customerName: complaint.customer.name,
      propertyId: complaint.propertyId,
      propertyAddress: complaint.property?.addressLine ?? null,
      technicianId: complaint.technicianId,
      technicianName: complaint.technician?.name ?? null,
      revisitDate: complaint.revisitDate?.toISOString().slice(0, 10) ?? null,
      messageCount: complaint._count.messages,
      resolvedAt: complaint.resolvedAt?.toISOString() ?? null,
      resolvedBy: complaint.resolvedBy
        ? { id: complaint.resolvedBy, name: names.get(complaint.resolvedBy) ?? null }
        : null,
      upheld: complaint.upheld ?? null,
      notes: complaint.notes ?? null,
      createdAt: complaint.createdAt.toISOString(),
    }));
  }
}

export function createComplaintService(prisma: TenantPrismaClient) {
  return new ComplaintService(prisma);
}
