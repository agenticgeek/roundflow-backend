import { it, expect, vi } from "vitest";
import { createPropertyServicesService } from "../property-services";

const NOW = new Date("2026-11-03T10:00:00Z");

type Plan = Record<string, unknown>;
const plan = (id: string, serviceId: string | null, extra: Plan = {}): Plan => ({
  id, serviceId, price: 20, status: "ACTIVE", cleanMethod: "TRADITIONAL", paymentMethod: "CASH",
  cleaningFrequency: "FOUR_WEEKLY", nextDueDate: new Date("2026-12-01T00:00:00Z"), pauseStartDate: null, pauseEndDate: null,
  service: serviceId ? { name: `Svc ${serviceId}` } : null, ...extra,
});
const svcRow = (id: string, active = true, defaultPrice = 15) => ({ id, name: `Svc ${id}`, defaultPrice, active });

function makeTp(opts: { plans?: Plan[]; after?: Plan[]; catalogue?: unknown[]; property?: unknown; upcoming?: unknown } = {}) {
  const plans = opts.plans ?? [plan("sp1", "a")];
  const tx: any = {
    servicePlan: {
      findMany: vi.fn().mockResolvedValueOnce(plans).mockResolvedValueOnce(opts.after ?? plans),
      create: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "spNew", ...data })),
      update: vi.fn().mockImplementation(({ where, data }: any) => Promise.resolve({ id: where.id, ...data })),
    },
    visit: {
      findFirst: vi.fn().mockResolvedValue(
        opts.upcoming === undefined
          ? { date: new Date("2026-11-10T00:00:00Z"), roundId: "r1", technicianId: "t1", technicianOverride: false, paymentMethod: "CASH" }
          : opts.upcoming
      ),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const tp: any = {
    property: { findUnique: vi.fn().mockResolvedValue(opts.property === undefined ? { id: "p1", status: "ACTIVE" } : opts.property) },
    service: { findMany: vi.fn().mockResolvedValue(opts.catalogue ?? [svcRow("a"), svcRow("b")]) },
    activityLog: { count: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn((cb: any) => cb(tx)),
  };
  return { tp, tx };
}
const actor = { id: "u1", role: "ADMIN" };

it("rejects an empty list and bad prices before touching the DB", async () => {
  const { tp } = makeTp();
  const svc = createPropertyServicesService(tp);
  await expect(svc.setServices("p1", { serviceIds: [] }, actor, NOW)).rejects.toMatchObject({ statusCode: 400, code: "SERVICES_REQUIRED" });
  await expect(svc.setServices("p1", { serviceIds: ["a"], prices: { zzz: 5 } }, actor, NOW)).rejects.toMatchObject({ statusCode: 400 });
  await expect(svc.setServices("p1", { serviceIds: ["a"], prices: { a: -1 } }, actor, NOW)).rejects.toMatchObject({ statusCode: 400 });
  expect(tp.$transaction).not.toHaveBeenCalled();
});

it("404 unknown property / service, 409 cancelled property, 400 inactive added service", async () => {
  await expect(createPropertyServicesService(makeTp({ property: null }).tp).setServices("p1", { serviceIds: ["a"] }, actor, NOW)).rejects.toMatchObject({ statusCode: 404 });
  await expect(createPropertyServicesService(makeTp({ property: { id: "p1", status: "CANCELLED" } }).tp).setServices("p1", { serviceIds: ["a"] }, actor, NOW)).rejects.toMatchObject({ statusCode: 409 });
  await expect(createPropertyServicesService(makeTp({ catalogue: [] }).tp).setServices("p1", { serviceIds: ["a"] }, actor, NOW)).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    createPropertyServicesService(makeTp({ catalogue: [svcRow("a"), svcRow("b", false)] }).tp).setServices("p1", { serviceIds: ["a", "b"] }, actor, NOW)
  ).rejects.toMatchObject({ statusCode: 400, code: "SERVICE_INACTIVE" });
});

it("409 when the property has no live plan", async () => {
  await expect(createPropertyServicesService(makeTp({ plans: [] }).tp).setServices("p1", { serviceIds: ["a"] }, actor, NOW)).rejects.toMatchObject({ statusCode: 409 });
});

it("adds a service at catalogue price inheriting the primary plan, mirrors the upcoming visit, logs history", async () => {
  const after = [plan("sp1", "a"), plan("spNew", "b", { price: 15 })];
  const { tp, tx } = makeTp({ after });
  const out = await createPropertyServicesService(tp).setServices("p1", { serviceIds: ["a", "b"] }, actor, NOW);
  expect(tx.servicePlan.create.mock.calls[0][0].data).toMatchObject({
    propertyId: "p1", serviceId: "b", price: 15, cleanMethod: "TRADITIONAL", paymentMethod: "CASH",
    cleaningFrequency: "FOUR_WEEKLY", nextDueDate: new Date("2026-12-01T00:00:00Z"), status: "ACTIVE",
  });
  expect(tx.visit.create.mock.calls[0][0].data).toMatchObject({
    servicePlanId: "spNew", serviceId: "b", price: 15, date: new Date("2026-11-10T00:00:00Z"), roundId: "r1", technicianId: "t1", status: "SCHEDULED", paymentHold: false,
  });
  expect(tx.visit.updateMany).not.toHaveBeenCalled();
  expect(out).toMatchObject({ added: ["b"], removed: [], totalPrice: 35, cancelledVisits: 0 });
  const log = tx.activityLog.create.mock.calls[0][0].data;
  expect(log).toMatchObject({ type: "PROPERTY_SERVICES_CHANGED", actorId: "u1", actorRole: "ADMIN", entityId: "p1" });
  expect(log.details.oldServices).toHaveLength(1);
  expect(log.details.newServices).toHaveLength(2);
});

it("a price override applies to an added service; no upcoming visit means no mirrored visit; a paused primary creates a paused plan with no visit", async () => {
  const noVisit = makeTp({ upcoming: null });
  await createPropertyServicesService(noVisit.tp).setServices("p1", { serviceIds: ["a", "b"], prices: { b: 9.5 } }, actor, NOW);
  expect(noVisit.tx.servicePlan.create.mock.calls[0][0].data.price).toBe(9.5);
  expect(noVisit.tx.visit.create).not.toHaveBeenCalled();

  const paused = makeTp({ plans: [plan("sp1", "a", { status: "PAUSED", pauseStartDate: new Date("2026-11-01T00:00:00Z") })] });
  await createPropertyServicesService(paused.tp).setServices("p1", { serviceIds: ["a", "b"] }, actor, NOW);
  expect(paused.tx.servicePlan.create.mock.calls[0][0].data).toMatchObject({ status: "PAUSED", pauseStartDate: new Date("2026-11-01T00:00:00Z") });
  expect(paused.tx.visit.create).not.toHaveBeenCalled();
});

it("removes a service: plan CANCELLED, only SCHEDULED visits cancelled with a reason", async () => {
  const { tp, tx } = makeTp({ plans: [plan("sp1", "a"), plan("sp2", "b")], after: [plan("sp1", "a")] });
  const out = await createPropertyServicesService(tp).setServices("p1", { serviceIds: ["a"] }, actor, NOW);
  expect(tx.visit.updateMany).toHaveBeenCalledWith({
    where: { servicePlanId: "sp2", status: "SCHEDULED" },
    data: { status: "CANCELLED", cancelReason: "SERVICE_REMOVED" },
  });
  expect(tx.servicePlan.update).toHaveBeenCalledWith({ where: { id: "sp2" }, data: { status: "CANCELLED" } });
  expect(out).toMatchObject({ removed: ["b"], added: [], cancelledVisits: 2, totalPrice: 20 });
  expect(tx.activityLog.create.mock.calls[0][0].data.message).toContain("-Svc b");
});

it("re-prices a kept service and its upcoming un-adjusted SCHEDULED visits only; same price is a no-op", async () => {
  const { tp, tx } = makeTp({ after: [plan("sp1", "a", { price: 25 })] });
  await createPropertyServicesService(tp).setServices("p1", { serviceIds: ["a"], prices: { a: 25 } }, actor, NOW);
  expect(tx.servicePlan.update).toHaveBeenCalledWith({ where: { id: "sp1" }, data: { price: 25 } });
  expect(tx.visit.updateMany).toHaveBeenCalledWith({
    where: { servicePlanId: "sp1", status: "SCHEDULED", date: { gte: new Date("2026-11-03T00:00:00Z") }, originalPrice: null },
    data: { price: 25 },
  });
  expect(tx.activityLog.create.mock.calls[0][0].data.message).toContain("prices updated");

  const same = makeTp();
  await createPropertyServicesService(same.tp).setServices("p1", { serviceIds: ["a"], prices: { a: 20 } }, actor, NOW);
  expect(same.tx.visit.updateMany).not.toHaveBeenCalled();
});

it("a service-less legacy plan adopts the first added service", async () => {
  const { tp, tx } = makeTp({ plans: [plan("sp0", null)], after: [plan("sp0", "a", { price: 15 })] });
  const out = await createPropertyServicesService(tp).setServices("p1", { serviceIds: ["a"] }, actor, NOW);
  expect(tx.servicePlan.update).toHaveBeenCalledWith({ where: { id: "sp0" }, data: { serviceId: "a", price: 15 } });
  expect(tx.servicePlan.create).not.toHaveBeenCalled();
  expect(out.added).toEqual(["a"]);
});

it("history: 404 unknown property; maps details, tolerates entries without details", async () => {
  const { tp } = makeTp();
  tp.activityLog.count.mockResolvedValue(2);
  tp.activityLog.findMany.mockResolvedValue([
    { id: "l1", createdAt: new Date("2026-11-03"), actorId: "u1", actorRole: "ADMIN", details: { oldServices: [{ serviceId: "a" }], newServices: [], added: [], removed: ["a"] } },
    { id: "l2", createdAt: new Date("2026-11-02"), actorId: null, actorRole: null, details: null },
  ]);
  const out = await createPropertyServicesService(tp).history("p1", 2, 1);
  expect(tp.activityLog.findMany).toHaveBeenCalledWith({ where: { type: "PROPERTY_SERVICES_CHANGED", entityId: "p1" }, orderBy: { createdAt: "desc" }, skip: 1, take: 1 });
  expect(out.rows[0]).toMatchObject({ id: "l1", removed: ["a"] });
  expect(out.rows[1]).toMatchObject({ oldServices: [], newServices: [], added: [] });
  expect(out.pagination).toEqual({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
  tp.property.findUnique.mockResolvedValue(null);
  await expect(createPropertyServicesService(tp).history("x", 1, 10)).rejects.toMatchObject({ statusCode: 404 });
});
