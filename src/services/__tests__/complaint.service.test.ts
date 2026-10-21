import { it, expect, vi } from "vitest";
import { createComplaintService } from "../complaint.service";

function makePrisma() {
  return {
    complaint: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
    },
    customer: { findUnique: vi.fn() },
    property: { findUnique: vi.fn() },
    technician: { findUnique: vi.fn(), findFirst: vi.fn() },
    message: { create: vi.fn(), findMany: vi.fn() },
  } as unknown as Parameters<typeof createComplaintService>[0];
}

const baseComplaint = {
  id: "cmp1", status: "OPEN", severity: "LOW",
  title: "Missed clean", description: null, issueType: null,
  customerId: "c1", propertyId: null, technicianId: null,
  revisitDate: null, createdAt: new Date(),
  customer: { id: "c1", name: "Jane Doe" },
  property: null, technician: null,
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
    property: null, technician: null,
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
    property: null, technician: null,
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
    property: null, technician: null,
  });

  const result = await createComplaintService(prisma).logComplaint({
    customerId: "c1",
    title: "Missed clean",
    technicianId: "t1",
  });

  expect(result.technicianId).toBe("t1");
});

it("logComplaint throws 400 when technician has not accepted their invite", async () => {
  const prisma = makePrisma();
  (prisma.customer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "t1", profileId: null,
  });

  await expect(
    createComplaintService(prisma).logComplaint({
      customerId: "c1",
      title: "Missed clean",
      technicianId: "t1",
    })
  ).rejects.toMatchObject({ statusCode: 400 });
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
    property: null, technician: null,
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
    property: null, technician: null,
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
    property: null, technician: null,
  });

  await createComplaintService(prisma).resolve("cmp1");

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.status).toBe("RESOLVED");
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

it("scheduleRevisit sets status REVISIT_BOOKED and revisitDate", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.complaint.update as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "cmp1", status: "REVISIT_BOOKED", severity: "LOW",
    title: "Missed clean", description: null, issueType: null,
    customerId: "c1", propertyId: null, technicianId: null,
    revisitDate: new Date("2026-09-10T00:00:00.000Z"), createdAt: new Date(),
    customer: { id: "c1", name: "Jane Doe" },
    property: null, technician: null,
  });

  await createComplaintService(prisma).scheduleRevisit("cmp1", "2026-09-10");

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.status).toBe("REVISIT_BOOKED");
  expect(args.data.revisitDate).toEqual(new Date("2026-09-10T00:00:00.000Z"));
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
    property: null, technician: null,
  });

  await createComplaintService(prisma).reopen("cmp1");

  const args = (prisma.complaint.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.data.status).toBe("OPEN");
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

it("assignTechnician throws 400 when technician has not accepted their invite", async () => {
  const prisma = makePrisma();
  (prisma.complaint.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cmp1" });
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t1", profileId: null });

  await expect(
    createComplaintService(prisma).assignTechnician("cmp1", "t1")
  ).rejects.toMatchObject({ statusCode: 400 });
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
    property: null, technician: { id: "t1", name: "James" },
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
