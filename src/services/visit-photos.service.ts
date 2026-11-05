import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import type { SignedPhotoUrls } from "../lib/signed-read-url";
import { AppError } from "../lib/app-error";
import { createSignedPhotoUrls } from "../lib/signed-read-url";

// B4: before/after photos for the admin app. URLs are signed reads (1 h TTL).

export interface PhotoRow {
  id: string;
  type: string;
  url: string | null;
  thumbnailUrl: string | null;
  takenAt: Date;
  visitId: string | null;
  visitDate: string | null;
  technician: { id: string; name: string | null } | null;
  reviewStatus: string;
}

export function createVisitPhotosService(tp: TenantPrismaClient) {
  return {
    async listForVisit(visitId: string) {
      const visit = await tp.visit.findUnique({
        where: { id: visitId },
        select: { id: true, date: true, technician: { select: { id: true, name: true } } },
      });
      if (!visit) throw new AppError(404, "Visit not found");

      const photos = await tp.photo.findMany({
        where: { visitId },
        orderBy: { createdAt: "asc" },
        select: { id: true, type: true, url: true, createdAt: true, reviewStatus: true },
      });
      const signed = await createSignedPhotoUrls(photos.map((p) => p.url));
      const visitDate = visit.date.toISOString().slice(0, 10);

      const rows: PhotoRow[] = photos.map((p) => {
        const urls = signed.get(p.url) as SignedPhotoUrls; // every input path is a key
        return {
          id: p.id,
          type: p.type,
          url: urls.url,
          thumbnailUrl: urls.thumbnailUrl, // transformed when Storage allows, else the full url
          takenAt: p.createdAt,
          visitId: visit.id,
          visitDate,
          technician: visit.technician ? { id: visit.technician.id, name: visit.technician.name } : null,
          reviewStatus: p.reviewStatus,
        };
      });
      return {
        rows,
        pagination: { page: 1, pageSize: rows.length, total: rows.length, totalPages: 1 },
      };
    },
  };
}
