import { PaymentMethod, VisitStatus } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

export interface VisitCreateInput {
  propertyId: string;
  date: string;
  price: number;
  serviceId?: string | null;
  technicianId?: string | null;
  roundId?: string | null;
  notes?: string | null;
  paymentMethod?: PaymentMethod | null;
}

export interface VisitDetail {
  id: string;
  date: string;
  status: string;
  isOneOff: boolean;
  price: number;
  notes: string | null;
  paymentMethod: string | null;
  propertyId: string;
  addressLine: string;
  postcode: string;
  customerId: string;
  customerName: string;
  roundId: string | null;
  roundName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  technicianId: string | null;
  technicianName: string | null;
}

export interface IVisitService {
  createVisit(profileId: string, input: VisitCreateInput): Promise<VisitDetail>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class VisitService implements IVisitService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async createVisit(_profileId: string, input: VisitCreateInput): Promise<VisitDetail> {
    if (!DATE_RE.test(input.date)) {
      throw new AppError(400, `"date" must be in YYYY-MM-DD format`);
    }
    if (input.price <= 0 || input.price > 9999.99) {
      throw new AppError(400, `"price" must be > 0 and ≤ 9999.99`);
    }

    const property = await this.prisma.property.findUnique({
      where: { id: input.propertyId },
      include: { customer: true },
    });
    if (!property) throw new AppError(404, "Property not found");

    if (input.serviceId) {
      const service = await this.prisma.service.findUnique({ where: { id: input.serviceId } });
      if (!service || !service.active) throw new AppError(404, "Service not found");
    }

    if (input.technicianId) {
      const tech = await this.prisma.technician.findUnique({
        where: { id: input.technicianId },
        select: { id: true, profileId: true },
      });
      if (!tech) throw new AppError(404, "Technician not found");
      if (tech.profileId === null) throw new AppError(400, "Technician has not accepted their invite");
    }

    if (input.roundId) {
      const round = await this.prisma.round.findUnique({ where: { id: input.roundId } });
      if (!round) throw new AppError(404, "Round not found");
    }

    const visit = await this.prisma.visit.create({
      data: {
        propertyId: input.propertyId,
        date: new Date(`${input.date}T00:00:00.000Z`),
        price: input.price,
        isOneOff: true,
        status: VisitStatus.SCHEDULED,
        servicePlanId: null,
        paymentHold: false,
        serviceId: input.serviceId ?? null,
        technicianId: input.technicianId ?? null,
        roundId: input.roundId ?? null,
        notes: input.notes ?? null,
        paymentMethod: input.paymentMethod ?? null,
      },
      include: {
        property: { include: { customer: true } },
        round: true,
        service: true,
        technician: true,
      },
    });

    return {
      id: visit.id,
      date: visit.date.toISOString().slice(0, 10),
      status: visit.status,
      isOneOff: visit.isOneOff,
      price: visit.price.toNumber(),
      notes: visit.notes,
      paymentMethod: visit.paymentMethod ?? null,
      propertyId: visit.propertyId,
      addressLine: visit.property.addressLine,
      postcode: visit.property.postcode,
      customerId: visit.property.customer.id,
      customerName: visit.property.customer.name,
      roundId: visit.roundId,
      roundName: visit.round?.name ?? null,
      serviceId: visit.serviceId,
      serviceName: visit.service?.name ?? null,
      technicianId: visit.technicianId,
      technicianName: visit.technician?.name ?? null,
    };
  }
}

export function createVisitService(prisma: TenantPrismaClient): IVisitService {
  return new VisitService(prisma);
}
