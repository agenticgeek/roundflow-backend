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

const BUCKET = process.env.VISIT_PHOTOS_BUCKET ?? "visit-photos";

export async function createSignedUploadUrl(
  path: string
): Promise<{ signedUrl: string; token: string; path: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");

  const res = await fetch(`${url}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Storage error: ${await res.text()}`);
  const data = await res.json() as { url: string };
  const signedUrl = new URL(`${url}/storage/v1${data.url}`);
  const token = signedUrl.searchParams.get("token") ?? "";
  return { signedUrl: signedUrl.toString(), token, path };
}

