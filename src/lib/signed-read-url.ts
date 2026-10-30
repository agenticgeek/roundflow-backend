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
