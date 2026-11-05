import { it, expect, vi, beforeEach } from "vitest";

// resolvedBy names come from the control-plane Profile table.
const profileFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: { profile: { findMany: (...args: unknown[]) => profileFindMany(...args) } },
}));

import { createComplaintService } from "../complaint.service";

beforeEach(() => {
  profileFindMany.mockReset().mockResolvedValue([]);
});

function makePrisma() {
  const prisma = {
    complaint: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
    },
    customer: { findUnique: vi.fn() },
    property: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    technician: { findUnique: vi.fn(), findFirst: vi.fn() },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue([]) },
    visit: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
    message: { create: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  return prisma as unknown as Parameters<typeof createComplaintService>[0];
}

const baseComplaint = {
  id: "cmp1", status: "OPEN", severity: "LOW",
  title: "Missed clean", description: null, issueType: null,
  customerId: "c1", propertyId: null, technicianId: null,
  revisitDate: null, createdAt: new Date(),
  customer: { id: "c1", name: "Jane Doe" },
  property: null, technician: null, _count: { messages: 0 },
};

it("createComplaintService returns an object", () => {
  expect(createComplaintService(makePrisma())).toBeDefined();
});

it("logComplaint sets status OPEN by default", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.complaint.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "OPEN", severity: "LOW",
    title: "Missed clean", description: null, issueType: null,
    customerId: "c1", propertyId: null, technicianId: null,
    revisitDate: null, createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: null, technician: null, _count: { messages: 0 },
  });

  await createComplaintService(prisma).logComplaint({
    customerId: "c1",
    title: "Missed clean",
  });

  const args = (prisma.complaint.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.status).toBe("OPEN");
});

it("logComplaint throws 404 when customerId does not exist", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).logComplaint({
      customerId: "bad",
      title: "Missed clean",
    })
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("logComplaint throws 404 when propertyId does not exist", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).logComplaint({
      customerId: "c1",
      title: "Missed clean",
      propertyId: "bad",
    })
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("logComplaint throws 404 when technicianId does not exist", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).logComplaint({
      customerId: "c1",
      title: "Missed clean",
      technicianId: "bad",
    })
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("logComplaint succeeds when propertyId is given and the property exists", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.property.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "p1" });
  (prisma.complaint.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "OPEN", severity: "LOW",
    title: "Missed clean", description: null, issueType: null,
    customerId: "c1", propertyId: "p1", technicianId: null,
    revisitDate: null, createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: null, technician: null, _count: { messages: 0 },
  });

  const result = await createComplaintService(prisma).logComplaint({
    customerId: "c1",
    title: "Missed clean",
    propertyId: "p1",
  });

  expect(result.propertyId).toBe("p1");
});

it("logComplaint succeeds when technicianId is given and the technician has accepted their invite", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t1", profileId: "prof-1" });
  (prisma.complaint.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "OPEN", severity: "LOW",
    title: "Missed clean", description: null, issueType: null,
    customerId: "c1", propertyId: null, technicianId: "t1",
    revisitDate: null, createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: null, technician: null, _count: { messages: 0 },
  });

  const result = await createComplaintService(prisma).logComplaint({
    customerId: "c1",
    title: "Missed clean",
    technicianId: "t1",
  });

  expect(result.technicianId).toBe("t1");
});

it("logComplaint accepts a pending-invite technician (attribution only, GAP-029)", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t1" });
  (prisma.complaint.create as ReturnType<typeof vi.fn>).mockResolvedValue({ ...baseComplaint, technicianId: "t1" });

  const result = await createComplaintService(prisma).logComplaint({
    customerId: "c1",
    title: "Missed clean",
    technicianId: "t1",
  });

  expect(result.technicianId).toBe("t1");
  expect(prisma.technician.findUnique).toHaveBeenCalledWith({ where: { id: "t1" }, select: { id: true } });
});

it("logComplaint sets severity from input", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.complaint.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "OPEN", severity: "HIGH",
    title: "Rude technician", description: null, issueType: null,
    customerId: "c1", propertyId: null, technicianId: null,
    revisitDate: null, createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: null, technician: null, _count: { messages: 0 },
  });

  await createComplaintService(prisma).logComplaint({
    customerId: "c1",
    title: "Rude technician",
    severity: "HIGH",
  });

  const args = (prisma.complaint.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.severity).toBe("HIGH");
});

it("markInReview throws 404 when complaint does not exist", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).markInReview("bad")
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("markInReview sets status IN_REVIEW", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "IN_REVIEW", severity: "LOW",
    title: "Missed clean", description: null, issueType: null,
    customerId: "c1", propertyId: null, technicianId: null,
    revisitDate: null, createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: null, technician: null, _count: { messages: 0 },
  });

  await createComplaintService(prisma).markInReview("cmp1");

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.status).toBe("IN_REVIEW");
});

it("resolve throws 404 when complaint does not exist", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).resolve("bad")
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("resolve sets status RESOLVED", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "RESOLVED", severity: "LOW",
    title: "Missed clean", description: null, issueType: null,
    customerId: "c1", propertyId: null, technicianId: null,
    revisitDate: null, createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: null, technician: null, _count: { messages: 0 },
  });

  await createComplaintService(prisma).resolve("cmp1");

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.status).toBe("RESOLVED");
});

it("resolve defaults resolvedBy/notes to null and stamps resolvedAt when no options are given", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue(baseComplaint);

  await createComplaintService(prisma).resolve("cmp1");

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.resolvedBy).toBeNull();
  expect(args.data.notes).toBeNull();
  expect(args.data.resolvedAt).toBeInstanceOf(Date);
});

it("resolve persists the given notes and resolvedBy", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue(baseComplaint);

  await createComplaintService(prisma).resolve("cmp1", { notes: "Revisited and fixed", resolvedBy: "profile-1" });

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.notes).toBe("Revisited and fixed");
  expect(args.data.resolvedBy).toBe("profile-1");
  expect(args.data.upheld).toBeNull();
});

it("resolve stores upheld when given", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue(baseComplaint);

  await createComplaintService(prisma).resolve("cmp1", { upheld: false });

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.upheld).toBe(false);
});

it("scheduleRevisit throws 404 when complaint does not exist", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).scheduleRevisit("bad", "2026-09-10")
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("scheduleRevisit throws 400 for invalid date format", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });

  await expect(
    createComplaintService(prisma).scheduleRevisit("cmp1", "10-09-2026")
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("scheduleRevisit 400s for a nonexistent calendar date", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });

  await expect(
    createComplaintService(prisma).scheduleRevisit("cmp1", "2026-02-30")
  ).rejects.toMatchObject({ statusCode: 400 });
});

it("scheduleRevisit sets status REVISIT_BOOKED and revisitDate", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1", propertyId: null, technicianId: null });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "REVISIT_BOOKED", severity: "LOW",
    title: "Missed clean", description: null, issueType: null,
    customerId: "c1", propertyId: null, technicianId: null,
    revisitDate: new Date("2026-09-10T00:00:00.000Z"), createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: null, technician: null, _count: { messages: 0 },
  });

  const result = await createComplaintService(prisma).scheduleRevisit("cmp1", "2026-09-10");

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.status).toBe("REVISIT_BOOKED");
  expect(args.data.revisitDate).toEqual(new Date("2026-09-10T00:00:00.000Z"));
  // No property → nothing to visit.
  expect(result.visitId).toBeNull();
  expect(prisma.visit.create).not.toHaveBeenCalled();
});

// ── scheduleRevisit: one-off revisit visit (GAP-029) ────────────────────────

const REVISIT_DATE = new Date("2026-09-10T00:00:00.000Z");

function revisitPrisma(opts: {
  complaintTechnicianId?: string | null;
  complaintTech?: { id: string; active: boolean; profileId: string | null } | null;
  property?: Record<string, unknown>;
}) {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", propertyId: "p1", technicianId: opts.complaintTechnicianId ?? null,
  });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...baseComplaint, propertyId: "p1" });
  (prisma.property.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
    opts.property ?? { roundId: "r1", assignedTechnicianId: null, round: { roundTechnicians: [{ technicianId: "t9" }] } }
  );
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(opts.complaintTech ?? null);
  (prisma.visit.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v-new" });
  return prisma;
}

it("scheduleRevisit creates a free one-off visit pinned to the complaint's technician", async () => {
  const prisma = revisitPrisma({
    complaintTechnicianId: "t1",
    complaintTech: { id: "t1", active: true, profileId: "prof-1" },
  });

  const result = await createComplaintService(prisma).scheduleRevisit("cmp1", "2026-09-10");

  expect(result.visitId).toBe("v-new");
  expect(prisma.visit.create).toHaveBeenCalledWith({
    data: {
      date: REVISIT_DATE,
      roundId: "r1",
      technicianId: "t1",
      technicianOverride: true,
      propertyId: "p1",
      complaintId: "cmp1",
      isOneOff: true,
      status: "SCHEDULED",
      price: 0,
      paymentHold: false,
    },
    select: { id: true },
  });
  // Pinned technician: no availability lookup needed.
  expect(prisma.technicianAvailability.findMany).not.toHaveBeenCalled();
});

it("scheduleRevisit falls back to the round's technician when the complaint has none", async () => {
  const prisma = revisitPrisma({});

  await createComplaintService(prisma).scheduleRevisit("cmp1", "2026-09-10");

  expect(prisma.technician.findUnique).not.toHaveBeenCalled();
  const data = (prisma.visit.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
  expect(data).toMatchObject({ technicianId: "t9", technicianOverride: false });
});

it("scheduleRevisit falls back when the complaint's technician is pending-invite or inactive", async () => {
  for (const complaintTech of [
    { id: "t1", active: true, profileId: null },
    { id: "t1", active: false, profileId: "prof-1" },
  ]) {
    const prisma = revisitPrisma({ complaintTechnicianId: "t1", complaintTech });
    await createComplaintService(prisma).scheduleRevisit("cmp1", "2026-09-10");
    const data = (prisma.visit.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toMatchObject({ technicianId: "t9", technicianOverride: false });
  }
});

it("scheduleRevisit falls back when the complaint's technician no longer exists", async () => {
  const prisma = revisitPrisma({ complaintTechnicianId: "gone", complaintTech: null });
  await createComplaintService(prisma).scheduleRevisit("cmp1", "2026-09-10");
  const data = (prisma.visit.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
  expect(data.technicianId).toBe("t9");
});

it("scheduleRevisit leaves a property with no round unassigned", async () => {
  const prisma = revisitPrisma({ property: { roundId: null, assignedTechnicianId: null, round: null } });
  await createComplaintService(prisma).scheduleRevisit("cmp1", "2026-09-10");
  const data = (prisma.visit.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
  expect(data).toMatchObject({ roundId: null, technicianId: null });
});

it("scheduleRevisit skips a round technician who is unavailable on the date", async () => {
  const prisma = revisitPrisma({});
  (prisma.technicianAvailability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ technicianId: "t9" }]);
  await createComplaintService(prisma).scheduleRevisit("cmp1", "2026-09-10");
  const data = (prisma.visit.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
  expect(data.technicianId).toBeNull();
});

it("scheduleRevisit moves the complaint's open revisit visit instead of creating another", async () => {
  const prisma = revisitPrisma({});
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v-old" });

  const result = await createComplaintService(prisma).scheduleRevisit("cmp1", "2026-09-10");

  expect(result.visitId).toBe("v-old");
  expect(prisma.visit.create).not.toHaveBeenCalled();
  expect(prisma.visit.update).toHaveBeenCalledWith({
    where: { id: "v-old" },
    data: { date: REVISIT_DATE, roundId: "r1", technicianId: "t9", technicianOverride: false },
  });
});

it("reopen throws 404 when complaint does not exist", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).reopen("bad")
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("reopen sets status OPEN", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "OPEN", severity: "LOW",
    title: "Missed clean", description: null, issueType: null,
    customerId: "c1", propertyId: null, technicianId: null,
    revisitDate: null, createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: null, technician: null, _count: { messages: 0 },
  });

  await createComplaintService(prisma).reopen("cmp1");

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.status).toBe("OPEN");
});

it("reopen clears resolvedAt and resolvedBy", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue(baseComplaint);

  await createComplaintService(prisma).reopen("cmp1");

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.resolvedAt).toBeNull();
  expect(args.data.resolvedBy).toBeNull();
  expect(args.data.upheld).toBeNull();
});

it("assignTechnician throws 404 when complaint does not exist", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).assignTechnician("bad", "t1")
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("assignTechnician throws 404 when technician does not exist", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).assignTechnician("cmp1", "bad")
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("assignTechnician accepts a pending-invite technician (attribution only, GAP-029)", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t1" });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...baseComplaint, technicianId: "t1" });

  const result = await createComplaintService(prisma).assignTechnician("cmp1", "t1");

  expect(result.technicianId).toBe("t1");
});

it("assignTechnician sets technicianId on the complaint", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t1", profileId: "p1" });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "OPEN", severity: "LOW",
    title: "Missed clean", description: null, issueType: null,
    customerId: "c1", propertyId: null, technicianId: "t1",
    revisitDate: null, createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: null, technician: { id: "t1", name: "James" }, _count: { messages: 0 },
  });

  await createComplaintService(prisma).assignTechnician("cmp1", "t1");

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.technicianId).toBe("t1");
});


// ── listComplaints ──────────────────────────────────────────────────────────

it("listComplaints returns a paginated rows array", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createComplaintService(prisma).listComplaints({});
  expect(Array.isArray(result.rows)).toBe(true);
  expect(result.pagination).toEqual({ page: 1, pageSize: 50, total: 0, totalPages: 0 });
});

it("listComplaints threads page/pageSize into take/skip and returns matching pagination metadata", async () => {
  const prisma = makePrisma();
  (prisma.complaint.count as ReturnType<typeof vi.fn>).mockResolvedValue(120);
  (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createComplaintService(prisma).listComplaints({ page: 3, pageSize: 20 });

  const args = (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.take).toBe(20);
  expect(args.skip).toBe(40);
  expect(result.pagination).toEqual({ page: 3, pageSize: 20, total: 120, totalPages: 6 });
});

it("listComplaints maps each returned row through toDetail", async () => {
  const prisma = makePrisma();
  (prisma.complaint.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([baseComplaint]);

  const result = await createComplaintService(prisma).listComplaints({});

  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].id).toBe("cmp1");
  expect(result.rows[0].customerName).toBe("Jane Doe");
});

it("listComplaints clamps pageSize to a max of 100 and page to a min of 1", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createComplaintService(prisma).listComplaints({ page: 0, pageSize: 500 });

  const args = (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.take).toBe(100);
  expect(args.skip).toBe(0);
  expect(result.pagination.page).toBe(1);
  expect(result.pagination.pageSize).toBe(100);
});

it("listComplaints passes status filter to prisma", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  await createComplaintService(prisma).listComplaints({ status: "OPEN" });

  const args = (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.where.status).toBe("OPEN");
});

it("listComplaints passes search filter as OR clause to prisma", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  await createComplaintService(prisma).listComplaints({ search: "David" });

  const args = (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.where.OR).toBeDefined();
});

it("listComplaints passes technicianId filter to prisma", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  await createComplaintService(prisma).listComplaints({ technicianId: "t1" });

  const args = (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.where.technicianId).toBe("t1");
});

// ── getComplaint ────────────────────────────────────────────────────────────

it("getComplaint throws 404 when complaint does not exist", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).getComplaint("bad")
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("getComplaint returns the complaint", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(baseComplaint);

  const result = await createComplaintService(prisma).getComplaint("cmp1");
  expect(result.id).toBe("cmp1");
});

it("getComplaint maps technicianName, propertyAddress, messageCount, resolvedAt/resolvedBy and notes", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "RESOLVED", severity: "LOW",
    title: "Missed clean", description: null, issueType: null,
    customerId: "c1", propertyId: "p1", technicianId: "t1",
    revisitDate: null, createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: { id: "p1", addressLine: "12 Market Street" },
    technician: { id: "t1", name: "James Smith" },
    _count: { messages: 3 },
    resolvedAt: new Date("2026-02-01T00:00:00.000Z"),
    resolvedBy: "profile-1",
    notes: "Revisited and fixed",
  });

  const result = await createComplaintService(prisma).getComplaint("cmp1");

  expect(result).toMatchObject({
    technicianName: "James Smith",
    propertyAddress: "12 Market Street",
    messageCount: 3,
    resolvedAt: "2026-02-01T00:00:00.000Z",
    resolvedBy: { id: "profile-1", name: null },
    notes: "Revisited and fixed",
  });
});

it("getComplaint returns resolvedBy as { id, name } joined from Profile, and upheld", async () => {
  const prisma = makePrisma();
  profileFindMany.mockResolvedValue([{ id: "profile-1", name: "Mark Admin" }]);
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...baseComplaint, status: "RESOLVED", resolvedBy: "profile-1", upheld: true,
  });

  const result = await createComplaintService(prisma).getComplaint("cmp1");

  expect(result.resolvedBy).toEqual({ id: "profile-1", name: "Mark Admin" });
  expect(result.upheld).toBe(true);
  expect(profileFindMany).toHaveBeenCalledWith({ where: { id: { in: ["profile-1"] } }, select: { id: true, name: true } });
});

it("listComplaints looks up each distinct resolver once for the whole page", async () => {
  const prisma = makePrisma();
  profileFindMany.mockResolvedValue([{ id: "profile-1", name: "Mark Admin" }]);
  (prisma.complaint.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { ...baseComplaint, id: "a", resolvedBy: "profile-1" },
    { ...baseComplaint, id: "b", resolvedBy: "profile-1" },
    { ...baseComplaint, id: "c" },
  ]);

  const result = await createComplaintService(prisma).listComplaints({});

  expect(profileFindMany).toHaveBeenCalledTimes(1);
  expect(profileFindMany.mock.calls[0][0].where.id.in).toEqual(["profile-1"]);
  expect(result.rows.map((r) => r.resolvedBy)).toEqual([
    { id: "profile-1", name: "Mark Admin" },
    { id: "profile-1", name: "Mark Admin" },
    null,
  ]);
  expect(result.rows[2].upheld).toBeNull();
});

it("getComplaint defaults technicianName/propertyAddress/resolvedAt to null when unset", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(baseComplaint);

  const result = await createComplaintService(prisma).getComplaint("cmp1");

  expect(result.technicianName).toBeNull();
  expect(result.propertyAddress).toBeNull();
  expect(result.resolvedAt).toBeNull();
  expect(result.resolvedBy).toBeNull();
  expect(result.notes).toBeNull();
  expect(result.messageCount).toBe(0);
});

// ── getMessages ─────────────────────────────────────────────────────────────

it("getMessages throws 404 when complaint does not exist", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).getMessages("bad")
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("getMessages returns an array of messages for the complaint", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.message.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "msg1", direction: "INBOUND", body: "Not happy", channel: "EMAIL", createdAt: new Date(), complaintId: "cmp1" },
  ]);

  const result = await createComplaintService(prisma).getMessages("cmp1");
  expect(Array.isArray(result)).toBe(true);
  expect(result[0].id).toBe("msg1");
});

// ── addMessage ───────────────────────────────────────────────────────────────

it("addMessage throws 404 when complaint does not exist", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(
    createComplaintService(prisma).addMessage("bad", "Reply body")
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("addMessage creates an OUTBOUND EMAIL message linked to the complaint", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.message.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "msg2", direction: "OUTBOUND", body: "We will fix it", channel: "EMAIL",
    createdAt: new Date(), complaintId: "cmp1",
  });

  await createComplaintService(prisma).addMessage("cmp1", "We will fix it");

  const args = (prisma.message.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.direction).toBe("OUTBOUND");
  expect(args.data.channel).toBe("EMAIL");
  expect(args.data.complaintId).toBe("cmp1");
  expect(args.data.body).toBe("We will fix it");
});
