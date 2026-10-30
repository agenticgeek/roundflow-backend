import { it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/signed-read-url", () => ({ createSignedReadUrls: vi.fn() }));

import { createPhotoGalleryService } from "../photo-gallery.service";
import { createSignedReadUrls } from "../../lib/signed-read-url";

function makeTp() {
  return {
    property: { findUnique: vi.fn() },
    technician: { findUnique: vi.fn() },
    photo: { count: vi.fn(), findMany: vi.fn() },
  } as any;
}

const PHOTOS = [
  {
    id: "ph1",
    type: "BEFORE",
    url: "t1/a.jpg",
    createdAt: new Date("2026-10-01T09:00:00Z"),
    visitId: "v1",
    visit: { id: "v1", date: new Date("2026-10-01"), technician: { id: "t1", name: "Sam" } },
  },
  { id: "ph2", type: "PROPERTY", url: "t1/b.jpg", createdAt: new Date("2026-09-01"), visitId: null, visit: null },
];

beforeEach(() => {
  vi.mocked(createSignedReadUrls).mockResolvedValue(new Map([["t1/a.jpg", "https://signed/a"]]));
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
  expect(createSignedReadUrls).toHaveBeenCalledWith(["t1/a.jpg", "t1/b.jpg"]);
  expect(res.pagination).toEqual({ page: 2, pageSize: 24, total: 30, totalPages: 2 });
  expect(res.rows).toEqual([
    {
      id: "ph1",
      type: "BEFORE",
      url: "https://signed/a",
      thumbnailUrl: "https://signed/a",
      takenAt: new Date("2026-10-01T09:00:00Z"),
      visitId: "v1",
      visitDate: new Date("2026-10-01"),
      technician: { id: "t1", name: "Sam" },
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

it("listTechnicianPhotos 404s for an unknown technician and scopes to their visits", async () => {
  const tp = makeTp();
  tp.technician.findUnique.mockResolvedValueOnce(null);
  await expect(createPhotoGalleryService(tp).listTechnicianPhotos("x", { page: 1, pageSize: 24 })).rejects.toMatchObject({
    statusCode: 404,
  });

  tp.technician.findUnique.mockResolvedValueOnce({ id: "t1" });
  tp.photo.count.mockResolvedValue(1);
  tp.photo.findMany.mockResolvedValue([PHOTOS[0]]);
  const res = await createPhotoGalleryService(tp).listTechnicianPhotos("t1", { page: 1, pageSize: 24 });
  expect(tp.photo.count).toHaveBeenCalledWith({ where: { visit: { technicianId: "t1" } } });
  expect(res.rows).toHaveLength(1);
});
