// Signed READ urls for media the technician app displays (avatar, chat
// attachments, visit photos). The stored value (storage path or URL) is kept
// as-is in the response; the signed url is added alongside it.
//
// Only objects under the caller's own tenant prefix ("<tenantId>/...") are
// signed — stored values come from the app (PATCH /mobile/me avatarUrl, chat
// photoUrls), so a path pointing at another tenant's object yields null rather
// than a readable url. A value that isn't a bucket object (an external image
// URL) is passed through unchanged. If Storage can't be reached the signed
// field is null and the response still succeeds.
import { createSignedReadUrls, toObjectPath } from "../lib/signed-read-url";

export async function signTenantMedia(
  tenantId: string,
  stored: Array<string | null | undefined>
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const toSign: string[] = [];
  for (const value of stored) {
    if (!value) continue;
    const path = toObjectPath(value);
    if (path !== null && !path.startsWith(`${tenantId}/`)) result.set(value, null);
    else toSign.push(value);
  }
  if (toSign.length === 0) return result;
  try {
    const signed = await createSignedReadUrls(toSign);
    for (const value of toSign) result.set(value, signed.get(value) as string | null); // every input is a key
  } catch (err) {
    console.warn("[mobile] signing media read urls failed:", (err as Error).message);
    for (const value of toSign) result.set(value, null);
  }
  return result;
}

export async function signAvatar(tenantId: string, avatarUrl: string | null): Promise<string | null> {
  if (!avatarUrl) return null;
  return (await signTenantMedia(tenantId, [avatarUrl])).get(avatarUrl) as string | null;
}

// Chat rows gain `photoSignedUrls`, index-aligned with `photoUrls`.
export async function signChatRows<T extends { photoUrls: string[] }>(
  tenantId: string,
  rows: T[]
): Promise<Array<T & { photoSignedUrls: Array<string | null> }>> {
  const signed = await signTenantMedia(tenantId, rows.flatMap((r) => r.photoUrls));
  return rows.map((r) => ({ ...r, photoSignedUrls: r.photoUrls.map((u) => signed.get(u) ?? null) }));
}

// Visit photos gain `signedUrl`; `url` stays the stored path.
export async function signPhotos<T extends { url: string }>(
  tenantId: string,
  photos: T[]
): Promise<Array<T & { signedUrl: string | null }>> {
  const signed = await signTenantMedia(tenantId, photos.map((p) => p.url));
  return photos.map((p) => ({ ...p, signedUrl: signed.get(p.url) ?? null }));
}
