import { describe, it, expect, vi, beforeEach } from "vitest";

const createSignedReadUrls = vi.fn();
vi.mock("../../lib/signed-read-url", () => ({
  createSignedReadUrls: (...args: unknown[]) => createSignedReadUrls(...args),
}));

import { createVisitPhotosService } from "../visit-photos.service";

function makeTp() {
  return { visit: { findUnique: vi.fn() }, photo: { findMany: vi.fn() } };
}

beforeEach(() => vi.clearAllMocks());

describe("visit photos service", () => {
  it("404s for an unknown visit", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue(null);
    await expect(createVisitPhotosService(tp as any).listForVisit("v1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns signed rows with visit date and technician", async () => {
    const tp = makeTp();
    const takenAt = new Date("2026-10-30T09:00:00Z");
    tp.visit.findUnique.mockResolvedValue({ id: "v1", date: new Date("2026-10-30T00:00:00Z"), technician: { id: "t1", name: "Sam" } });
    tp.photo.findMany.mockResolvedValue([
      { id: "ph1", type: "BEFORE", url: "t/visits/v1/before.jpg", createdAt: takenAt },
      { id: "ph2", type: "AFTER", url: "t/visits/v1/missing.jpg", createdAt: takenAt },
    ]);
    createSignedReadUrls.mockResolvedValue(new Map([
      ["t/visits/v1/before.jpg", "https://signed/before"],
      ["t/visits/v1/missing.jpg", null],
    ]));

    const out = await createVisitPhotosService(tp as any).listForVisit("v1");

    expect(createSignedReadUrls).toHaveBeenCalledWith(["t/visits/v1/before.jpg", "t/visits/v1/missing.jpg"]);
    expect(out.rows[0]).toEqual({
      id: "ph1", type: "BEFORE", url: "https://signed/before", thumbnailUrl: "https://signed/before",
      takenAt, visitId: "v1", visitDate: "2026-10-30", technician: { id: "t1", name: "Sam" },
    });
    expect(out.rows[1].url).toBeNull();
    expect(out.pagination).toEqual({ page: 1, pageSize: 2, total: 2, totalPages: 1 });
  });

  it("returns technician null for an unassigned visit", async () => {
    const tp = makeTp();
    tp.visit.findUnique.mockResolvedValue({ id: "v1", date: new Date("2026-10-30T00:00:00Z"), technician: null });
    tp.photo.findMany.mockResolvedValue([{ id: "ph1", type: "BEFORE", url: "https://cdn/x.jpg", createdAt: new Date() }]);
    createSignedReadUrls.mockResolvedValue(new Map([["https://cdn/x.jpg", "https://cdn/x.jpg"]]));
    const out = await createVisitPhotosService(tp as any).listForVisit("v1");
    expect(out.rows[0].technician).toBeNull();
  });
});
