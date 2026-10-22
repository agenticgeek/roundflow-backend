import { it, expect, vi } from "vitest";
import { createTechnicianService } from "../technician.service";
import { VisitStatus } from "../../generated/tenant-client";

function makePrisma() {
  return {
    technician: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    visit: { groupBy: vi.fn(), findMany: vi.fn() },
    serviceArea: { findUnique: vi.fn() },
    technicianServiceArea: { deleteMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn((cb: any) => cb(makePrisma())),
  } as unknown as Parameters<typeof createTechnicianService>[0];
}

function makeTech(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1", name: "James", phone: null, role: null, email: null, notes: null,
    active: true, profileId: "p1", createdAt: new Date(),
    serviceAreas: [],
    roundTechnicians: [],
    ...overrides,
  };
}

// ---- listTechnicians --------------------------------------------------------

it("listTechnicians is a function", () => {
  expect(typeof createTechnicianService(makePrisma()).listTechnicians).toBe("function");
});

it("listTechnicians returns roundNames derived from roundTechnicians", async () => {
  const prisma = makePrisma();
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeTech({ roundTechnicians: [{ round: { name: "Alnwick Monday" } }, { round: { name: "Morpeth Tuesday" } }] }),
  ]);
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createTechnicianService(prisma).listTechnicians();

  expect(result[0].roundNames).toEqual(["Alnwick Monday", "Morpeth Tuesday"]);
});

it("listTechnicians defaults todayStats to all-zero when the technician has no visits today", async () => {
  const prisma = makePrisma();
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeTech()]);
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createTechnicianService(prisma).listTechnicians();

  expect(result[0].todayStats).toEqual({ total: 0, completed: 0, skipped: 0, remaining: 0 });
});

it("listTechnicians aggregates today's completed/skipped/remaining/total from a single groupBy query", async () => {
  const prisma = makePrisma();
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeTech({ id: "t1" }),
    makeTech({ id: "t2" }),
  ]);
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: "t1", status: VisitStatus.COMPLETED, _count: 3 },
    { technicianId: "t1", status: VisitStatus.SKIPPED, _count: 1 },
    { technicianId: "t1", status: VisitStatus.SCHEDULED, _count: 2 },
    { technicianId: "t1", status: VisitStatus.IN_PROGRESS, _count: 1 },
    { technicianId: "t2", status: VisitStatus.COMPLETED, _count: 5 },
  ]);

  const result = await createTechnicianService(prisma).listTechnicians();

  const t1 = result.find((r) => r.id === "t1")!;
  const t2 = result.find((r) => r.id === "t2")!;
  expect(t1.todayStats).toEqual({ total: 7, completed: 3, skipped: 1, remaining: 3 });
  expect(t2.todayStats).toEqual({ total: 5, completed: 5, skipped: 0, remaining: 0 });
  expect(prisma.visit.groupBy).toHaveBeenCalledTimes(1);
});

it("listTechnicians ignores a groupBy row with a null technicianId (defensive, shouldn't occur given the where filter)", async () => {
  const prisma = makePrisma();
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeTech({ id: "t1" })]);
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
    { technicianId: null, status: VisitStatus.COMPLETED, _count: 1 },
  ]);

  const result = await createTechnicianService(prisma).listTechnicians();

  expect(result[0].todayStats).toEqual({ total: 0, completed: 0, skipped: 0, remaining: 0 });
});

it("listTechnicians scopes the groupBy query to today's date range and non-null technicianId", async () => {
  const prisma = makePrisma();
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  await createTechnicianService(prisma).listTechnicians();

  const call = (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(call.by).toEqual(["technicianId", "status"]);
  expect(call.where.technicianId).toEqual({ not: null });
  expect(call.where.date.gte).toBeInstanceOf(Date);
  expect(call.where.date.lt).toBeInstanceOf(Date);
});

it("listTechnicians still includes the base technician record fields (toRecord mapping)", async () => {
  const prisma = makePrisma();
  (prisma.technician.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeTech({ id: "t1", name: "James", active: true, profileId: "p1" }),
  ]);
  (prisma.visit.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createTechnicianService(prisma).listTechnicians();

  expect(result[0]).toMatchObject({ id: "t1", name: "James", appStatus: "ACTIVE" });
});
