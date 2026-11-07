import { it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/signed-read-url", () => ({ createSignedPhotoUrls: vi.fn() }));

import { createPhotoGalleryService, formatJobRef, parseJobNumber } from "../photo-gallery.service";
import { createSignedPhotoUrls } from "../../lib/signed-read-url";

function makeTp() {
  return {
    property: { findUnique: vi.fn() },
    technician: { findUnique: vi.fn() },
    visit: { count: vi.fn(), findMany: vi.fn() },
    photo: { count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  } as any;
}

const PHOTOS = [
  {
    id: "ph1",
    type: "BEFORE",
    url: "t1/a.jpg",
    createdAt: new Date("2026-10-01T09:00:00Z"),
    visitId: "v1",
    reviewStatus: "PENDING",
    visit: {
      id: "v1",
      date: new Date("2026-10-01"),
      jobNumber: 123,
      technician: { id: "t1", name: "Sam" },
      property: { addressLine: "12 Market Street", customer: { name: "John Smith" } },
    },
  },
  {
    id: "ph2",
    type: "PROPERTY",
    url: "t1/b.jpg",
    createdAt: new Date("2026-09-01"),
    visitId: null,
    reviewStatus: "APPROVED",
    visit: null,
  },
];

beforeEach(() => {
  vi.mocked(createSignedPhotoUrls).mockResolvedValue(new Map([["t1/a.jpg", { url: "https://signed/a", thumbnailUrl: "https://thumb/a" }]]));
});

it("listPropertyPhotos 404s for an unknown property", async () => {
  const tp = makeTp();
  tp.property.findUnique.mockResolvedValue(null);
  await expect(createPhotoGalleryService(tp).listPropertyPhotos("x", { page: 1, pageSize: 24 })).rejects.toMatchObject({
    statusCode: 404,
  });
});

it("listPropertyPhotos filters by property (direct or via visit) and type, paginates and signs urls", async () => {
  const tp = makeTp();
  tp.property.findUnique.mockResolvedValue({ id: "p1" });
  tp.photo.count.mockResolvedValue(30);
  tp.photo.findMany.mockResolvedValue(PHOTOS);

  const res = await createPhotoGalleryService(tp).listPropertyPhotos("p1", { page: 2, pageSize: 24, type: "BEFORE" as never });

  const where = { OR: [{ propertyId: "p1" }, { visit: { propertyId: "p1" } }], type: "BEFORE" };
  expect(tp.photo.count).toHaveBeenCalledWith({ where });
  expect(tp.photo.findMany.mock.calls[0][0]).toMatchObject({ where, skip: 24, take: 24 });
  expect(createSignedPhotoUrls).toHaveBeenCalledWith(["t1/a.jpg", "t1/b.jpg"]);
  expect(res.pagination).toEqual({ page: 2, pageSize: 24, total: 30, totalPages: 2 });
  expect(res.rows).toEqual([
    {
      id: "ph1",
      type: "BEFORE",
      url: "https://signed/a",
      thumbnailUrl: "https://thumb/a",
      takenAt: new Date("2026-10-01T09:00:00Z"),
      visitId: "v1",
      visitDate: new Date("2026-10-01"),
      technician: { id: "t1", name: "Sam" },
      reviewStatus: "PENDING",
      propertyAddress: "12 Market Street",
      customerName: "John Smith",
      jobRef: "JOB-000123",
    },
    {
      id: "ph2",
      type: "PROPERTY",
      url: null,
      thumbnailUrl: null,
      takenAt: new Date("2026-09-01"),
      visitId: null,
      visitDate: null,
      technician: null,
      reviewStatus: "APPROVED",
      propertyAddress: null,
      customerName: null,
      jobRef: null,
    },
  ]);
});

it("listPropertyPhotos without a type has no type filter", async () => {
  const tp = makeTp();
  tp.property.findUnique.mockResolvedValue({ id: "p1" });
  tp.photo.count.mockResolvedValue(0);
  tp.photo.findMany.mockResolvedValue([]);
  await createPhotoGalleryService(tp).listPropertyPhotos("p1", { page: 1, pageSize: 24 });
  expect(tp.photo.count.mock.calls[0][0].where.type).toBeUndefined();
});

it("formats and parses job refs", () => {
  expect(formatJobRef(123)).toBe("JOB-000123");
  expect(parseJobNumber("JOB-000123")).toBe(123);
  expect(parseJobNumber("job45")).toBe(45);
  expect(parseJobNumber("7")).toBe(7);
  expect(parseJobNumber("smith")).toBeNull();
  expect(parseJobNumber("cmabc123")).toBeNull();
});

it("listTechnicianPhotos 404s for an unknown technician", async () => {
  const tp = makeTp();
  tp.technician.findUnique.mockResolvedValueOnce(null);
  await expect(createPhotoGalleryService(tp).listTechnicianPhotos("x", { page: 1, pageSize: 24 })).rejects.toMatchObject({
    statusCode: 404,
  });
});

it("listTechnicianPhotos pages by visit and returns every photo of those visits, newest visit first", async () => {
  const tp = makeTp();
  tp.technician.findUnique.mockResolvedValue({ id: "t1" });
  tp.visit.count.mockResolvedValue(5);
  tp.visit.findMany.mockResolvedValue([{ id: "v2" }, { id: "v1" }]);
  const v2 = { ...PHOTOS[0], id: "ph9", visitId: "v2", visit: { ...PHOTOS[0].visit, id: "v2", jobNumber: 124 } };
  tp.photo.findMany.mockResolvedValue([PHOTOS[0], v2]);

  const res = await createPhotoGalleryService(tp).listTechnicianPhotos("t1", { page: 2, pageSize: 2 });

  expect(tp.visit.count).toHaveBeenCalledWith({ where: { technicianId: "t1", photos: { some: {} } } });
  expect(tp.visit.findMany.mock.calls[0][0]).toMatchObject({ skip: 2, take: 2, orderBy: [{ date: "desc" }, { id: "desc" }] });
  expect(tp.photo.findMany.mock.calls[0][0].where).toEqual({ visitId: { in: ["v2", "v1"] } });
  expect(res.pagination).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
  expect(res.rows.map((r) => r.id)).toEqual(["ph9", "ph1"]); // v2 first, as the visits were ordered
  expect(res.rows[0].jobRef).toBe("JOB-000124");
});

it("listTechnicianPhotos keeps a photo whose visit is not in the page order (treated as position 0)", async () => {
  const tp = makeTp();
  tp.technician.findUnique.mockResolvedValue({ id: "t1" });
  tp.visit.count.mockResolvedValue(1);
  tp.visit.findMany.mockResolvedValue([{ id: "v1" }]);
  const stray = { ...PHOTOS[0], id: "ph-stray", visitId: "vX", visit: { ...PHOTOS[0].visit, id: "vX" } };
  tp.photo.findMany.mockResolvedValue([stray, PHOTOS[0], { ...stray, id: "ph-stray2" }, PHOTOS[0]]);
  const res = await createPhotoGalleryService(tp).listTechnicianPhotos("t1", { page: 1, pageSize: 24 });
  expect(res.rows.map((r) => r.id)).toEqual(["ph-stray", "ph1", "ph-stray2", "ph1"]);
});

it("listTechnicianPhotos returns an empty page without querying photos when no visit matches", async () => {
  const tp = makeTp();
  tp.technician.findUnique.mockResolvedValue({ id: "t1" });
  tp.visit.count.mockResolvedValue(0);
  tp.visit.findMany.mockResolvedValue([]);
  const res = await createPhotoGalleryService(tp).listTechnicianPhotos("t1", { page: 1, pageSize: 24 });
  expect(res.rows).toEqual([]);
  expect(tp.photo.findMany).not.toHaveBeenCalled();
});

it("listTechnicianPhotos searches customer / address / job ref / visit id and filters by review status", async () => {
  const tp = makeTp();
  tp.technician.findUnique.mockResolvedValue({ id: "t1" });
  tp.visit.count.mockResolvedValue(0);
  tp.visit.findMany.mockResolvedValue([{ id: "v1" }]);
  tp.photo.findMany.mockResolvedValue([]);
  const svc = createPhotoGalleryService(tp);

  await svc.listTechnicianPhotos("t1", { page: 1, pageSize: 24, search: "  JOB-000012 ", reviewStatus: "PENDING" as never });

  const contains = { contains: "JOB-000012", mode: "insensitive" };
  expect(tp.visit.count).toHaveBeenCalledWith({
    where: {
      technicianId: "t1",
      photos: { some: { reviewStatus: "PENDING" } },
      OR: [
        { id: contains },
        { jobNumber: 12 },
        { property: { addressLine: contains } },
        { property: { postcode: contains } },
        { property: { propertyName: contains } },
        { property: { customer: { name: contains } } },
      ],
    },
  });
  expect(tp.photo.findMany.mock.calls[0][0].where).toEqual({ visitId: { in: ["v1"] }, reviewStatus: "PENDING" });

  await svc.listTechnicianPhotos("t1", { page: 1, pageSize: 24, search: "smith" });
  expect(tp.visit.count.mock.calls[1][0].where.OR.some((c: any) => "jobNumber" in c)).toBe(false);

  await svc.listTechnicianPhotos("t1", { page: 1, pageSize: 24, search: "   " });
  expect(tp.visit.count.mock.calls[2][0]).toEqual({ where: { technicianId: "t1", photos: { some: {} } } });
});

it("approveTechnicianPhotos approves pending photos of that technician (all, or just photoIds)", async () => {
  const tp = makeTp();
  tp.technician.findUnique.mockResolvedValue({ id: "t1" });
  tp.photo.updateMany.mockResolvedValue({ count: 2 });
  const svc = createPhotoGalleryService(tp);

  expect(await svc.approveTechnicianPhotos("t1", undefined, { reviewedById: "prof1" })).toEqual({ updated: 2 });
  const first = tp.photo.updateMany.mock.calls[0][0];
  expect(first.where).toEqual({ visit: { technicianId: "t1" }, reviewStatus: "PENDING" });
  expect(first.data).toMatchObject({ reviewStatus: "APPROVED", reviewedById: "prof1" });
  expect(first.data.reviewedAt).toBeInstanceOf(Date);

  await svc.approveTechnicianPhotos("t1", ["ph1"], { reviewedById: null });
  expect(tp.photo.updateMany.mock.calls[1][0].where).toEqual({
    visit: { technicianId: "t1" },
    reviewStatus: "PENDING",
    id: { in: ["ph1"] },
  });
});

it("approveTechnicianPhotos 404s for an unknown technician", async () => {
  const tp = makeTp();
  tp.technician.findUnique.mockResolvedValue(null);
  await expect(
    createPhotoGalleryService(tp).approveTechnicianPhotos("x", undefined, { reviewedById: null })
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(tp.photo.updateMany).not.toHaveBeenCalled();
});

it("reviewTechnicianPhoto sets the status for the technician's photo and 404s otherwise", async () => {
  const tp = makeTp();
  const svc = createPhotoGalleryService(tp);
  tp.photo.findFirst.mockResolvedValueOnce(null);
  await expect(svc.reviewTechnicianPhoto("t1", "nope", "REJECTED", { reviewedById: "prof1" })).rejects.toMatchObject({
    statusCode: 404,
  });
  expect(tp.photo.findFirst).toHaveBeenCalledWith({
    where: { id: "nope", visit: { technicianId: "t1" } },
    select: { id: true },
  });

  tp.photo.findFirst.mockResolvedValueOnce({ id: "ph1" });
  tp.photo.update.mockResolvedValue({ id: "ph1", reviewStatus: "REJECTED", reviewedAt: new Date() });
  const res = await svc.reviewTechnicianPhoto("t1", "ph1", "REJECTED", { reviewedById: "prof1" });
  expect(res.reviewStatus).toBe("REJECTED");
  const call = tp.photo.update.mock.calls[0][0];
  expect(call.where).toEqual({ id: "ph1" });
  expect(call.data).toMatchObject({ reviewStatus: "REJECTED", reviewedById: "prof1" });
});
