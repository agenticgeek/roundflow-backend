import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { createSignedReadUrls } from "../lib/signed-read-url";

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
        select: { id: true, type: true, url: true, createdAt: true },
      });
      const signed = await createSignedReadUrls(photos.map((p) => p.url));
      const visitDate = visit.date.toISOString().slice(0, 10);

      const rows: PhotoRow[] = photos.map((p) => {
        const url = signed.get(p.url) as string | null; // every input path is a key
        return {
          id: p.id,
          type: p.type,
          url,
          // No server-side thumbnails yet: the client scales the signed URL.
          thumbnailUrl: url,
          takenAt: p.createdAt,
          visitId: visit.id,
          visitDate,
          technician: visit.technician ? { id: visit.technician.id, name: visit.technician.name } : null,
        };
      });
      return {
        rows,
        pagination: { page: 1, pageSize: rows.length, total: rows.length, totalPages: 1 },
      };
    },
  };
}
