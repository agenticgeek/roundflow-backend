import { createHash } from "node:crypto";

// ACT-10 (2026-11-06): the primary geocoder is the Google Geocoding API, called
// with the FULL address so properties in one postcode no longer share a point.
// postcodes.io (free, unauthenticated, postcode centre only) stays as the
// last-resort fallback and is always stored as POSTCODE_FALLBACK. Nothing in
// this file throws into a request path: geocodeAddress() returns an error
// string instead.
const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_TIMEOUT_MS = 5000;
const DEFAULT_DAILY_LIMIT = 2000;

export type GeocodePrecision =
  | "ROOFTOP"
  | "RANGE_INTERPOLATED"
  | "GEOMETRIC_CENTER"
  | "APPROXIMATE"
  | "POSTCODE_FALLBACK";

const GOOGLE_PRECISIONS: readonly GeocodePrecision[] = ["ROOFTOP", "RANGE_INTERPOLATED", "GEOMETRIC_CENTER", "APPROXIMATE"];

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  precision: GeocodePrecision;
  placeId: string | null;
}

export interface AddressParts {
  addressLine: string;
  postcode: string;
  /** Property has no town column today; accepted so callers/imports that have one can pass it. */
  town?: string | null;
}

export function isGoogleGeocodingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GOOGLE_MAPS_GEOCODING_API_KEY ?? "").trim() !== "";
}

// Pins from POSTCODE_FALLBACK / APPROXIMATE (and legacy rows that have
// coordinates but no precision, which were all postcode centres) are not
// reliable per-property locations.
export function isLocationApproximate(precision: string | null | undefined, latitude: number | null | undefined): boolean {
  if (latitude == null) return false;
  return !(precision === "ROOFTOP" || precision === "RANGE_INTERPOLATED" || precision === "GEOMETRIC_CENTER");
}

export function buildAddressQuery(a: AddressParts): string {
  return [a.addressLine.trim(), a.town?.trim(), a.postcode.trim().toUpperCase(), "UK"].filter(Boolean).join(", ");
}

// Hash of the address inputs. A property is geocoded again only when this changes.
export function hashAddress(a: AddressParts): string {
  const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/\s+/g, "");
  return createHash("sha256").update([a.addressLine, a.town, a.postcode].map(norm).join("|")).digest("hex");
}

// ---- daily quota guard (in memory, per process) ---------------------------

let quota: { day: string | null; used: number } = { day: null, used: 0 };

export function geocodeDailyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GEOCODE_DAILY_LIMIT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_LIMIT;
}

function rollQuota(now: Date): void {
  const day = now.toISOString().slice(0, 10);
  if (quota.day !== day) quota = { day, used: 0 };
}

export function geocodeQuotaRemaining(now: Date = new Date()): number {
  rollQuota(now);
  return Math.max(0, geocodeDailyLimit() - quota.used);
}

export function resetGeocodeQuota(): void {
  quota = { day: null, used: 0 };
}

// ---- Google ---------------------------------------------------------------

interface GoogleResponse {
  status: string;
  results?: {
    place_id?: string;
    partial_match?: boolean;
    geometry: { location: { lat: number; lng: number }; location_type: string };
  }[];
}

// One retry on 5xx or a network error/timeout; throws the last failure.
async function fetchGoogle(url: string): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
      if (res.status < 500) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function googleLookup(a: AddressParts, key: string): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({ address: buildAddressQuery(a), components: "country:GB", region: "gb", key });
  const res = await fetchGoogle(`${GOOGLE_GEOCODE_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as GoogleResponse;
  if (body.status === "ZERO_RESULTS") return null;
  const hit = body.results?.[0];
  if (body.status !== "OK" || !hit) throw new Error(`status ${body.status}`);
  const lt = hit.geometry.location_type as GeocodePrecision;
  const precision: GeocodePrecision = !hit.partial_match && GOOGLE_PRECISIONS.includes(lt) ? lt : "APPROXIMATE";
  return { latitude: hit.geometry.location.lat, longitude: hit.geometry.location.lng, precision, placeId: hit.place_id ?? null };
}

function scrub(err: unknown, key: string): string {
  return key === "" ? String(err) : String(err).split(key).join("***");
}

// Geocodes a property address. Google first (when the key is set and the daily
// quota allows), then postcodes.io as the last resort. NEVER throws.
export async function geocodeAddress(a: AddressParts): Promise<{ result: GeocodeResult | null; error: string | null }> {
  const key = (process.env.GOOGLE_MAPS_GEOCODING_API_KEY ?? "").trim();
  let error: string | null = null;

  if (key !== "" && geocodeQuotaRemaining() > 0) {
    quota.used += 1;
    try {
      const result = await googleLookup(a, key);
      if (result) return { result, error: null };
      error = "google: no result";
    } catch (err) {
      error = `google geocode failed: ${scrub(err, key)}`;
    }
  }

  try {
    const coords = await geocodePostcode(a.postcode);
    if (coords) return { result: { ...coords, precision: "POSTCODE_FALLBACK", placeId: null }, error: null };
    return { result: null, error: error ?? "postcode not found" };
  } catch (err) {
    return { result: null, error: error ?? scrub(err, key) };
  }
}

// ---- postcodes.io (fallback) ----------------------------------------------
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
