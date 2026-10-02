import { it, expect, vi } from "vitest";
import { createHomeService } from "../services/home.service";
import { createJobDetailService } from "../services/job-detail.service";
import { createJobTrackerService } from "../services/job-tracker.service";
import { createMediaService } from "../services/media.service";

function makePrisma() {
  return {
    visit: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    issue: { create: vi.fn() },
    propertyNote: { create: vi.fn() },
    photo: { create: vi.fn() },
    technician: { findUnique: vi.fn() },
  } as unknown as Parameters<typeof createHomeService>[0];
}

// ---------------------------------------------------------------------------
// startVisit
// ---------------------------------------------------------------------------

it("startVisit transitions SCHEDULED visit to IN_PROGRESS and records startedAt", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "SCHEDULED" });
  (prisma.visit.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "IN_PROGRESS" });

  await createJobTrackerService(prisma).startVisit("v1", "tech-profile-1");

  const updateArgs = (prisma.visit.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(updateArgs.data.status).toBe("IN_PROGRESS");
  expect(updateArgs.data.startedAt).toBeInstanceOf(Date);
  expect(updateArgs.where.id).toBe("v1");
});

it("startVisit throws 409 when visit is already IN_PROGRESS", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "IN_PROGRESS" });

  await expect(createJobTrackerService(prisma).startVisit("v1", "tech-profile-1")).rejects.toMatchObject({ statusCode: 409 });
});

it("startVisit throws 404 when visit does not exist", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(createJobTrackerService(prisma).startVisit("bad-id", "tech-profile-1")).rejects.toMatchObject({ statusCode: 404 });
});

// ---------------------------------------------------------------------------
// markArrived
// ---------------------------------------------------------------------------

it("markArrived sets arrivedAt on an IN_PROGRESS visit", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "IN_PROGRESS" });
  (prisma.visit.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1" });

  await createJobTrackerService(prisma).markArrived("v1");

  const updateArgs = (prisma.visit.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(updateArgs.data.arrivedAt).toBeInstanceOf(Date);
  expect(updateArgs.where.id).toBe("v1");
});

it("markArrived throws 409 when visit is not IN_PROGRESS", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "SCHEDULED" });

  await expect(createJobTrackerService(prisma).markArrived("v1")).rejects.toMatchObject({ statusCode: 409 });
});

// ---------------------------------------------------------------------------
// skipVisit
// ---------------------------------------------------------------------------

it("skipVisit sets status SKIPPED and stores reason", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "IN_PROGRESS" });
  (prisma.visit.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1" });

  await createJobTrackerService(prisma).skipVisit("v1", "Gate locked");

  const updateArgs = (prisma.visit.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(updateArgs.data.status).toBe("SKIPPED");
  expect(updateArgs.data.skipReason).toBe("Gate locked");
});

it("skipVisit appends description when provided", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "IN_PROGRESS" });
  (prisma.visit.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1" });

  await createJobTrackerService(prisma).skipVisit("v1", "Other", "Dog blocking the path");

  const updateArgs = (prisma.visit.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(updateArgs.data.skipReason).toBe("Other: Dog blocking the path");
});

it("skipVisit throws 409 when visit is already COMPLETED", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "COMPLETED" });

  await expect(createJobTrackerService(prisma).skipVisit("v1", "Gate locked")).rejects.toMatchObject({ statusCode: 409 });
});

it("skipVisit is idempotent when already SKIPPED", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "SKIPPED" });

  await createJobTrackerService(prisma).skipVisit("v1", "Gate locked");

  expect((prisma.visit.update as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// reportAccessIssue
// ---------------------------------------------------------------------------

it("reportAccessIssue creates an Issue with the correct type and note", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "IN_PROGRESS" });
  (prisma.issue.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "i1" });

  await createJobTrackerService(prisma).reportAccessIssue("v1", "GATE_LOCKED", "Side gate padlocked");

  const createArgs = (prisma.issue.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(createArgs.data.visitId).toBe("v1");
  expect(createArgs.data.type).toBe("GATE_LOCKED");
  expect(createArgs.data.note).toBe("Side gate padlocked");
});

it("reportAccessIssue throws 404 when visit does not exist", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(createJobTrackerService(prisma).reportAccessIssue("bad", "OTHER", "desc")).rejects.toMatchObject({ statusCode: 404 });
});

// ---------------------------------------------------------------------------
// addVisitNote
// ---------------------------------------------------------------------------

it("addVisitNote creates an INTERNAL PropertyNote on the visit's property", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", propertyId: "p1" });
  (prisma.propertyNote.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "n1" });

  await createMediaService(prisma).addVisitNote("v1", "Conservatory needs extra care");

  const createArgs = (prisma.propertyNote.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(createArgs.data.propertyId).toBe("p1");
  expect(createArgs.data.body).toBe("Conservatory needs extra care");
  expect(createArgs.data.type).toBe("INTERNAL");
});

it("addVisitNote throws 404 when visit does not exist", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(createMediaService(prisma).addVisitNote("bad", "some note")).rejects.toMatchObject({ statusCode: 404 });
});

// ---------------------------------------------------------------------------
// addVisitPhoto
// ---------------------------------------------------------------------------

it("addVisitPhoto creates a Photo record with the correct type and url", async () => {
  const prisma = makePrisma();
  (prisma.photo.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "ph1" });
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1" });

  await createMediaService(prisma).addVisitPhoto("v1", "https://cdn.example.com/before.jpg", "BEFORE");

  const createArgs = (prisma.photo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(createArgs.data.visitId).toBe("v1");
  expect(createArgs.data.url).toBe("https://cdn.example.com/before.jpg");
  expect(createArgs.data.type).toBe("BEFORE");
});

it("addVisitPhoto throws 404 when visit does not exist", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(createMediaService(prisma).addVisitPhoto("bad", "https://cdn.example.com/x.jpg", "AFTER")).rejects.toMatchObject({ statusCode: 404 });
});

// ---------------------------------------------------------------------------
// getPhotoUploadUrl
// ---------------------------------------------------------------------------

it("getPhotoUploadUrl throws 404 when visit does not exist", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(createMediaService(prisma).getPhotoUploadUrl("bad", "BEFORE", "image/jpeg", "tenant-1")).rejects.toMatchObject({ statusCode: 404 });
});

// ---------------------------------------------------------------------------
// getTodayVisits
// ---------------------------------------------------------------------------

it("getTodayVisits returns only visits assigned to the technician for today", async () => {
  const prisma = makePrisma();
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t1", profileId: "prof-1" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "v1", status: "SCHEDULED", price: { toNumber: () => 28 },
      date: new Date(), skipReason: null, completedAt: null,
      paymentMethod: "DIRECT_DEBIT", notes: null,
      property: { id: "p1", addressLine: "23 Bailiffgate", postcode: "NE66 1JK",
        customer: { id: "c1", name: "Sarah Brown", badDebt: false }, notes: [] },
      round: { id: "r1", name: "Alnwick Monday" },
      service: { id: "s1", name: "Full exterior window clean" },
      _count: { issues: 0 },
    },
  ]);

  const result = await createHomeService(prisma).getTodayVisits("prof-1");

  expect(result).toHaveLength(1);
  expect(result[0].visitId).toBe("v1");
  expect(result[0].customerName).toBe("Sarah Brown");
  expect(result[0].roundName).toBe("Alnwick Monday");
});

it("getTodayVisits returns [] when no technician record exists for the profile", async () => {
  const prisma = makePrisma();
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  expect(await createHomeService(prisma).getTodayVisits("unknown-profile")).toEqual([]);
});

// ---------------------------------------------------------------------------
// getCompletions
// ---------------------------------------------------------------------------

function makeCompletedVisit(id: string, price: number, status = "COMPLETED") {
  return {
    id, status, price: { toNumber: () => price },
    date: new Date(), skipReason: null,
    completedAt: status === "COMPLETED" ? new Date() : null,
    paymentMethod: "DIRECT_DEBIT", notes: null,
    property: { id: "p1", addressLine: "23 Bailiffgate", postcode: "NE66 1KJ",
      customer: { id: "c1", name: "Sarah Brown", badDebt: false }, notes: [] },
    round: { id: "r1", name: "Alnwick Monday" },
    service: { id: "s1", name: "Full exterior window clean" },
    _count: { issues: 0 },
  };
}

it("getCompletions returns revenue total and counts for today", async () => {
  const prisma = makePrisma();
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t1" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce([makeCompletedVisit("v1", 28, "COMPLETED"), makeCompletedVisit("v2", 30, "SKIPPED")])
    .mockResolvedValueOnce([]);

  const result = await createHomeService(prisma).getCompletions("prof-1");

  expect(result.completedCount).toBe(1);
  expect(result.skippedCount).toBe(1);
  expect(result.totalCount).toBe(2);
  expect(result.revenueToday).toBe(28);
  expect(result.revenueChangePercent).toBeNull();
});

it("getCompletions calculates revenue change percent when last-week data exists", async () => {
  const prisma = makePrisma();
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t1" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce([makeCompletedVisit("v1", 58, "COMPLETED")])
    .mockResolvedValueOnce([{ price: { toNumber: () => 50 } }]);

  const result = await createHomeService(prisma).getCompletions("prof-1");

  expect(result.revenueToday).toBe(58);
  expect(result.revenueChangePercent).toBeCloseTo(16);
});

it("getCompletions returns empty summary when technician not found", async () => {
  const prisma = makePrisma();
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  const result = await createHomeService(prisma).getCompletions("unknown");

  expect(result.completedCount).toBe(0);
  expect(result.revenueToday).toBe(0);
  expect(result.visits).toEqual([]);
});

// ---------------------------------------------------------------------------
// getVisitDetail
// ---------------------------------------------------------------------------

it("getVisitDetail returns the visit with property notes", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "v1", status: "IN_PROGRESS", price: { toNumber: () => 52 },
    paymentMethod: "CASH", notes: null, skipReason: null, completedAt: null,
    roundId: "r1", propertyId: "p1", technician: null,
    property: { id: "p1", addressLine: "12 Market Street", postcode: "NE66 1AA",
      customer: { id: "c1", name: "Tom Atkinson", badDebt: false, invoices: [] },
      notes: [
        { id: "n1", type: "RISK_WARNING", body: "Uneven cobblestone at rear." },
        { id: "n2", type: "INTERNAL", body: "Ring bell on arrival." },
      ] },
    round: { id: "r1", name: "Alnwick Monday" },
    service: { id: "s1", name: "Full exterior + conservatory" },
    _count: { issues: 0 },
  });
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const visit = await createJobDetailService(prisma).getVisitDetail("v1");

  expect(visit.id).toBe("v1");
  expect(visit.property.notes).toHaveLength(2);
});

it("getVisitDetail throws 404 when visit does not exist", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  await expect(createJobDetailService(prisma).getVisitDetail("bad")).rejects.toMatchObject({ statusCode: 404 });
});

it("getVisitDetail includes technician name and role", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "v1", status: "COMPLETED", price: { toNumber: () => 28 },
    paymentMethod: "DIRECT_DEBIT", notes: null, skipReason: null,
    completedAt: new Date(), roundId: "r1", propertyId: "p1",
    technician: { name: "James Carter", role: "Field Technician" },
    property: { id: "p1", addressLine: "23 Bailiffgate", postcode: "NE66 1KJ",
      customer: { id: "c1", name: "Sarah Brown", badDebt: false, invoices: [] }, notes: [] },
    round: { id: "r1", name: "Alnwick Monday" },
    service: { id: "s1", name: "Full exterior" },
    _count: { issues: 0 },
  });
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const result = await createJobDetailService(prisma).getVisitDetail("v1");

  expect(result.technician?.name).toBe("James Carter");
  expect(result.technician?.role).toBe("Field Technician");
});

it("getVisitDetail includes lastClean date from previous completed visit", async () => {
  const prisma = makePrisma();
  const lastCleanDate = new Date("2025-06-09");
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "v1", status: "COMPLETED", price: { toNumber: () => 28 },
    paymentMethod: "DIRECT_DEBIT", notes: null, skipReason: null,
    completedAt: new Date(), roundId: null, propertyId: "p1", technician: null,
    property: { id: "p1", addressLine: "23 Bailiffgate", postcode: "NE66 1KJ",
      customer: { id: "c1", name: "Sarah Brown", badDebt: false, invoices: [] }, notes: [] },
    round: null, service: null, _count: { issues: 0 },
  });
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ completedAt: lastCleanDate });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  expect((await createJobDetailService(prisma).getVisitDetail("v1")).lastClean).toEqual(lastCleanDate);
});

it("getVisitDetail includes roundPosition when visit is part of a round", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "v2", status: "COMPLETED", price: { toNumber: () => 30 },
    paymentMethod: "DIRECT_DEBIT", notes: null, skipReason: null,
    completedAt: new Date(), roundId: "r1", propertyId: "p2", technician: null,
    property: { id: "p2", addressLine: "45 Bondgate Within", postcode: "NE66 1DJ",
      customer: { id: "c2", name: "Helen Foster", badDebt: false, invoices: [] }, notes: [] },
    round: { id: "r1", name: "Alnwick Monday" },
    service: { id: "s1", name: "Full exterior" },
    _count: { issues: 0 },
  });
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "v1" }, { id: "v2" }, { id: "v3" }, { id: "v4" }, { id: "v5" },
  ]);

  expect((await createJobDetailService(prisma).getVisitDetail("v2")).roundPosition).toEqual({ position: 2, total: 5 });
});
