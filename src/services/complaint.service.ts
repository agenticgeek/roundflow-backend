import { ComplaintStatus, MessageChannel, MessageDirection, Severity } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

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
  technicianId: string | null;
  revisitDate: string | null;
  createdAt: string;
}

export interface ComplaintListFilters {
  search?: string;
  status?: ComplaintStatus;
  technicianId?: string;
}

export interface MessageDetail {
  id: string;
  direction: string;
  channel: string;
  body: string;
  complaintId: string;
  createdAt: string;
}

export interface IComplaintService {
  listComplaints(profileId: string, filters: ComplaintListFilters): Promise<ComplaintDetail[]>;
  getComplaint(profileId: string, complaintId: string): Promise<ComplaintDetail>;
  logComplaint(profileId: string, input: ComplaintCreateInput): Promise<ComplaintDetail>;
  markInReview(profileId: string, complaintId: string): Promise<ComplaintDetail>;
  resolve(profileId: string, complaintId: string): Promise<ComplaintDetail>;
  scheduleRevisit(profileId: string, complaintId: string, revisitDate: string): Promise<ComplaintDetail>;
  reopen(profileId: string, complaintId: string): Promise<ComplaintDetail>;
  assignTechnician(profileId: string, complaintId: string, technicianId: string): Promise<ComplaintDetail>;
  getMessages(profileId: string, complaintId: string): Promise<MessageDetail[]>;
  addMessage(profileId: string, complaintId: string, body: string): Promise<MessageDetail>;
}

const INCLUDE = { customer: true, property: true, technician: true } as const;

class ComplaintService implements IComplaintService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async listComplaints(_profileId: string, filters: ComplaintListFilters): Promise<ComplaintDetail[]> {
    const where: Record<string, unknown> = {};
    if (filters.status) where.status = filters.status;
    if (filters.technicianId) where.technicianId = filters.technicianId;
    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search, mode: "insensitive" } },
        { customer: { name: { contains: filters.search, mode: "insensitive" } } },
      ];
    }

    const complaints = await this.prisma.complaint.findMany({
      where,
      include: INCLUDE,
      orderBy: { createdAt: "desc" },
    });

    return complaints.map((c: any) => this.toDetail(c));
  }

  async getComplaint(_profileId: string, complaintId: string): Promise<ComplaintDetail> {
    const complaint = await this.prisma.complaint.findUnique({
      where: { id: complaintId },
      include: INCLUDE,
    });
    if (!complaint) throw new AppError(404, "Complaint not found");
    return this.toDetail(complaint);
  }

  async logComplaint(_profileId: string, input: ComplaintCreateInput): Promise<ComplaintDetail> {
    const customer = await this.prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new AppError(404, "Customer not found");

    if (input.propertyId) {
      const property = await this.prisma.property.findUnique({ where: { id: input.propertyId } });
      if (!property) throw new AppError(404, "Property not found");
    }

    if (input.technicianId) {
      const tech = await this.prisma.technician.findUnique({
        where: { id: input.technicianId },
        select: { id: true, profileId: true },
      });
      if (!tech) throw new AppError(404, "Technician not found");
      if (tech.profileId === null) throw new AppError(400, "Technician has not accepted their invite");
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

  async markInReview(_profileId: string, complaintId: string): Promise<ComplaintDetail> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    const complaint = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: { status: ComplaintStatus.IN_REVIEW },
      include: INCLUDE,
    });

    return this.toDetail(complaint);
  }

  async scheduleRevisit(_profileId: string, complaintId: string, revisitDate: string): Promise<ComplaintDetail> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(revisitDate)) {
      throw new AppError(400, `"revisitDate" must be in YYYY-MM-DD format`);
    }

    const complaint = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: {
        status: ComplaintStatus.REVISIT_BOOKED,
        revisitDate: new Date(`${revisitDate}T00:00:00.000Z`),
      },
      include: INCLUDE,
    });

    return this.toDetail(complaint);
  }

  async reopen(_profileId: string, complaintId: string): Promise<ComplaintDetail> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    const complaint = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: { status: ComplaintStatus.OPEN, revisitDate: null },
      include: INCLUDE,
    });

    return this.toDetail(complaint);
  }

  async resolve(_profileId: string, complaintId: string): Promise<ComplaintDetail> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    const complaint = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: { status: ComplaintStatus.RESOLVED },
      include: INCLUDE,
    });

    return this.toDetail(complaint);
  }

  async assignTechnician(_profileId: string, complaintId: string, technicianId: string): Promise<ComplaintDetail> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    const tech = await this.prisma.technician.findUnique({
      where: { id: technicianId },
      select: { id: true, profileId: true },
    });
    if (!tech) throw new AppError(404, "Technician not found");
    if (tech.profileId === null) throw new AppError(400, "Technician has not accepted their invite");

    const complaint = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: { technicianId },
      include: INCLUDE,
    });

    return this.toDetail(complaint);
  }

  async getMessages(_profileId: string, complaintId: string): Promise<MessageDetail[]> {
    const existing = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!existing) throw new AppError(404, "Complaint not found");

    const messages = await this.prisma.message.findMany({
      where: { complaintId },
      orderBy: { createdAt: "asc" },
    });

    return messages.map((m: any) => this.toMessageDetail(m));
  }

  async addMessage(_profileId: string, complaintId: string, body: string): Promise<MessageDetail> {
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

  private toMessageDetail(message: any): MessageDetail {
    return {
      id: message.id,
      direction: message.direction,
      channel: message.channel,
      body: message.body,
      complaintId: message.complaintId,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private toDetail(complaint: any): ComplaintDetail {
    return {
      id: complaint.id,
      status: complaint.status,
      severity: complaint.severity,
      title: complaint.title,
      description: complaint.description,
      issueType: complaint.issueType,
      customerId: complaint.customerId,
      customerName: complaint.customer.name,
      propertyId: complaint.propertyId,
      technicianId: complaint.technicianId,
      revisitDate: complaint.revisitDate?.toISOString().slice(0, 10) ?? null,
      createdAt: complaint.createdAt.toISOString(),
    };
  }
}

export function createComplaintService(prisma: TenantPrismaClient): IComplaintService {
  return new ComplaintService(prisma);
}
