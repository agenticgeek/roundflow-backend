import { LifecycleStatus, VisitStatus, Prisma } from "../generated/tenant-client";
import type { ServicePlan } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { startOfUtcDay } from "../lib/schedule";

// BUG-08: change the set of services on a property after it was created.
// PUT /properties/:id/services { serviceIds, prices? } replaces the property's
// service list in one transaction:
//  - added service    -> a new ServicePlan at the catalogue price (or the
//                        `prices` override), inheriting frequency, payment
//                        method, clean method, nextDueDate (and a pause
//                        window) from the property's primary plan, plus a
//                        mirrored SCHEDULED visit when the primary plan has an
//                        upcoming one;
//  - removed service  -> its plan is CANCELLED and its SCHEDULED visits are
//                        CANCELLED (reason SERVICE_REMOVED), like pausePlan();
//  - kept service     -> untouched, unless `prices` names it: the plan price
//                        and the price of its upcoming SCHEDULED visits that
//                        were not hand-adjusted (originalPrice null) change.
// Completed / in-progress / skipped visits and every invoice are never touched.
// Every change is written to ActivityLog (PROPERTY_SERVICES_CHANGED).

export const CANCEL_REASON_SERVICE_REMOVED = "SERVICE_REMOVED";
export const ACTIVITY_PROPERTY_SERVICES_CHANGED = "PROPERTY_SERVICES_CHANGED";

export interface PropertyServicesInput {
  serviceIds: string[];
  /** serviceId -> price override (>= 0). Applies to added and kept services. */
  prices?: Record<string, number>;
}

export interface PropertyServicesActor {
  id?: string | null;
  role?: string | null;
}

export interface PlanSnapshot {
  servicePlanId: string;
  serviceId: string | null;
  serviceName: string | null;
  price: number;
}

export interface PropertyServicesResult {
  propertyId: string;
  servicePlans: Array<PlanSnapshot & { status: LifecycleStatus }>;
  totalPrice: number;
  added: string[]; // serviceIds
  removed: string[]; // serviceIds
  cancelledVisits: number;
}

export interface PropertyServicesHistoryEntry {
  id: string;
  changedAt: Date;
  actorId: string | null;
  actorRole: string | null;
  oldServices: PlanSnapshot[];
  newServices: PlanSnapshot[];
  added: string[];
  removed: string[];
}

const LIVE = [LifecycleStatus.ACTIVE, LifecycleStatus.PAUSED];

const snapshot = (p: { id: string; serviceId: string | null; price: Prisma.Decimal | number; service?: { name: string } | null }): PlanSnapshot => ({
  servicePlanId: p.id,
  serviceId: p.serviceId,
  serviceName: p.service?.name ?? null,
  price: Number(p.price),
});

export function createPropertyServicesService(tp: TenantPrismaClient) {
  return {
    async setServices(
      propertyId: string,
      input: PropertyServicesInput,
      actor: PropertyServicesActor,
      now: Date = new Date()
    ): Promise<PropertyServicesResult> {
      const serviceIds = [...new Set(input.serviceIds)];
      if (serviceIds.length === 0) {
        throw new AppError(400, "serviceIds must contain at least one service", "SERVICES_REQUIRED");
      }
      const prices = input.prices ?? {};
      for (const [id, price] of Object.entries(prices)) {
        if (!serviceIds.includes(id)) throw new AppError(400, `prices contains a service that is not in serviceIds: ${id}`);
        if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
          throw new AppError(400, `prices.${id} must be a number >= 0`);
        }
      }

      const property = await tp.property.findUnique({ where: { id: propertyId }, select: { id: true, status: true } });
      if (!property) throw new AppError(404, "Property not found");
      if (property.status === LifecycleStatus.CANCELLED) {
        throw new AppError(409, "Cannot change the services of a cancelled property");
      }

      const catalogue = await tp.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true, defaultPrice: true, active: true } });
      const byId = new Map(catalogue.map((s) => [s.id, s]));
      const unknown = serviceIds.find((id) => !byId.has(id));
      if (unknown) throw new AppError(404, `Service not found: ${unknown}`);

      const today = startOfUtcDay(now);

      return tp.$transaction(async (tx) => {
        const plans = await tx.servicePlan.findMany({
          where: { propertyId, status: { in: LIVE } },
          orderBy: { createdAt: "asc" },
          include: { service: { select: { name: true } } },
        });
        const primary = plans.find((p) => p.status === LifecycleStatus.ACTIVE) ?? plans[0];
        if (!primary) throw new AppError(409, "Property has no active service plan to base the new services on");

        const oldServices = plans.map(snapshot);
        const keptByService = new Map(plans.filter((p) => p.serviceId).map((p) => [p.serviceId as string, p]));
        const removedPlans = plans.filter((p) => p.serviceId && !serviceIds.includes(p.serviceId));
        const addedIds = serviceIds.filter((id) => !keptByService.has(id));

        // New services must be active; services the property already has may
        // stay even if they were deactivated in the catalogue since.
        for (const id of addedIds) {
          if (!byId.get(id)!.active) {
            throw new AppError(400, `Service is inactive and cannot be added: ${byId.get(id)!.name}`, "SERVICE_INACTIVE");
          }
        }

        // A legacy plan with no service adopts the first added service instead
        // of leaving a service-less plan next to the new ones.
        const adopt = plans.find((p) => !p.serviceId);
        const toCreate = [...addedIds];
        const touched: ServicePlan[] = [];
        if (adopt && toCreate.length > 0) {
          const id = toCreate.shift()!;
          touched.push(
            await tx.servicePlan.update({
              where: { id: adopt.id },
              data: { serviceId: id, price: prices[id] ?? Number(byId.get(id)!.defaultPrice) },
            })
          );
        }

        // Upcoming visit of the primary plan, mirrored for each new plan.
        const upcoming = toCreate.length > 0
          ? await tx.visit.findFirst({
              where: { servicePlanId: primary.id, status: VisitStatus.SCHEDULED, date: { gte: today } },
              orderBy: { date: "asc" },
            })
          : null;

        for (const id of toCreate) {
          const price = prices[id] ?? Number(byId.get(id)!.defaultPrice);
          const plan = await tx.servicePlan.create({
            data: {
              propertyId,
              serviceId: id,
              price,
              cleanMethod: primary.cleanMethod,
              paymentMethod: primary.paymentMethod,
              cleaningFrequency: primary.cleaningFrequency,
              nextDueDate: primary.nextDueDate,
              status: primary.status,
              pauseStartDate: primary.pauseStartDate,
              pauseEndDate: primary.pauseEndDate,
            },
          });
          touched.push(plan);
          if (upcoming && primary.status === LifecycleStatus.ACTIVE) {
            await tx.visit.create({
              data: {
                propertyId,
                roundId: upcoming.roundId,
                servicePlanId: plan.id,
                serviceId: id,
                date: upcoming.date,
                price,
                isOneOff: false,
                status: VisitStatus.SCHEDULED,
                paymentHold: false,
                paymentMethod: upcoming.paymentMethod,
                technicianId: upcoming.technicianId,
                technicianOverride: upcoming.technicianOverride,
              },
            });
          }
        }

        let cancelledVisits = 0;
        for (const plan of removedPlans) {
          const cancelled = await tx.visit.updateMany({
            where: { servicePlanId: plan.id, status: VisitStatus.SCHEDULED },
            data: { status: VisitStatus.CANCELLED, cancelReason: CANCEL_REASON_SERVICE_REMOVED },
          });
          cancelledVisits += cancelled.count;
          await tx.servicePlan.update({ where: { id: plan.id }, data: { status: LifecycleStatus.CANCELLED } });
        }

        // Price changes on kept services (and their upcoming, un-adjusted visits).
        for (const [id, price] of Object.entries(prices)) {
          const kept = keptByService.get(id);
          if (!kept || Number(kept.price) === price) continue;
          touched.push(await tx.servicePlan.update({ where: { id: kept.id }, data: { price } }));
          await tx.visit.updateMany({
            where: { servicePlanId: kept.id, status: VisitStatus.SCHEDULED, date: { gte: today }, originalPrice: null },
            data: { price },
          });
        }

        const after = await tx.servicePlan.findMany({
          where: { propertyId, status: { in: LIVE } },
          orderBy: { createdAt: "asc" },
          include: { service: { select: { name: true } } },
        });
        const newServices = after.map(snapshot);
        const removed = removedPlans.map((p) => p.serviceId as string);

        await tx.activityLog.create({
          data: {
            type: ACTIVITY_PROPERTY_SERVICES_CHANGED,
            message: `Services changed on property ${propertyId}: ${[
              ...addedIds.map((id) => `+${byId.get(id)!.name}`),
              ...removedPlans.map((p) => `-${p.service?.name ?? p.serviceId}`),
            ].join(", ") || "prices updated"}`,
            details: { oldServices, newServices, added: addedIds, removed } as unknown as Prisma.InputJsonValue,
            actorId: actor.id ?? null,
            actorRole: actor.role ?? null,
            entityId: propertyId,
          },
        });

        return {
          propertyId,
          servicePlans: after.map((p) => ({ ...snapshot(p), status: p.status })),
          totalPrice: Math.round(newServices.reduce((sum, s) => sum + s.price, 0) * 100) / 100,
          added: addedIds,
          removed,
          cancelledVisits,
        };
      });
    },

    async history(
      propertyId: string,
      page: number,
      pageSize: number
    ): Promise<{ rows: PropertyServicesHistoryEntry[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
      const property = await tp.property.findUnique({ where: { id: propertyId }, select: { id: true } });
      if (!property) throw new AppError(404, "Property not found");
      const where = { type: ACTIVITY_PROPERTY_SERVICES_CHANGED, entityId: propertyId };
      const [total, logs] = await Promise.all([
        tp.activityLog.count({ where }),
        tp.activityLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      ]);
      return {
        rows: logs.map((l) => {
          const parsed = (l.details ?? {}) as {
            oldServices?: PlanSnapshot[];
            newServices?: PlanSnapshot[];
            added?: string[];
            removed?: string[];
          };
          return {
            id: l.id,
            changedAt: l.createdAt,
            actorId: l.actorId,
            actorRole: l.actorRole,
            oldServices: parsed.oldServices ?? [],
            newServices: parsed.newServices ?? [],
            added: parsed.added ?? [],
            removed: parsed.removed ?? [],
          };
        }),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      };
    },
  };
}
