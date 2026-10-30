import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { AppError } from "../../lib/app-error";
import { buildVisitPhotoPath, buildAvatarPath, buildChatAttachmentPath, createSignedUploadUrl } from "../../lib/storage.js";

class MediaService {
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
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId }, select: { id: true, propertyId: true } });
    if (!visit) throw new AppError(404, "Visit not found");
    // propertyId lets the admin property gallery find the photo (B4).
    await this.prisma.photo.create({ data: { visitId, propertyId: visit.propertyId, url, type: photoType } });
  }

  async getPhotoUploadUrl(visitId: string, photoType: "BEFORE" | "AFTER" | "ACCESS_ISSUE", mimeType: string, tenantId: string): Promise<{ signedUrl: string; path: string }> {
    const visit = await this.prisma.visit.findUnique({ where: { id: visitId }, select: { id: true } });
    if (!visit) throw new AppError(404, "Visit not found");
    const path = buildVisitPhotoPath(tenantId, visitId, photoType, mimeType);
    const { signedUrl } = await createSignedUploadUrl(path);
    return { signedUrl, path };
  }

  async getAvatarUploadUrl(profileId: string, mimeType: string, tenantId: string): Promise<{ signedUrl: string; path: string }> {
    const path = buildAvatarPath(tenantId, profileId, mimeType);
    const { signedUrl } = await createSignedUploadUrl(path);
    return { signedUrl, path };
  }

  async getChatAttachmentUploadUrl(roundId: string, mimeType: string, tenantId: string): Promise<{ signedUrl: string; path: string }> {
    const path = buildChatAttachmentPath(tenantId, roundId, mimeType);
    const { signedUrl } = await createSignedUploadUrl(path);
    return { signedUrl, path };
  }
}

export function createMediaService(prisma: TenantPrismaClient) {
  return new MediaService(prisma);
}
