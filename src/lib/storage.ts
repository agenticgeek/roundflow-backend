import { StorageClient } from "@supabase/storage-js";

export const ALLOWED_PHOTO_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

export function buildVisitPhotoPath(
  tenantId: string,
  visitId: string,
  photoType: "BEFORE" | "AFTER",
  mimeType: string
): string {
  const ext = MIME_TO_EXT[mimeType] ?? "jpg";
  const label = photoType.toLowerCase();
  const ts = Date.now();
  return `${tenantId}/visits/${visitId}/${label}-${ts}.${ext}`;
}

function getStorageClient(): StorageClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  return new StorageClient(`${url}/storage/v1`, {
    apikey: key,
    Authorization: `Bearer ${key}`,
  });
}

const BUCKET = process.env.VISIT_PHOTOS_BUCKET ?? "visit-photos";

export async function createSignedUploadUrl(
  path: string
): Promise<{ signedUrl: string; token: string; path: string }> {
  const storage = getStorageClient();
  const { data, error } = await storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(`Storage error: ${error?.message ?? "unknown"}`);
  return { signedUrl: data.signedUrl, token: data.token, path: data.path };
}

export function getPublicUrl(path: string): string {
  const url = process.env.SUPABASE_URL;
  const bucket = BUCKET;
  return `${url}/storage/v1/object/public/${bucket}/${path}`;
}
