import { PaymentMethod, VisitStatus } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { notifyVisitTechnicians } from "./notify";
import { isLocationApproximate } from "../integrations/geocoding/client";
import { assertCalendarDate } from "../lib/validation";

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
  latitude: number | null;
  longitude: number | null;
  geocodePrecision: string | null;
  locationApproximate: boolean;
  customerId: string;
  customerName: string;
  roundId: string | null;
  roundName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  technicianId: string | null;
  technicianName: string | null;
}


export interface VisitAssignment {
  id: string;
  status: string;
  technicianId: string | null;
  technicianName: string | null;
  technicianOverride: boolean;
}

class VisitService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  // B2: assign / unassign ONE visit. SCHEDULED visits only. The change is a
  // manual decision, so technicianOverride is set (also when unassigning) and
  // later restamps (round technician / allocation changes) leave the visit alone.
  async assignVisit(visitId: string, technicianId: string | null): Promise<VisitAssignment> {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      select: { id: true, status: true, technicianId: true, date: true, roundId: true, propertyId: true },
    });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.status !== VisitStatus.SCHEDULED) {
      throw new AppError(409, `Only SCHEDULED visits can be assigned or unassigned (this visit is ${visit.status})`, "VISIT_NOT_SCHEDULED");
    }
    if (technicianId !== null) {
      const tech = await this.prisma.technician.findUnique({
        where: { id: technicianId },
        select: { id: true, active: true, profileId: true },
      });
      if (!tech) throw new AppError(404, "Technician not found");
      if (tech.profileId === null) throw new AppError(400, "Technician has not accepted their invite");
      if (!tech.active) throw new AppError(400, "Technician is inactive", "TECHNICIAN_INACTIVE");
    }
    const updated = await this.prisma.visit.update({
      where: { id: visitId },
      data: { technicianId, technicianOverride: true },
      include: { technician: { select: { name: true } } },
    });
    // FLOW-03: tell the technician who gained the visit and the one who lost it. Best effort.
    if (visit.technicianId !== technicianId) {
      if (technicianId) {
        await notifyVisitTechnicians(
          this.prisma,
          [{ ...visit, technicianId }],
          ({ first }) => ({ type: "SCHEDULE", title: "1 visit assigned to you", body: `Visit on ${first}.` })
        );
      }
      if (visit.technicianId) {
        await notifyVisitTechnicians(
          this.prisma,
          [visit],
          ({ first }) => ({ type: "SCHEDULE", title: "1 visit moved off your schedule", body: `Visit on ${first} was reassigned.` })
        );
      }
    }
    return {
      id: updated.id,
      status: updated.status,
      technicianId: updated.technicianId,
      technicianName: updated.technician?.name ?? null,
      technicianOverride: updated.technicianOverride,
    };
  }

  async createVisit(input: VisitCreateInput): Promise<VisitDetail> {
    assertCalendarDate(input.date, "date"); // BUG-007: 2026-02-30 used to roll over to 2026-03-02
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
      latitude: visit.property.latitude,
      longitude: visit.property.longitude,
      geocodePrecision: visit.property.geocodePrecision,
      locationApproximate: isLocationApproximate(visit.property.geocodePrecision, visit.property.latitude),
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

export function createVisitService(prisma: TenantPrismaClient) {
  return new VisitService(prisma);
}
