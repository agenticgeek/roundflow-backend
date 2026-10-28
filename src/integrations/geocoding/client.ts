// UK postcode geocoding via postcodes.io — free, unauthenticated, no API key.
// See docs/handoff/backend/2026-10-29-property-geocoding-handoff.md for why
// this provider was chosen over a paid maps API.
const POSTCODES_API = "https://api.postcodes.io";
const BULK_CHUNK_SIZE = 100;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

interface PostcodesIoResult {
  latitude: number;
  longitude: number;
}

interface PostcodesIoLookupResponse {
  result: PostcodesIoResult;
}

interface PostcodesIoBulkEntry {
  query: string;
  result: PostcodesIoResult | null;
}

interface PostcodesIoBulkResponse {
  result: PostcodesIoBulkEntry[];
}

// Returns null when the postcode is well-formed but not found (404) — that's
// not a failure, just no coordinates. Throws on any other non-2xx response or
// network error so callers can distinguish "no match" from "lookup broke".
export async function geocodePostcode(postcode: string): Promise<Coordinates | null> {
  const res = await fetch(`${POSTCODES_API}/postcodes/${encodeURIComponent(postcode)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`postcodes.io lookup failed (${res.status}): ${await res.text()}`);

  const body = (await res.json()) as PostcodesIoLookupResponse;
  return { latitude: body.result.latitude, longitude: body.result.longitude };
}

// Looks up many postcodes at once (chunked to the API's 100-per-request
// limit). The returned map has one entry per input postcode; a postcode with
// no match maps to null rather than being omitted.
export async function geocodePostcodesBulk(
  postcodes: string[]
): Promise<Map<string, Coordinates | null>> {
  const results = new Map<string, Coordinates | null>();
  if (postcodes.length === 0) return results;

  for (let i = 0; i < postcodes.length; i += BULK_CHUNK_SIZE) {
    const chunk = postcodes.slice(i, i + BULK_CHUNK_SIZE);
    const res = await fetch(`${POSTCODES_API}/postcodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postcodes: chunk }),
    });
    if (!res.ok) throw new Error(`postcodes.io bulk lookup failed (${res.status}): ${await res.text()}`);

    const body = (await res.json()) as PostcodesIoBulkResponse;
    for (const entry of body.result) {
      results.set(entry.query, entry.result ? { latitude: entry.result.latitude, longitude: entry.result.longitude } : null);
    }
  }

  return results;
}
