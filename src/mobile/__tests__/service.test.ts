import { describe, it, expect, vi } from "vitest";
import { createHomeService } from "../services/home.service";
import { createJobDetailService } from "../services/job-detail.service";
import { createJobTrackerService } from "../services/job-tracker.service";
import { createMediaService } from "../services/media.service";
import { evaluateDebtGate } from "../services/debt-gate";
import { createNotificationService } from "../services/notification.service";
import { createChatService } from "../services/chat.service";

function makePrisma() {
  return {
    visit: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    issue: { create: vi.fn() },
    propertyNote: { create: vi.fn() },
    photo: { create: vi.fn() },
    technician: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn(), updateMany: vi.fn() },
    customer: { findUnique: vi.fn().mockResolvedValue({ holdNextClean: false }), update: vi.fn() },
    payment: { create: vi.fn() },
    activityLog: { create: vi.fn() },
    chatMessage: { findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ debtHoldEnabled: false, debtHoldMaxInvoices: null, debtHoldMaxAmount: null }) },
    notification: { findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    device: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  } as unknown as Parameters<typeof createHomeService>[0];
}

// ---------------------------------------------------------------------------
// startVisit
// ---------------------------------------------------------------------------

it("startVisit transitions SCHEDULED visit to IN_PROGRESS and records startedAt", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "SCHEDULED", property: { customerId: "c1" } });
  (prisma.visit.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "IN_PROGRESS" });

  await createJobTrackerService(prisma).startVisit("v1", "tech-profile-1");

  const updateArgs = (prisma.visit.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(updateArgs.data.status).toBe("IN_PROGRESS");
  expect(updateArgs.data.startedAt).toBeInstanceOf(Date);
  expect(updateArgs.where.id).toBe("v1");
});

it("startVisit throws 409 when visit is already IN_PROGRESS", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", status: "IN_PROGRESS", property: { customerId: "c1" } });

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

it("reportAccessIssue attaches photoPaths as ACCESS_ISSUE photos on the new Issue and returns its id", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", propertyId: "p1", status: "IN_PROGRESS" });
  (prisma.issue.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "i9" });

  const out = await createJobTrackerService(prisma).reportAccessIssue("v1", "DOG_LOOSE", "Dog in garden", ["t/visits/v1/access_issue-1.jpg"]);

  expect(out).toEqual({ id: "i9" });
  const createArgs = (prisma.issue.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(createArgs.data.photos).toEqual({
    create: [{ url: "t/visits/v1/access_issue-1.jpg", type: "ACCESS_ISSUE", visitId: "v1", propertyId: "p1" }],
  });
});

it("reportAccessIssue without photos creates no Photo rows", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "v1", propertyId: "p1" });
  (prisma.issue.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "i1" });
  await createJobTrackerService(prisma).reportAccessIssue("v1", "OTHER", "x");
  expect((prisma.issue.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data.photos).toBeUndefined();
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
      startedAt: new Date("2026-10-30T09:00:00Z"), arrivedAt: new Date("2026-10-30T09:10:00Z"),
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
  expect(result[0]).toMatchObject({
    startedAt: new Date("2026-10-30T09:00:00Z"), arrivedAt: new Date("2026-10-30T09:10:00Z"), completedAt: null,
  });
});

it("getTodayVisits passes through the property's geocoded latitude/longitude, and null when ungeocoded", async () => {
  const prisma = makePrisma();
  (prisma.technician.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t1", profileId: "prof-1" });
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "v1", status: "SCHEDULED", price: { toNumber: () => 28 },
      date: new Date(), skipReason: null, completedAt: null,
      paymentMethod: "DIRECT_DEBIT", notes: null,
      property: { id: "p1", addressLine: "23 Bailiffgate", postcode: "NE66 1JK", latitude: null, longitude: null,
        customer: { id: "c1", name: "Sarah Brown", badDebt: false }, notes: [] },
      round: null,
      service: null,
      _count: { issues: 0 },
    },
    {
      id: "v2", status: "SCHEDULED", price: { toNumber: () => 30 },
      date: new Date(), skipReason: null, completedAt: null,
      paymentMethod: "CASH", notes: null,
      property: { id: "p2", addressLine: "45 Bondgate Within", postcode: "NE66 1DJ", latitude: 55.4, longitude: -1.7,
        customer: { id: "c2", name: "Helen Foster", badDebt: false }, notes: [] },
      round: null,
      service: null,
      _count: { issues: 0 },
    },
  ]);

  const result = await createHomeService(prisma).getTodayVisits("prof-1");

  expect(result[0]).toMatchObject({ latitude: null, longitude: null });
  expect(result[1]).toMatchObject({ latitude: 55.4, longitude: -1.7 });
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

it("getVisitDetail passes through the property's geocoded latitude/longitude", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "v1", status: "IN_PROGRESS", price: { toNumber: () => 52 },
    paymentMethod: "CASH", notes: null, skipReason: null, completedAt: null,
    roundId: "r1", propertyId: "p1", technician: null,
    property: { id: "p1", addressLine: "12 Market Street", postcode: "NE66 1AA", latitude: 55.4, longitude: -1.7,
      customer: { id: "c1", name: "Tom Atkinson", badDebt: false, invoices: [] },
      notes: [] },
    round: { id: "r1", name: "Alnwick Monday" },
    service: { id: "s1", name: "Full exterior + conservatory" },
    _count: { issues: 0 },
  });
  (prisma.visit.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  const visit = await createJobDetailService(prisma).getVisitDetail("v1");

  expect(visit.property.latitude).toBe(55.4);
  expect(visit.property.longitude).toBe(-1.7);
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

// ---------------------------------------------------------------------------
// evaluateDebtGate (shared debt-hold evaluation — canStart/blockReason + 403)
// ---------------------------------------------------------------------------

it("evaluateDebtGate allows when debt hold is disabled", async () => {
  const prisma = makePrisma();
  expect(await evaluateDebtGate(prisma, "c1")).toEqual({ canStart: true, blockReason: null });
});

it("evaluateDebtGate blocks when outstanding debt exceeds the limit", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ debtHoldEnabled: true, debtHoldMaxInvoices: 2, debtHoldMaxAmount: { toNumber: () => 50 } });
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ amount: { toNumber: () => 80 } }]);
  const gate = await evaluateDebtGate(prisma, "c1");
  expect(gate.canStart).toBe(false);
  expect(gate.blockReason).toMatch(/over the allowed limit/);
});

it("evaluateDebtGate allows when debt is under the limits", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ debtHoldEnabled: true, debtHoldMaxInvoices: 3, debtHoldMaxAmount: { toNumber: () => 100 } });
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ amount: { toNumber: () => 20 } }]);
  expect((await evaluateDebtGate(prisma, "c1")).canStart).toBe(true);
});

// ---------------------------------------------------------------------------
// adjustPrice (partial-service price keeps original + reason; restorable)
// ---------------------------------------------------------------------------

it("adjustPrice records the original price + reason on the first adjustment", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "IN_PROGRESS", price: { toNumber: () => 52 }, originalPrice: null });
  (prisma.visit.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  await createJobTrackerService(prisma).adjustPrice("v1", 26, "Front only");
  const data = (prisma.visit.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
  expect(data).toEqual({ price: 26, originalPrice: 52, priceAdjustmentReason: "Front only" });
});

it("adjustPrice restoring to the original price clears the adjustment", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "IN_PROGRESS", price: { toNumber: () => 26 }, originalPrice: { toNumber: () => 52 } });
  (prisma.visit.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  await createJobTrackerService(prisma).adjustPrice("v1", 52);
  const data = (prisma.visit.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
  expect(data).toEqual({ price: 52, originalPrice: null, priceAdjustmentReason: null });
});

// ---------------------------------------------------------------------------
// NotificationService (list pagination + unreadCount; device register)
// ---------------------------------------------------------------------------

it("notifications list returns a page + unreadCount + nextCursor when more exist", async () => {
  const prisma = makePrisma();
  const rows = Array.from({ length: 31 }, (_, i) => ({ id: `n${i}`, createdAt: new Date() }));
  (prisma.notification.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
  (prisma.notification.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);
  const res = await createNotificationService(prisma).list("p1");
  expect(res.notifications).toHaveLength(30);
  expect(res.unreadCount).toBe(5);
  expect(res.nextCursor).toBe("n29");
});

it("notifications list returns nextCursor null on the last page", async () => {
  const prisma = makePrisma();
  (prisma.notification.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "n1", createdAt: new Date() }]);
  (prisma.notification.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  const res = await createNotificationService(prisma).list("p1");
  expect(res.notifications).toHaveLength(1);
  expect(res.nextCursor).toBeNull();
});

it("registerDevice upserts by pushToken", async () => {
  const prisma = makePrisma();
  (prisma.device.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});
  await createNotificationService(prisma).registerDevice("p1", "ExponentPushToken[abc]", "ios");
  const args = (prisma.device.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(args.where).toEqual({ pushToken: "ExponentPushToken[abc]" });
  expect(args.create).toMatchObject({ profileId: "p1", platform: "ios" });
});

// ---------------------------------------------------------------------------
// Phase 1 audit remediation (A4, A8, B4, D-4, D-9)
// ---------------------------------------------------------------------------

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

function mobileVisit(overrides: Record<string, unknown> = {}) {
  return {
    id: "v1", status: "COMPLETED", price: { toNumber: () => 20 }, date: new Date(), completedAt: new Date(),
    paymentMethod: null, notes: null, roundId: null, servicePlan: null,
    property: { id: "p1", addressLine: "1 St", postcode: "NE1", latitude: null, longitude: null,
      customer: { id: "c1", name: "A", badDebt: false, paymentMethod: null }, notes: [] },
    round: null, service: null, _count: { issues: 0 },
    ...overrides,
  };
}

it("addVisitPhoto stamps the visit propertyId on the Photo (B4)", async () => {
  const prisma = makePrisma();
  fn(prisma.visit.findUnique).mockResolvedValue({ id: "v1", propertyId: "p1" });
  await createMediaService(prisma).addVisitPhoto("v1", "t/visits/v1/a.jpg", "AFTER");
  expect(fn(prisma.photo.create).mock.calls[0][0].data).toEqual({ visitId: "v1", propertyId: "p1", url: "t/visits/v1/a.jpg", type: "AFTER" });
});

it("skipVisit throws 409 for a CANCELLED visit", async () => {
  const prisma = makePrisma();
  fn(prisma.visit.findUnique).mockResolvedValue({ id: "v1", status: "CANCELLED" });
  await expect(createJobTrackerService(prisma).skipVisit("v1", "Gate")).rejects.toMatchObject({ statusCode: 409 });
});

it("mobile readers exclude CANCELLED visits (A4)", async () => {
  const prisma = makePrisma();
  fn(prisma.technician.findUnique).mockResolvedValue({ id: "t1" });
  fn(prisma.visit.findMany).mockResolvedValue([]);
  const home = createHomeService(prisma);
  await home.getTodayVisits("prof-1");
  await home.getRoundsSummary("prof-1");
  await home.getCompletions("prof-1");
  const wheres = fn(prisma.visit.findMany).mock.calls.slice(0, 3).map((c) => c[0].where.status);
  expect(wheres).toEqual([{ not: "CANCELLED" }, { not: "CANCELLED" }, { not: "CANCELLED" }]);
});

it("revenueByMethod and row paymentMethod use visit, then plan, then customer method (D-9)", async () => {
  const prisma = makePrisma();
  fn(prisma.technician.findUnique).mockResolvedValue({ id: "t1" });
  fn(prisma.visit.findMany)
    .mockResolvedValueOnce([
      mobileVisit({ id: "a", paymentMethod: "CASH" }),
      mobileVisit({ id: "b", servicePlan: { paymentMethod: "GOCARDLESS" } }),
      mobileVisit({ id: "c", property: { ...mobileVisit().property, customer: { id: "c1", name: "A", badDebt: false, paymentMethod: "CASH" } } }),
      mobileVisit({ id: "d" }),
    ])
    .mockResolvedValueOnce([]);

  const out = await createHomeService(prisma).getCompletions("prof-1");

  expect(out.revenueByMethod).toEqual({ cash: 40, directDebit: 20, other: 20 });
  expect(out.visits.map((v) => v.paymentMethod)).toEqual(["CASH", "GOCARDLESS", "CASH", null]);
});

it("getVisitDetail returns the effective payment method and skips CANCELLED in roundPosition", async () => {
  const prisma = makePrisma();
  fn(prisma.visit.findUnique).mockResolvedValue({
    id: "v1", status: "SCHEDULED", date: new Date(), roundId: "r1", propertyId: "p1", paymentMethod: null,
    servicePlan: { paymentMethod: "BACS" },
    property: { id: "p1", customer: { id: "c1", name: "A", badDebt: false, paymentMethod: "CASH", invoices: [] }, notes: [] },
  });
  fn(prisma.visit.findFirst).mockResolvedValue(null);
  fn(prisma.visit.findMany).mockResolvedValue([{ id: "v1" }]);

  const out = await createJobDetailService(prisma).getVisitDetail("v1");

  expect(out.paymentMethod).toBe("BACS");
  expect(fn(prisma.visit.findMany).mock.calls[0][0].where.status).toEqual({ not: "CANCELLED" });
});

it("getVisitDetail falls back to the customer method, then null", async () => {
  const prisma = makePrisma();
  const base = { id: "v1", status: "SCHEDULED", date: new Date(), roundId: null, propertyId: "p1", paymentMethod: null, servicePlan: null };
  fn(prisma.visit.findFirst).mockResolvedValue(null);
  fn(prisma.visit.findUnique).mockResolvedValueOnce({
    ...base, property: { id: "p1", customer: { id: "c1", name: "A", badDebt: false, paymentMethod: "CASH", invoices: [] }, notes: [] },
  }).mockResolvedValueOnce({
    ...base, property: { id: "p1", customer: { id: "c1", name: "A", badDebt: false, paymentMethod: null, invoices: [] }, notes: [] },
  });
  const svc = createJobDetailService(prisma);
  expect((await svc.getVisitDetail("v1")).paymentMethod).toBe("CASH");
  expect((await svc.getVisitDetail("v1")).paymentMethod).toBeNull();
});

describe("collectDebtPayment", () => {
  const debtVisit = { property: { customer: { id: "c1", name: "Tom" } } };
  const invoices = [{ id: "i1", amount: { toNumber: () => 30 } }, { id: "i2", amount: { toNumber: () => 20 } }];

  it("404 when the visit is missing", async () => {
    const prisma = makePrisma();
    fn(prisma.visit.findUnique).mockResolvedValue(null);
    await expect(createJobDetailService(prisma).collectDebtPayment("v1", { method: "CASH" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("clears the bad-debt flag when there is nothing outstanding", async () => {
    const prisma = makePrisma();
    fn(prisma.visit.findUnique).mockResolvedValue(debtVisit);
    fn(prisma.invoice.findMany).mockResolvedValue([]);
    const out = await createJobDetailService(prisma).collectDebtPayment("v1", { method: "CHEQUE", chequeNumber: "1" });
    expect(out).toEqual({ cleared: true, amountPaid: 0, amountPending: 0, method: "CHEQUE" });
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { badDebt: false } });
  });

  it("CASH pays every outstanding invoice", async () => {
    const prisma = makePrisma();
    fn(prisma.visit.findUnique).mockResolvedValue(debtVisit);
    fn(prisma.invoice.findMany).mockResolvedValue(invoices);
    const out = await createJobDetailService(prisma).collectDebtPayment("v1", { method: "CASH" });
    expect(out).toEqual({ cleared: true, amountPaid: 50, amountPending: 0, method: "CASH" });
    expect(fn(prisma.payment.create).mock.calls[0][0].data).toMatchObject({ amount: 50, method: "CASH", status: "PAID" });
    expect(prisma.invoice.updateMany).toHaveBeenCalled();
  });

  it("CHEQUE records a PENDING cheque payment, logs the number and leaves invoices open", async () => {
    const prisma = makePrisma();
    fn(prisma.visit.findUnique).mockResolvedValue(debtVisit);
    fn(prisma.invoice.findMany).mockResolvedValue(invoices);
    const svc = createJobDetailService(prisma);

    const out = await svc.collectDebtPayment("v1", { method: "CHEQUE", chequeNumber: "000777", actorProfileId: "prof-1" });

    expect(out).toEqual({ cleared: false, amountPaid: 0, amountPending: 50, method: "CHEQUE" });
    expect(fn(prisma.payment.create).mock.calls[0][0].data).toMatchObject({ amount: 50, method: "CHEQUE", status: "PENDING", reference: "000777" });
    expect(fn(prisma.activityLog.create).mock.calls[0][0].data).toMatchObject({
      type: "CHEQUE_RECEIVED", actorId: "prof-1", message: expect.stringContaining("Cheque 000777"),
    });
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();

    await svc.collectDebtPayment("v1", { method: "CHEQUE", chequeNumber: "1" });
    expect(fn(prisma.activityLog.create).mock.calls[1][0].data.actorId).toBeNull();
  });
});

describe("chat service (D-4)", () => {
  it("flags isMine by Profile id or a legacy Supabase user id", async () => {
    const prisma = makePrisma();
    fn(prisma.chatMessage.findMany).mockResolvedValue([
      { id: "m1", senderProfileId: "prof-1" },
      { id: "m2", senderProfileId: "sb-1" },
      { id: "m3", senderProfileId: "prof-office" },
    ]);
    const since = new Date("2026-10-30T09:00:00Z");
    const rows = await createChatService(prisma).getChatMessages("r1", { profileId: "prof-1", supabaseUserId: "sb-1" }, since);
    expect(rows.map((r) => r.isMine)).toEqual([true, true, false]);
    expect(fn(prisma.chatMessage.findMany).mock.calls[0][0].where).toEqual({ roundId: "r1", createdAt: { gt: since } });

    await createChatService(prisma).getChatMessages("r1", { profileId: "prof-1", supabaseUserId: "sb-1" });
    expect(fn(prisma.chatMessage.findMany).mock.calls[1][0].where).toEqual({ roundId: "r1" });
  });

  it("sends store the given sender and return isMine", async () => {
    const prisma = makePrisma();
    fn(prisma.chatMessage.create).mockImplementation(async (a: any) => ({ id: "m", ...a.data }));
    const svc = createChatService(prisma);
    expect(await svc.sendChatMessage("r1", "prof-1", "hi")).toMatchObject({ senderProfileId: "prof-1", type: "TEXT", isMine: true });
    expect(await svc.sendWorkPhotosMessage("r1", "prof-1", "v1")).toMatchObject({ type: "WORK_PHOTOS", visitId: "v1", isMine: true });
    expect(await svc.sendPhotosMessage("r1", "prof-1", ["a"])).toMatchObject({ type: "PHOTOS", body: null, isMine: true });
    expect(await svc.sendPhotosMessage("r1", "prof-1", ["a"], "look")).toMatchObject({ body: "look" });
  });
});
