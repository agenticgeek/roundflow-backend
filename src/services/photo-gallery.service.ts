import { PhotoReviewStatus, PhotoType, Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { createSignedPhotoUrls } from "../lib/signed-read-url";

// Admin photo galleries (B4 · GAP-019): property detail and technician
// detail. Rows carry a 1 h signed read url; the web refetches on focus.
// Tenant isolation comes from the tenant-schema client itself.

export interface PhotoRow {
  id: string;
  type: PhotoType;
  url: string | null;
  // Resized signed url (Storage image transform); the full signed url when
  // Storage can't transform (plan tier, error) — see createSignedPhotoUrls.
  thumbnailUrl: string | null;
  takenAt: Date;
  visitId: string | null;
  visitDate: Date | null;
  jobRef: string | null; // the visit's "JOB-000123"
  technician: { id: string; name: string | null } | null;
  reviewStatus: PhotoReviewStatus;
  propertyAddress: string | null; // the visit's property
  customerName: string | null;
}

export interface PhotoPage {
  rows: PhotoRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface PhotoPageParams {
  page: number;
  pageSize: number;
}

export interface TechnicianPhotoParams extends PhotoPageParams {
  search?: string; // customer name, address / postcode, or job ref ("JOB-000123", "123", visit id)
  reviewStatus?: PhotoReviewStatus;
}

export interface PhotoReviewActor {
  reviewedById: string | null;
}

export function formatJobRef(jobNumber: number): string {
  return `JOB-${String(jobNumber).padStart(6, "0")}`;
}

// "JOB-000123" / "job123" / "123" → 123; anything else → null.
export function parseJobNumber(search: string): number | null {
  const match = /^(?:job-?)?0*(\d{1,9})$/i.exec(search);
  return match ? Number(match[1]) : null;
}

const photoInclude = {
  visit: {
    select: {
      id: true,
      date: true,
      jobNumber: true,
      technician: { select: { id: true, name: true } },
      property: { select: { addressLine: true, customer: { select: { name: true } } } },
    },
  },
} satisfies Prisma.PhotoInclude;

type PhotoWithVisit = Prisma.PhotoGetPayload<{ include: typeof photoInclude }>;

async function toRows(photos: PhotoWithVisit[]): Promise<PhotoRow[]> {
  const signed = await createSignedPhotoUrls(photos.map((p) => p.url));
  return photos.map((p) => {
    const urls = signed.get(p.url);
    return {
      id: p.id,
      type: p.type,
      url: urls?.url ?? null,
      thumbnailUrl: urls?.thumbnailUrl ?? null,
      takenAt: p.createdAt,
      visitId: p.visitId,
      visitDate: p.visit?.date ?? null,
      jobRef: p.visit ? formatJobRef(p.visit.jobNumber) : null,
      technician: p.visit?.technician ?? null,
      reviewStatus: p.reviewStatus,
      propertyAddress: p.visit?.property.addressLine ?? null,
      customerName: p.visit?.property.customer.name ?? null,
    };
  });
}

const pagination = (page: number, pageSize: number, total: number) => ({
  page,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
});

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
      include: photoInclude,
    }),
  ]);
  return { rows: await toRows(photos), pagination: pagination(page, pageSize, total) };
}

async function assertTechnician(tp: TenantPrismaClient, technicianId: string) {
  const tech = await tp.technician.findUnique({ where: { id: technicianId }, select: { id: true } });
  if (!tech) throw new AppError(404, "Technician not found");
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

    // Photos from visits the technician did. Paged by VISIT (pagination counts
    // visits, `rows` are all their matching photos) so a visit never splits
    // across pages. Newest visit first.
    async listTechnicianPhotos(technicianId: string, params: TechnicianPhotoParams): Promise<PhotoPage> {
      await assertTechnician(tp, technicianId);
      const { page, pageSize } = params;
      const photoFilter: Prisma.PhotoWhereInput = params.reviewStatus ? { reviewStatus: params.reviewStatus } : {};
      const where: Prisma.VisitWhereInput = { technicianId, photos: { some: photoFilter } };
      const search = params.search?.trim();
      if (search) {
        const contains = { contains: search, mode: "insensitive" as const };
        const jobNumber = parseJobNumber(search);
        where.OR = [
          { id: contains },
          ...(jobNumber === null ? [] : [{ jobNumber }]),
          { property: { addressLine: contains } },
          { property: { postcode: contains } },
          { property: { propertyName: contains } },
          { property: { customer: { name: contains } } },
        ];
      }
      const [total, visits] = await Promise.all([
        tp.visit.count({ where }),
        tp.visit.findMany({
          where,
          orderBy: [{ date: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: { id: true },
        }),
      ]);
      const order = new Map(visits.map((v, index) => [v.id, index]));
      const photos =
        visits.length === 0
          ? []
          : await tp.photo.findMany({
              where: { visitId: { in: [...order.keys()] }, ...photoFilter },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              include: photoInclude,
            });
      photos.sort((a, b) => (order.get(a.visitId as string) ?? 0) - (order.get(b.visitId as string) ?? 0));
      return { rows: await toRows(photos), pagination: pagination(page, pageSize, total) };
    },

    // Approve the technician's PENDING photos — all of them, or just photoIds.
    // Only that technician's visit photos are touched; returns how many changed.
    async approveTechnicianPhotos(
      technicianId: string,
      photoIds: string[] | undefined,
      { reviewedById }: PhotoReviewActor
    ): Promise<{ updated: number }> {
      await assertTechnician(tp, technicianId);
      const { count } = await tp.photo.updateMany({
        where: {
          visit: { technicianId },
          reviewStatus: PhotoReviewStatus.PENDING,
          ...(photoIds ? { id: { in: photoIds } } : {}),
        },
        data: { reviewStatus: PhotoReviewStatus.APPROVED, reviewedAt: new Date(), reviewedById },
      });
      return { updated: count };
    },

    // Approve or reject one of the technician's photos (re-reviewable).
    async reviewTechnicianPhoto(
      technicianId: string,
      photoId: string,
      status: "APPROVED" | "REJECTED",
      { reviewedById }: PhotoReviewActor
    ): Promise<{ id: string; reviewStatus: PhotoReviewStatus; reviewedAt: Date | null }> {
      const photo = await tp.photo.findFirst({
        where: { id: photoId, visit: { technicianId } },
        select: { id: true },
      });
      if (!photo) throw new AppError(404, "Photo not found");
      return tp.photo.update({
        where: { id: photoId },
        data: { reviewStatus: status, reviewedAt: new Date(), reviewedById },
        select: { id: true, reviewStatus: true, reviewedAt: true },
      });
    },
  };
}
