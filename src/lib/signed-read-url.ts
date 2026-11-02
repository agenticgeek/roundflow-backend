// Signed READ urls for objects in the visit-photos bucket (B4 · GAP-019) —
// the single read-side helper (visit photos, property/technician galleries).
// storage.ts only signs uploads; this is its read-side counterpart, kept in
// its own file. Photo.url holds whatever the app stored after upload: usually
// the object path ("<tenant>/visits/<visit>/before-123.jpg"), sometimes a
// full Supabase storage URL. Both are mapped back to the object path and
// signed in one batch request. A URL that isn't a storage object of this
// bucket (e.g. an external image) is returned unchanged.

export const READ_URL_TTL_SECONDS = 3600; // 1 h

function bucket(): string {
  return process.env.VISIT_PHOTOS_BUCKET || "visit-photos";
}

// Stored value → object path inside the bucket, or null when it isn't one.
export function toObjectPath(stored: string): string | null {
  if (!/^https?:\/\//i.test(stored)) return stored.replace(/^\/+/, "");
  const marker = `/storage/v1/object/`;
  const at = stored.indexOf(marker);
  if (at === -1) return null;
  // /storage/v1/object/{public|sign|authenticated}/<bucket>/<path>[?query]
  const rest = stored.slice(at + marker.length).split("?")[0];
  const parts = rest.split("/");
  const kindless = ["public", "sign", "authenticated"].includes(parts[0]) ? parts.slice(1) : parts;
  if (kindless[0] !== bucket() || kindless.length < 2) return null;
  return decodeURIComponent(kindless.slice(1).join("/"));
}

// Returns stored value → signed url (or the stored value itself when it
// isn't a bucket object, or null when Storage couldn't sign that object).
export async function createSignedReadUrls(
  stored: string[],
  expiresIn: number = READ_URL_TTL_SECONDS
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const pathByStored = new Map<string, string>();
  for (const value of stored) {
    const path = toObjectPath(value);
    if (path === null) result.set(value, value);
    else pathByStored.set(value, path);
  }
  if (pathByStored.size === 0) return result;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");

  const paths = [...new Set(pathByStored.values())];
  const res = await fetch(`${url}/storage/v1/object/sign/${bucket()}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn, paths }),
  });
  if (!res.ok) throw new Error(`Storage error: ${await res.text()}`);
  const data = (await res.json()) as Array<{ path: string | null; signedURL: string | null; error: string | null }>;

  const signedByPath = new Map<string, string>();
  for (const item of data) {
    if (item.path && item.signedURL && !item.error) signedByPath.set(item.path, `${url}/storage/v1${item.signedURL}`);
  }
  for (const [value, path] of pathByStored) result.set(value, signedByPath.get(path) ?? null);
  return result;
}

// ── Thumbnails ───────────────────────────────────────────────────────────────
// Supabase Storage image transformation: POST /object/sign/<bucket>/<path> with
// a `transform` option returns a signed /render/image url. It is single-object
// only (no batch form) and a plan-tier feature, so this is best-effort: any
// object that can't be transformed is simply absent from the result and the
// caller falls back to the full signed url. If the first request fails (e.g.
// transforms not enabled) the rest are skipped rather than failing N times.

export const THUMBNAIL_WIDTH = 480;
export const THUMBNAIL_QUALITY = 70;
const THUMBNAIL_CONCURRENCY = 8;

async function signThumbnail(base: string, key: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}/storage/v1/object/sign/${bucket()}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expiresIn: READ_URL_TTL_SECONDS,
        transform: { width: THUMBNAIL_WIDTH, quality: THUMBNAIL_QUALITY, resize: "contain" },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { signedURL?: string | null };
    return data.signedURL ? `${base}/storage/v1${data.signedURL}` : null;
  } catch {
    return null;
  }
}

// Returns stored value → signed thumbnail url, for the bucket objects among
// `stored` that could be transformed. Never throws; missing entries mean
// "use the full url".
export async function createSignedThumbnailUrls(stored: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return result;

  const pathByStored = new Map<string, string>();
  for (const value of stored) {
    const path = toObjectPath(value);
    if (path !== null) pathByStored.set(value, path);
  }
  const entries = [...pathByStored];
  if (entries.length === 0) return result;

  const [firstStored, firstPath] = entries[0];
  const first = await signThumbnail(base, key, firstPath);
  if (first === null) return result; // transforms unavailable — don't hammer Storage
  result.set(firstStored, first);

  const rest = entries.slice(1);
  for (let i = 0; i < rest.length; i += THUMBNAIL_CONCURRENCY) {
    const chunk = rest.slice(i, i + THUMBNAIL_CONCURRENCY);
    const signed = await Promise.all(chunk.map(([, path]) => signThumbnail(base, key, path)));
    chunk.forEach(([value], index) => {
      const url = signed[index];
      if (url) result.set(value, url);
    });
  }
  return result;
}

export interface SignedPhotoUrls {
  url: string | null;
  thumbnailUrl: string | null;
}

// Full + thumbnail urls for the admin galleries. The thumbnail falls back to
// the full url when a transformed one couldn't be signed (plan tier, error).
export async function createSignedPhotoUrls(stored: string[]): Promise<Map<string, SignedPhotoUrls>> {
  const [full, thumbs] = await Promise.all([createSignedReadUrls(stored), createSignedThumbnailUrls(stored)]);
  const result = new Map<string, SignedPhotoUrls>();
  for (const [value, url] of full) result.set(value, { url, thumbnailUrl: thumbs.get(value) ?? url });
  return result;
}
