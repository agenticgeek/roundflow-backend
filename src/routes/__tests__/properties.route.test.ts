import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const createProperty = vi.fn();
const getNotes = vi.fn();
const pauseService = vi.fn();
const updateProperty = vi.fn();
vi.mock("../../services/customer.service", () => ({
  createCustomerService: vi.fn(() => ({ createProperty, getNotes, pauseService, updateProperty })),
}));
vi.mock("../../services/reports.service", () => ({
  createReportsService: vi.fn(() => ({ logActivity: vi.fn().mockResolvedValue(undefined) })),
}));
const listPropertyPhotos = vi.fn();
vi.mock("../../services/photo-gallery.service", () => ({
  createPhotoGalleryService: vi.fn(() => ({ listPropertyPhotos })),
}));
vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));

import { propertiesRouter } from "../properties";
import { AppError } from "../../lib/app-error";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = {};
    req.profile = { id: "prof1", role: "ADMIN" };
    next();
  });
  app.use("/properties", propertiesRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: String(err) });
  });
  return app;
}

beforeEach(() => vi.clearAllMocks());

it("GET /properties/:id/photos filters by type and paginates (default 24)", async () => {
  listPropertyPhotos.mockResolvedValue({ rows: [], pagination: {} });
  expect((await request(makeApp()).get("/properties/p1/photos?type=BEFORE&page=2&pageSize=12")).status).toBe(200);
  expect(listPropertyPhotos).toHaveBeenCalledWith("p1", { page: 2, pageSize: 12, type: "BEFORE" });
  await request(makeApp()).get("/properties/p1/photos");
  expect(listPropertyPhotos).toHaveBeenLastCalledWith("p1", { page: 1, pageSize: 24, type: undefined });
});

it.each([["?type=SELFIE"], ["?type=BEFORE&type=AFTER"]])("GET /properties/:id/photos%s → 400", async (qs) => {
  expect((await request(makeApp()).get(`/properties/p1/photos${qs}`)).status).toBe(400);
  expect(listPropertyPhotos).not.toHaveBeenCalled();
});

it("GET /properties/:id/notes returns pinned + regular notes from the service", async () => {
  getNotes.mockResolvedValue([{ pinned: true, source: "ACCESS", body: "Gate" }]);
  const res = await request(makeApp()).get("/properties/p1/notes");
  expect(res.body).toEqual([{ pinned: true, source: "ACCESS", body: "Gate" }]);
});

it("POST /properties passes lastCleanedDate through", async () => {
  createProperty.mockResolvedValue({ propertyId: "p1" });
  const res = await request(makeApp()).post("/properties").send({
    customerName: "Bob",
    addressLine: "1 St",
    postcode: "NE66 1TD",
    serviceAreaId: "sa1",
    price: 20,
    lastCleanedDate: "2026-10-01",
  });
  expect(res.status).toBe(201);
  expect(createProperty.mock.calls[0][0].lastCleanedDate).toEqual(new Date("2026-10-01"));
});

it("POST /properties/:id/pause returns the service result including cancelledVisits", async () => {
  pauseService.mockResolvedValue({ id: "sp1", cancelledVisits: 2, pauseScheduled: false });
  const res = await request(makeApp())
    .post("/properties/p1/pause")
    .send({ reason: "Holiday", pauseStartDate: "2026-10-30" });
  expect(res.body).toEqual({ id: "sp1", cancelledVisits: 2, pauseScheduled: false });
});

it("PATCH /properties/:id forwards cleaningFrequency + createRoundIfMissing and returns movedToRound", async () => {
  updateProperty.mockResolvedValue({ id: "p1", movedToRound: { id: "r2", name: "Alnwick Fri 6wk", created: true } });
  const res = await request(makeApp()).patch("/properties/p1").send({ cleaningFrequency: "SIX_WEEKLY", createRoundIfMissing: true });
  expect(res.status).toBe(200);
  expect(res.body.movedToRound).toEqual({ id: "r2", name: "Alnwick Fri 6wk", created: true });
  expect(updateProperty).toHaveBeenCalledWith("p1", expect.objectContaining({ cleaningFrequency: "SIX_WEEKLY", createRoundIfMissing: true }));
  expect((await request(makeApp()).patch("/properties/p1").send({ createRoundIfMissing: "yes" })).status).toBe(400);
});
