import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";
import { buildVisitPhotoPath, createSignedUploadUrl } from "../../lib/storage.js";

export interface IMediaService {
  addVisitNote(visitId: string, text: string): Promise<void>;
  addVisitPhoto(visitId: string, url: string, photoType: "BEFORE" | "AFTER"): Promise<void>;
  getPhotoUploadUrl(visitId: string, photoType: "BEFORE" | "AFTER", mimeType: string, tenantId: string): Promise<{ signedUrl: string; path: string }>;
}

class MediaService implements IMediaService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async addVisitNote(visitId: string, text: string): Promise<void> {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      select: { id: true, propertyId: true },
    });
    if (!visit) throw new AppError(404, "Visit not found");
    await this.prisma.propertyNote.create({
      data: { propertyId: visit.propertyId, body: text, type: "INTERNAL" },
    });
  }

  async addVisitPhoto(visitId: string, url: string, photoType: "BEFORE" | "AFTER"): Promise<void> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId }, select: { id: true } });
    if (!visit) throw new AppError(404, "Visit not found");
    await this.prisma.photo.create({ data: { visitId, url, type: photoType } });
  }

  async getPhotoUploadUrl(visitId: string, photoType: "BEFORE" | "AFTER", mimeType: string, tenantId: string): Promise<{ signedUrl: string; path: string }> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId }, select: { id: true } });
    if (!visit) throw new AppError(404, "Visit not found");
    const path = buildVisitPhotoPath(tenantId, visitId, photoType, mimeType);
    const { signedUrl } = await createSignedUploadUrl(path);
    return { signedUrl, path };
  }
}

export function createMediaService(prisma: TenantPrismaClient): IMediaService {
  return new MediaService(prisma);
}
