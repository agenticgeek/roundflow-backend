import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const createTechnician = vi.fn();
const updateTechnician = vi.fn();
const getPerformance = vi.fn();
vi.mock("../../services/technician.service", () => ({
  createTechnicianService: vi.fn(() => ({ createTechnician, updateTechnician, getPerformance })),
}));
const listTechnicianPhotos = vi.fn();
vi.mock("../../services/photo-gallery.service", () => ({
  createPhotoGalleryService: vi.fn(() => ({ listTechnicianPhotos })),
}));
const incidentCreate = vi.fn();
const incidentList = vi.fn();
vi.mock("../../services/technician-incident.service", () => ({
  createTechnicianIncidentService: vi.fn(() => ({ create: incidentCreate, list: incidentList })),
}));
const availList = vi.fn();
const availCreate = vi.fn();
const availRemove = vi.fn();
const replace = vi.fn();
vi.mock("../../services/technician-availability.service", () => ({
  createTechnicianAvailabilityService: vi.fn(() => ({
    list: availList,
    create: availCreate,
    remove: availRemove,
    replace,
  })),
}));
vi.mock("../../lib/prisma", () => ({ prisma: {} }));
vi.mock("../../lib/email", () => ({ sendInviteEmail: vi.fn() }));
vi.mock("../../lib/invites", () => ({
  assertNoActiveInvite: vi.fn(),
  buildInviteUrl: vi.fn(),
  newInviteExpiry: vi.fn(),
}));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { techniciansRouter } from "../technicians";
import { AppError } from "../../lib/app-error";

function makeApp(profile: any = { id: "prof1", tenantId: "ten1", role: "ADMIN" }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = {};
    req.profile = profile;
    next();
  });
  app.use("/technicians", techniciansRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: String(err) });
  });
  return app;
}

beforeEach(() => vi.clearAllMocks());

// ── GAP-004: singular serviceAreaId ─────────────────────────────────────────

it("POST /technicians folds a singular serviceAreaId into serviceAreaIds", async () => {
  createTechnician.mockResolvedValue({ id: "t1" });
  const res = await request(makeApp()).post("/technicians").send({ name: "Sam", serviceAreaId: "a1" });
  expect(res.status).toBe(201);
  expect(createTechnician.mock.calls[0][0].serviceAreaIds).toEqual(["a1"]);

  await request(makeApp()).post("/technicians").send({ name: "Sam", serviceAreaIds: ["a2"], serviceAreaId: "a1" });
  expect(createTechnician.mock.calls[1][0].serviceAreaIds).toEqual(["a2", "a1"]);

  await request(makeApp()).post("/technicians").send({ name: "Sam", serviceAreaId: "" });
  expect(createTechnician.mock.calls[2][0].serviceAreaIds).toBeUndefined();
});

it("PATCH /technicians/:id folds serviceAreaId; neither sent leaves areas untouched", async () => {
  updateTechnician.mockResolvedValue({ id: "t1" });
  await request(makeApp()).patch("/technicians/t1").send({ serviceAreaId: "a1" });
  expect(updateTechnician.mock.calls[0][1].serviceAreaIds).toEqual(["a1"]);
  await request(makeApp()).patch("/technicians/t1").send({ name: "Sam" });
  expect(updateTechnician.mock.calls[1][1].serviceAreaIds).toBeUndefined();
});

it("POST /technicians 400s for a non-string serviceAreaId", async () => {
  const res = await request(makeApp()).post("/technicians").send({ name: "Sam", serviceAreaId: 5 });
  expect(res.status).toBe(400);
});

// ── performance ─────────────────────────────────────────────────────────────

it("GET /technicians/:id/performance defaults to thisMonth and validates period", async () => {
  getPerformance.mockResolvedValue({ visitsCompleted: 3 });
  const res = await request(makeApp()).get("/technicians/t1/performance");
  expect(res.status).toBe(200);
  expect(getPerformance.mock.calls[0].slice(0, 2)).toEqual(["t1", "thisMonth"]);
  expect(getPerformance.mock.calls[0][2]).toBeInstanceOf(Date);

  await request(makeApp()).get("/technicians/t1/performance?period=lastMonth");
  expect(getPerformance.mock.calls[1][1]).toBe("lastMonth");

  expect((await request(makeApp()).get("/technicians/t1/performance?period=decade")).status).toBe(400);
});

// ── photos ──────────────────────────────────────────────────────────────────

it("GET /technicians/:id/photos paginates (default 24)", async () => {
  listTechnicianPhotos.mockResolvedValue({ rows: [], pagination: {} });
  expect((await request(makeApp()).get("/technicians/t1/photos?page=2")).status).toBe(200);
  expect(listTechnicianPhotos).toHaveBeenCalledWith("t1", { page: 2, pageSize: 24 });
  expect((await request(makeApp()).get("/technicians/t1/photos?page=0")).status).toBe(400);
});

// ── incidents ───────────────────────────────────────────────────────────────

it("POST /technicians/:id/incidents creates with createdById from the profile", async () => {
  incidentCreate.mockResolvedValue({ id: "i1" });
  const res = await request(makeApp())
    .post("/technicians/t1/incidents")
    .send({ type: "UPSELL", amount: 12.5, note: "Gutters", visitId: "v1" });
  expect(res.status).toBe(201);
  expect(incidentCreate).toHaveBeenCalledWith("t1", {
    type: "UPSELL",
    amount: 12.5,
    note: "Gutters",
    visitId: "v1",
    createdById: "prof1",
  });
});

it("POST /technicians/:id/incidents without amount/visit and without a profile", async () => {
  incidentCreate.mockResolvedValue({ id: "i1" });
  await request(makeApp(null)).post("/technicians/t1/incidents").send({ type: "STRIKE", note: "Late" });
  expect(incidentCreate.mock.calls[0][1]).toMatchObject({ amount: undefined, visitId: undefined, createdById: null });
  await request(makeApp()).post("/technicians/t1/incidents").send({ type: "DAMAGE", note: "x", amount: null });
  expect(incidentCreate.mock.calls[1][1].amount).toBeNull();
});

it.each([
  [{ note: "x" }],
  [{ type: "PRAISE", note: "x" }],
  [{ type: "STRIKE" }],
  [{ type: "DAMAGE", note: "x", amount: -5 }],
  [{ type: "DAMAGE", note: "x", amount: "5" }],
])("POST /technicians/:id/incidents 400s for %j", async (body) => {
  expect((await request(makeApp()).post("/technicians/t1/incidents").send(body)).status).toBe(400);
  expect(incidentCreate).not.toHaveBeenCalled();
});

it("GET /technicians/:id/incidents passes type/from/to/page", async () => {
  incidentList.mockResolvedValue({ rows: [], pagination: {} });
  const res = await request(makeApp()).get("/technicians/t1/incidents?type=STRIKE&from=2026-10-01&to=2026-10-31&page=2&pageSize=10");
  expect(res.status).toBe(200);
  expect(incidentList).toHaveBeenCalledWith("t1", {
    type: "STRIKE",
    from: new Date("2026-10-01T00:00:00Z"),
    to: new Date("2026-10-31T00:00:00Z"),
    page: 2,
    pageSize: 10,
  });
  await request(makeApp()).get("/technicians/t1/incidents");
  expect(incidentList.mock.calls[1][1]).toMatchObject({ type: undefined, from: undefined, to: undefined, page: 1, pageSize: 50 });
});

it.each([
  ["?type=PRAISE"],
  ["?type=STRIKE&type=DAMAGE"],
  ["?from=2026-13-01"],
  ["?from=2026-10-31&to=2026-10-01"],
])("GET /technicians/:id/incidents%s → 400", async (qs) => {
  expect((await request(makeApp()).get(`/technicians/t1/incidents${qs}`)).status).toBe(400);
});

// ── availability ────────────────────────────────────────────────────────────

it("GET /technicians/:id/availability lists windows", async () => {
  availList.mockResolvedValue([{ id: "a1" }]);
  const res = await request(makeApp()).get("/technicians/t1/availability");
  expect(res.body).toEqual([{ id: "a1" }]);
});

it("POST /technicians/:id/availability creates a window", async () => {
  availCreate.mockResolvedValue({ id: "a1", visitsRestamped: 0 });
  const res = await request(makeApp())
    .post("/technicians/t1/availability")
    .send({ from: "2026-11-02", to: "2026-11-06", reason: "Holiday" });
  expect(res.status).toBe(201);
  const [id, input, now] = availCreate.mock.calls[0];
  expect(id).toBe("t1");
  expect(input).toEqual({ from: new Date("2026-11-02"), to: new Date("2026-11-06"), reason: "Holiday" });
  expect(now).toBeInstanceOf(Date);
});

it.each([
  [{ to: "2026-11-06" }],
  [{ from: "2026-11-02" }],
  [{ from: "2026-11-06", to: "2026-11-02" }],
  [{ from: "2026-11-02", to: "2026-11-06", reason: 5 }],
])("POST /technicians/:id/availability 400s for %j", async (body) => {
  expect((await request(makeApp()).post("/technicians/t1/availability").send(body)).status).toBe(400);
});

it("DELETE /technicians/:id/availability/:availabilityId → 204", async () => {
  availRemove.mockResolvedValue(undefined);
  const res = await request(makeApp()).delete("/technicians/t1/availability/a1");
  expect(res.status).toBe(204);
  expect(availRemove.mock.calls[0].slice(0, 2)).toEqual(["t1", "a1"]);
});

// ── replace ─────────────────────────────────────────────────────────────────

it("POST /technicians/:id/replace reassigns; notify defaults to true", async () => {
  replace.mockResolvedValue({ visitsReassigned: 14 });
  const res = await request(makeApp())
    .post("/technicians/t1/replace")
    .send({ replacementTechnicianId: "t2", from: "2026-11-02", to: "2026-11-06" });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ visitsReassigned: 14 });
  expect(replace).toHaveBeenCalledWith("t1", {
    replacementTechnicianId: "t2",
    from: new Date("2026-11-02"),
    to: new Date("2026-11-06"),
    notify: true,
  });

  await request(makeApp()).post("/technicians/t1/replace").send({ replacementTechnicianId: "t2", from: "2026-11-02", notify: false });
  expect(replace.mock.calls[1][1]).toMatchObject({ to: undefined, notify: false });
});

it.each([
  [{ from: "2026-11-02" }],
  [{ replacementTechnicianId: "t2" }],
  [{ replacementTechnicianId: "t2", from: "2026-11-06", to: "2026-11-02" }],
  [{ replacementTechnicianId: "t2", from: "2026-11-02", notify: "yes" }],
])("POST /technicians/:id/replace 400s for %j", async (body) => {
  expect((await request(makeApp()).post("/technicians/t1/replace").send(body)).status).toBe(400);
  expect(replace).not.toHaveBeenCalled();
});
