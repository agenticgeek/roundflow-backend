import { it, expect, vi } from "vitest";
import { createTechnicianIncidentService } from "../technician-incident.service";

function makeTp() {
  return {
    technician: { findUnique: vi.fn().mockResolvedValue({ id: "t1" }) },
    visit: { findUnique: vi.fn().mockResolvedValue({ id: "v1" }) },
    technicianIncident: {
      create: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  } as any;
}

const ROW = {
  id: "i1",
  technicianId: "t1",
  visitId: "v1",
  type: "UPSELL",
  amount: { toString: () => "12.5", valueOf: () => 12.5 },
  note: "Gutters",
  createdById: "prof1",
  createdAt: new Date("2026-10-30"),
};

it("create 404s for an unknown technician or visit", async () => {
  const tp = makeTp();
  tp.technician.findUnique.mockResolvedValueOnce(null);
  await expect(
    createTechnicianIncidentService(tp).create("x", { type: "STRIKE" as never, note: "n", createdById: null })
  ).rejects.toMatchObject({ statusCode: 404, message: "Technician not found" });

  tp.visit.findUnique.mockResolvedValueOnce(null);
  await expect(
    createTechnicianIncidentService(tp).create("t1", { type: "STRIKE" as never, note: "n", visitId: "v9", createdById: null })
  ).rejects.toMatchObject({ statusCode: 404, message: "Visit not found" });
});

it("create writes the incident and maps amount to a number", async () => {
  const tp = makeTp();
  tp.technicianIncident.create.mockResolvedValue(ROW);
  const row = await createTechnicianIncidentService(tp).create("t1", {
    type: "UPSELL" as never,
    amount: 12.5,
    note: "Gutters",
    visitId: "v1",
    createdById: "prof1",
  });
  expect(tp.technicianIncident.create).toHaveBeenCalledWith({
    data: { technicianId: "t1", type: "UPSELL", amount: 12.5, note: "Gutters", visitId: "v1", createdById: "prof1" },
  });
  expect(row.amount).toBe(12.5);
});

it("create defaults amount and visitId to null", async () => {
  const tp = makeTp();
  tp.technicianIncident.create.mockResolvedValue({ ...ROW, amount: null, visitId: null });
  const row = await createTechnicianIncidentService(tp).create("t1", { type: "STRIKE" as never, note: "Late", createdById: null });
  expect(tp.technicianIncident.create.mock.calls[0][0].data).toMatchObject({ amount: null, visitId: null });
  expect(tp.visit.findUnique).not.toHaveBeenCalled();
  expect(row.amount).toBeNull();
});

it("list filters by type and inclusive date range, and paginates", async () => {
  const tp = makeTp();
  tp.technicianIncident.count.mockResolvedValue(3);
  tp.technicianIncident.findMany.mockResolvedValue([ROW]);
  const res = await createTechnicianIncidentService(tp).list("t1", {
    type: "UPSELL" as never,
    from: new Date("2026-10-01T00:00:00Z"),
    to: new Date("2026-10-31T00:00:00Z"),
    page: 2,
    pageSize: 2,
  });
  const where = {
    technicianId: "t1",
    type: "UPSELL",
    createdAt: { gte: new Date("2026-10-01T00:00:00Z"), lt: new Date("2026-11-01T00:00:00Z") },
  };
  expect(tp.technicianIncident.count).toHaveBeenCalledWith({ where });
  expect(tp.technicianIncident.findMany.mock.calls[0][0]).toMatchObject({ where, skip: 2, take: 2 });
  expect(res.pagination).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
  expect(res.rows[0].id).toBe("i1");
});

it("list with only `from` or no filters", async () => {
  const tp = makeTp();
  tp.technicianIncident.count.mockResolvedValue(0);
  tp.technicianIncident.findMany.mockResolvedValue([]);
  const svc = createTechnicianIncidentService(tp);
  await svc.list("t1", { from: new Date("2026-10-01"), page: 1, pageSize: 50 });
  expect(tp.technicianIncident.count.mock.calls[0][0].where).toEqual({
    technicianId: "t1",
    createdAt: { gte: new Date("2026-10-01") },
  });
  await svc.list("t1", { to: new Date("2026-10-01T00:00:00Z"), page: 1, pageSize: 50 });
  expect(tp.technicianIncident.count.mock.calls[1][0].where.createdAt).toEqual({ lt: new Date("2026-10-02T00:00:00Z") });
  await svc.list("t1", { page: 1, pageSize: 50 });
  expect(tp.technicianIncident.count.mock.calls[2][0].where).toEqual({ technicianId: "t1" });
});

it("list 404s for an unknown technician", async () => {
  const tp = makeTp();
  tp.technician.findUnique.mockResolvedValue(null);
  await expect(createTechnicianIncidentService(tp).list("x", { page: 1, pageSize: 50 })).rejects.toMatchObject({ statusCode: 404 });
});

it("remove 404s for an unknown incident and deletes otherwise", async () => {
  const tp = makeTp();
  tp.technicianIncident.findUnique.mockResolvedValueOnce(null);
  await expect(createTechnicianIncidentService(tp).remove("x")).rejects.toMatchObject({ statusCode: 404 });

  tp.technicianIncident.findUnique.mockResolvedValueOnce({ id: "i1" });
  await createTechnicianIncidentService(tp).remove("i1");
  expect(tp.technicianIncident.delete).toHaveBeenCalledWith({ where: { id: "i1" } });
});
