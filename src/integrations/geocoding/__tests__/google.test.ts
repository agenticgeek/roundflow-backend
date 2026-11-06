import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAddressQuery,
  hashAddress,
  isGoogleGeocodingConfigured,
  isLocationApproximate,
  geocodeAddress,
  geocodeQuotaRemaining,
  geocodeDailyLimit,
  resetGeocodeQuota,
} from "../client";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const addr = { addressLine: "1 High St", postcode: "AB1 2CD" };
const KEY = "test-key-123";

function googleOk(locationType: string, extra: Record<string, unknown> = {}) {
  return jsonResponse(200, {
    status: "OK",
    results: [{ place_id: "pid1", geometry: { location: { lat: 51.5, lng: -0.1 }, location_type: locationType }, ...extra }],
  });
}

describe("address helpers", () => {
  it("builds the full-address query with the country", () => {
    expect(buildAddressQuery({ addressLine: " 1 High St ", town: "Leeds", postcode: "ab1 2cd" })).toBe("1 High St, Leeds, AB1 2CD, UK");
    expect(buildAddressQuery(addr)).toBe("1 High St, AB1 2CD, UK");
    expect(buildAddressQuery({ ...addr, town: null })).toBe("1 High St, AB1 2CD, UK");
  });

  it("hashes the normalised address inputs", () => {
    const a = hashAddress(addr);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAddress({ addressLine: "  1 HIGH st", postcode: "ab12cd" })).toBe(a);
    expect(hashAddress({ ...addr, addressLine: "2 High St" })).not.toBe(a);
    expect(hashAddress({ ...addr, town: "Leeds" })).not.toBe(a);
  });

  it("reports whether the key is configured", () => {
    expect(isGoogleGeocodingConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isGoogleGeocodingConfigured({ GOOGLE_MAPS_GEOCODING_API_KEY: "  " } as NodeJS.ProcessEnv)).toBe(false);
    expect(isGoogleGeocodingConfigured({ GOOGLE_MAPS_GEOCODING_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe(true);
    expect(typeof isGoogleGeocodingConfigured()).toBe("boolean");
  });

  it("flags approximate locations", () => {
    expect(isLocationApproximate(null, null)).toBe(false);
    expect(isLocationApproximate(undefined, undefined)).toBe(false);
    expect(isLocationApproximate(null, 51.5)).toBe(true);
    expect(isLocationApproximate("POSTCODE_FALLBACK", 51.5)).toBe(true);
    expect(isLocationApproximate("APPROXIMATE", 51.5)).toBe(true);
    expect(isLocationApproximate("ROOFTOP", 51.5)).toBe(false);
    expect(isLocationApproximate("RANGE_INTERPOLATED", 51.5)).toBe(false);
    expect(isLocationApproximate("GEOMETRIC_CENTER", 51.5)).toBe(false);
  });
});

describe("geocodeAddress", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_MAPS_GEOCODING_API_KEY;
  const originalLimit = process.env.GEOCODE_DAILY_LIMIT;

  beforeEach(() => {
    process.env.GOOGLE_MAPS_GEOCODING_API_KEY = KEY;
    delete process.env.GEOCODE_DAILY_LIMIT;
    resetGeocodeQuota();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_GEOCODING_API_KEY;
    else process.env.GOOGLE_MAPS_GEOCODING_API_KEY = originalKey;
    if (originalLimit === undefined) delete process.env.GEOCODE_DAILY_LIMIT;
    else process.env.GEOCODE_DAILY_LIMIT = originalLimit;
  });

  it("calls Google with the full address, region=gb and the key", async () => {
    const f = vi.fn().mockResolvedValue(googleOk("ROOFTOP"));
    global.fetch = f as unknown as typeof fetch;

    const out = await geocodeAddress({ ...addr, town: "Leeds" });

    expect(out).toEqual({ result: { latitude: 51.5, longitude: -0.1, precision: "ROOFTOP", placeId: "pid1" }, error: null });
    const url = new URL(f.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://maps.googleapis.com/maps/api/geocode/json");
    expect(url.searchParams.get("address")).toBe("1 High St, Leeds, AB1 2CD, UK");
    expect(url.searchParams.get("components")).toBe("country:GB");
    expect(url.searchParams.get("region")).toBe("gb");
    expect(url.searchParams.get("key")).toBe(KEY);
    expect(f.mock.calls[0][1].signal).toBeDefined();
  });

  it.each(["ROOFTOP", "RANGE_INTERPOLATED", "GEOMETRIC_CENTER", "APPROXIMATE"])("stores %s precision", async (lt) => {
    global.fetch = vi.fn().mockResolvedValue(googleOk(lt)) as unknown as typeof fetch;
    const out = await geocodeAddress(addr);
    expect(out.result?.precision).toBe(lt);
  });

  it("stores a null place id when Google returns none", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { status: "OK", results: [{ geometry: { location: { lat: 1, lng: 2 }, location_type: "ROOFTOP" } }] })
    ) as unknown as typeof fetch;
    expect((await geocodeAddress(addr)).result?.placeId).toBeNull();
  });

  it("stores partial matches and unknown location types as APPROXIMATE", async () => {
    global.fetch = vi.fn().mockResolvedValue(googleOk("ROOFTOP", { partial_match: true })) as unknown as typeof fetch;
    expect((await geocodeAddress(addr)).result?.precision).toBe("APPROXIMATE");
    global.fetch = vi.fn().mockResolvedValue(googleOk("WEIRD")) as unknown as typeof fetch;
    expect((await geocodeAddress(addr)).result?.precision).toBe("APPROXIMATE");
  });

  it("retries once on a 5xx and succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(jsonResponse(503, {})).mockResolvedValueOnce(googleOk("ROOFTOP"));
    global.fetch = f as unknown as typeof fetch;
    const out = await geocodeAddress(addr);
    expect(out.result?.precision).toBe("ROOFTOP");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries once on a network error, then falls back to postcodes.io (never throws)", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.startsWith("https://maps.googleapis.com")) throw new Error(`boom ${KEY}`);
      return jsonResponse(200, { result: { latitude: 1, longitude: 2 } });
    });
    global.fetch = f as unknown as typeof fetch;
    const out = await geocodeAddress(addr);
    expect(out).toEqual({ result: { latitude: 1, longitude: 2, precision: "POSTCODE_FALLBACK", placeId: null }, error: null });
    expect(f.mock.calls.filter((c) => String(c[0]).includes("googleapis"))).toHaveLength(2);
  });

  it("falls back to postcodes.io on ZERO_RESULTS", async () => {
    global.fetch = vi.fn(async (url: string) =>
      url.includes("googleapis") ? jsonResponse(200, { status: "ZERO_RESULTS", results: [] }) : jsonResponse(200, { result: { latitude: 3, longitude: 4 } })
    ) as unknown as typeof fetch;
    const out = await geocodeAddress(addr);
    expect(out.result?.precision).toBe("POSTCODE_FALLBACK");
  });

  it("returns an error that never contains the key when everything fails", async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes("googleapis")) return jsonResponse(200, { status: "REQUEST_DENIED", results: [] });
      return jsonResponse(404, {});
    }) as unknown as typeof fetch;
    const out = await geocodeAddress(addr);
    expect(out.result).toBeNull();
    expect(out.error).toContain("REQUEST_DENIED");
    expect(out.error).not.toContain(KEY);
  });

  it("treats a non-ok Google response (4xx) as a failure and strips the key from messages", async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes("googleapis")) return jsonResponse(403, {});
      throw new Error(`net ${KEY}`);
    }) as unknown as typeof fetch;
    const out = await geocodeAddress(addr);
    expect(out.result).toBeNull();
    expect(out.error).toContain("google");
    expect(out.error).not.toContain(KEY);
  });

  it("reports 'postcode not found' when google has nothing and postcodes.io 404s", async () => {
    global.fetch = vi.fn(async (url: string) =>
      url.includes("googleapis") ? jsonResponse(200, { status: "ZERO_RESULTS", results: [] }) : jsonResponse(404, {})
    ) as unknown as typeof fetch;
    const out = await geocodeAddress(addr);
    expect(out).toEqual({ result: null, error: "google: no result" });
  });

  it("reports the postcodes.io error when google is unconfigured and the lookup throws", async () => {
    delete process.env.GOOGLE_MAPS_GEOCODING_API_KEY;
    global.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const out = await geocodeAddress(addr);
    expect(out.result).toBeNull();
    expect(out.error).toContain("offline");
  });

  it("reports 'postcode not found' when unconfigured and postcodes.io 404s", async () => {
    delete process.env.GOOGLE_MAPS_GEOCODING_API_KEY;
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(404, {})) as unknown as typeof fetch;
    expect(await geocodeAddress(addr)).toEqual({ result: null, error: "postcode not found" });
  });

  it("uses only postcodes.io when the key is unset (old behaviour, POSTCODE_FALLBACK)", async () => {
    delete process.env.GOOGLE_MAPS_GEOCODING_API_KEY;
    const f = vi.fn().mockResolvedValue(jsonResponse(200, { result: { latitude: 5, longitude: 6 } }));
    global.fetch = f as unknown as typeof fetch;
    const out = await geocodeAddress(addr);
    expect(out.result).toEqual({ latitude: 5, longitude: 6, precision: "POSTCODE_FALLBACK", placeId: null });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toContain("postcodes.io");
  });

  it("enforces the in-memory daily quota and falls back once it is spent", async () => {
    process.env.GEOCODE_DAILY_LIMIT = "1";
    expect(geocodeDailyLimit()).toBe(1);
    expect(geocodeQuotaRemaining()).toBe(1);
    const f = vi.fn(async (url: string) => (url.includes("googleapis") ? googleOk("ROOFTOP") : jsonResponse(200, { result: { latitude: 7, longitude: 8 } })));
    global.fetch = f as unknown as typeof fetch;
    expect((await geocodeAddress(addr)).result?.precision).toBe("ROOFTOP");
    expect(geocodeQuotaRemaining()).toBe(0);
    expect((await geocodeAddress(addr)).result?.precision).toBe("POSTCODE_FALLBACK");
    expect(f.mock.calls.filter((c) => String(c[0]).includes("googleapis"))).toHaveLength(1);
  });

  it("resets the quota on a new UTC day and defaults the limit to 2000", () => {
    delete process.env.GEOCODE_DAILY_LIMIT;
    expect(geocodeDailyLimit()).toBe(2000);
    process.env.GEOCODE_DAILY_LIMIT = "abc";
    expect(geocodeDailyLimit()).toBe(2000);
    process.env.GEOCODE_DAILY_LIMIT = "0";
    expect(geocodeDailyLimit()).toBe(0);
    process.env.GEOCODE_DAILY_LIMIT = "5";
    expect(geocodeQuotaRemaining(new Date("2026-11-06T10:00:00Z"))).toBe(5);
    expect(geocodeQuotaRemaining(new Date("2026-11-07T10:00:00Z"))).toBe(5);
  });
});
