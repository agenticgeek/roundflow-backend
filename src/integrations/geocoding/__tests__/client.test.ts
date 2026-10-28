import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { geocodePostcode, geocodePostcodesBulk } from "../client";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("geocodePostcode", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns coordinates on a successful lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { result: { latitude: 51.501, longitude: -0.141 } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await geocodePostcode("SW1A 1AA");

    expect(result).toEqual({ latitude: 51.501, longitude: -0.141 });
    expect(fetchMock).toHaveBeenCalledWith("https://api.postcodes.io/postcodes/SW1A%201AA");
  });

  it("returns null when the postcode is not found (404)", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(404, { error: "Invalid postcode" })) as unknown as typeof fetch;

    const result = await geocodePostcode("ZZ99 9ZZ");

    expect(result).toBeNull();
  });

  it("throws on a non-2xx, non-404 response", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })) as unknown as typeof fetch;

    await expect(geocodePostcode("SW1A 1AA")).rejects.toThrow(/postcodes\.io lookup failed \(500\)/);
  });
});

describe("geocodePostcodesBulk", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns an empty map for an empty input without calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await geocodePostcodesBulk([]);

    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps found and not-found postcodes from a single-chunk request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        result: [
          { query: "SW1A 1AA", result: { latitude: 51.501, longitude: -0.141 } },
          { query: "ZZ99 9ZZ", result: null },
        ],
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await geocodePostcodesBulk(["SW1A 1AA", "ZZ99 9ZZ"]);

    expect(result.get("SW1A 1AA")).toEqual({ latitude: 51.501, longitude: -0.141 });
    expect(result.get("ZZ99 9ZZ")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://api.postcodes.io/postcodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postcodes: ["SW1A 1AA", "ZZ99 9ZZ"] }),
    });
  });

  it("chunks requests over 100 postcodes", async () => {
    const postcodes = Array.from({ length: 150 }, (_, i) => `PC${i}`);
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const { postcodes: chunk } = JSON.parse(init.body) as { postcodes: string[] };
      return jsonResponse(200, {
        result: chunk.map((query) => ({ query, result: { latitude: 1, longitude: 2 } })),
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await geocodePostcodesBulk(postcodes);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(150);
    expect(result.get("PC0")).toEqual({ latitude: 1, longitude: 2 });
    expect(result.get("PC149")).toEqual({ latitude: 1, longitude: 2 });
  });

  it("throws on a non-2xx bulk response", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })) as unknown as typeof fetch;

    await expect(geocodePostcodesBulk(["SW1A 1AA"])).rejects.toThrow(/postcodes\.io bulk lookup failed \(500\)/);
  });
});
