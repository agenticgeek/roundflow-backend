import { PhotoType, Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { createSignedReadUrls } from "../lib/signed-read-url";

// Admin photo galleries (B4 · GAP-019): property detail and technician
// detail. Rows carry a 1 h signed read url; the web refetches on focus.
// Tenant isolation comes from the tenant-schema client itself.

export interface PhotoRow {
  id: string;
  type: PhotoType;
  url: string | null;
  thumbnailUrl: string | null; // same signed url — no server-side thumbnails yet
  takenAt: Date;
  visitId: string | null;
  visitDate: Date | null;
  technician: { id: string; name: string | null } | null;
}

export interface PhotoPage {
  rows: PhotoRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface PhotoPageParams {
  page: number;
  pageSize: number;
}

async function listPhotos(
  tp: TenantPrismaClient,
  where: Prisma.PhotoWhereInput,
  { page, pageSize }: PhotoPageParams
): Promise<PhotoPage> {
  const [total, photos] = await Promise.all([
    tp.photo.count({ where }),
    tp.photo.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        visit: { select: { id: true, date: true, technician: { select: { id: true, name: true } } } },
      },
    }),
  ]);
  const signed = await createSignedReadUrls(photos.map((p) => p.url));
  return {
    rows: photos.map((p) => {
      const url = signed.get(p.url) ?? null;
      return {
        id: p.id,
        type: p.type,
        url,
        thumbnailUrl: url,
        takenAt: p.createdAt,
        visitId: p.visitId,
        visitDate: p.visit?.date ?? null,
        technician: p.visit?.technician ?? null,
      };
    }),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

export function createPhotoGalleryService(tp: TenantPrismaClient) {
  return {
    // Photos of the property itself plus its visits' before/after photos.
    // propertyId is set on upload and backfilled; the visit join covers any
    // row the backfill missed.
    async listPropertyPhotos(
      propertyId: string,
      params: PhotoPageParams & { type?: PhotoType }
    ): Promise<PhotoPage> {
      const property = await tp.property.findUnique({ where: { id: propertyId }, select: { id: true } });
      if (!property) throw new AppError(404, "Property not found");
      return listPhotos(
        tp,
        {
          OR: [{ propertyId }, { visit: { propertyId } }],
          ...(params.type ? { type: params.type } : {}),
        },
        params
      );
    },

    // Photos from visits the technician did.
    async listTechnicianPhotos(technicianId: string, params: PhotoPageParams): Promise<PhotoPage> {
      const tech = await tp.technician.findUnique({ where: { id: technicianId }, select: { id: true } });
      if (!tech) throw new AppError(404, "Technician not found");
      return listPhotos(tp, { visit: { technicianId } }, params);
    },
  };
}
