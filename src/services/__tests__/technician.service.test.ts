import { it, expect, vi } from "vitest";
import { createTechnicianService } from "../technician.service";
import { VisitStatus, Prisma } from "../../generated/tenant-client";
import { AppError } from "../../lib/app-error";

function uniqueConstraintError() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`email`)", {
    code: "P2002",
    clientVersion: "6.19.3",
  });
}

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

// ---- updateTechnician --------------------------------------------------------
// Regression coverage for the PATCH /technicians/:id 500: updating a
// technician to an email already used by another technician hits the
// @unique constraint on Technician.email. createTechnician already mapped
// that P2002 to a 409; updateTechnician didn't, so it fell through to the
// generic 500 handler instead of a clean "already exists" error.

it("updateTechnician maps a duplicate-email unique constraint violation to a 409, not an unhandled error", async () => {
  const prisma = makePrisma();
  const txPrisma = {
    ...makePrisma(),
    technician: {
      ...makePrisma().technician,
      findUnique: vi.fn().mockResolvedValue(makeTech({ id: "t1" })),
      update: vi.fn().mockRejectedValue(uniqueConstraintError()),
    },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));

  const promise = createTechnicianService(prisma).updateTechnician("t1", {
    email: "taken@example.com",
  });

  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({
    statusCode: 409,
    message: "A technician with this email already exists",
  });
});

it("updateTechnician propagates non-unique-constraint errors unchanged", async () => {
  const prisma = makePrisma();
  const boom = new Error("connection lost");
  const txPrisma = {
    ...makePrisma(),
    technician: {
      ...makePrisma().technician,
      findUnique: vi.fn().mockResolvedValue(makeTech({ id: "t1" })),
      update: vi.fn().mockRejectedValue(boom),
    },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));

  await expect(
    createTechnicianService(prisma).updateTechnician("t1", { email: "new@example.com" })
  ).rejects.toBe(boom);
});

it("updateTechnician returns the updated record when the write succeeds", async () => {
  const prisma = makePrisma();
  const txPrisma = {
    ...makePrisma(),
    technician: {
      ...makePrisma().technician,
      findUnique: vi.fn().mockResolvedValue(makeTech({ id: "t1" })),
      update: vi.fn().mockResolvedValue(makeTech({ id: "t1", email: "new@example.com" })),
    },
  };
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => cb(txPrisma));

  const result = await createTechnicianService(prisma).updateTechnician("t1", {
    email: "new@example.com",
  });

  expect(result.email).toBe("new@example.com");
});

// ---- getPerformance (GAP-030) ----------------------------------------------

it("getPerformance 404s for an unknown technician", async () => {
  const prisma = makePrisma();
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(
    createTechnicianService(prisma).getPerformance("x", "thisMonth", new Date())
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("getPerformance maps the shared KPI calc for the period (zeroed when no data)", async () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const prisma = {
    ...makePrisma(),
    technician: { findUnique: vi.fn().mockResolvedValue({ id: "t1" }) },
    visit: {
      findMany: vi.fn().mockResolvedValue([
        {
          technicianId: "t1", price: 40,
          startedAt: new Date("2026-10-02T09:00:00Z"), completedAt: new Date("2026-10-02T09:40:00Z"),
          _count: { issues: 0 },
        },
      ]),
    },
    technicianIncident: { groupBy: vi.fn().mockResolvedValue([]) },
    complaint: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as Parameters<typeof createTechnicianService>[0];

  const perf = await createTechnicianService(prisma).getPerformance("t1", "thisMonth", now);
  expect(perf).toEqual({
    technicianId: "t1",
    period: "thisMonth",
    from: new Date("2026-10-01T00:00:00Z"),
    to: new Date("2026-11-01T00:00:00Z"),
    visitsCompleted: 1,
    revenue: 40,
    timeOnJobMinutes: 40,
    revenuePerHour: 60,
    strikes: 0,
    damages: 0,
    upsells: 0,
    upsellValue: 0,
    complaints: 0,
  });

  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const empty = await createTechnicianService(prisma).getPerformance("t1", "lastMonth", now);
  expect(empty).toMatchObject({ visitsCompleted: 0, timeOnJobMinutes: null, revenuePerHour: null });
});
