import { describe, it, expect, vi } from "vitest";

const geocodeAddress = vi.fn();
vi.mock("../../integrations/geocoding/client", async (orig) => ({
  ...(await orig<typeof import("../../integrations/geocoding/client")>()),
  geocodeAddress: (...a: unknown[]) => geocodeAddress(...a),
}));

import { geocodeProperty, addressChanged, GEOCODE_RESET } from "../property-geocoding";
import { hashAddress } from "../../integrations/geocoding/client";

const addr = { addressLine: "1 High St", postcode: "AB1 2CD" };
const tp = () => ({ property: { update: vi.fn().mockResolvedValue({}) } });

describe("addressChanged", () => {
  it("ignores case and whitespace, detects real changes", () => {
    expect(addressChanged(addr, { addressLine: "1  HIGH st", postcode: "ab12cd" })).toBe(false);
    expect(addressChanged(addr, { addressLine: "2 High St", postcode: "AB1 2CD" })).toBe(true);
    expect(addressChanged(addr, { ...addr, postcode: "ZZ1 1ZZ" })).toBe(true);
  });
});

describe("geocodeProperty", () => {
  it("stores coordinates, precision, place id and the address hash for a precise result", async () => {
    geocodeAddress.mockResolvedValue({ result: { latitude: 1, longitude: 2, precision: "ROOFTOP", placeId: "p" }, error: null });
    const t = tp();
    await geocodeProperty(t as never, "prop1", addr);
    expect(geocodeAddress).toHaveBeenCalledWith(addr);
    expect(t.property.update).toHaveBeenCalledWith({
      where: { id: "prop1" },
      data: {
        latitude: 1, longitude: 2, geocodedAt: expect.any(Date), geocodeError: null,
        geocodePrecision: "ROOFTOP", geocodePlaceId: "p", geocodeAddressHash: hashAddress(addr), geocodeAttempts: 0,
      },
    });
  });

  it.each(["POSTCODE_FALLBACK", "APPROXIMATE"])("%s results keep counting attempts", async (precision) => {
    geocodeAddress.mockResolvedValue({ result: { latitude: 1, longitude: 2, precision, placeId: null }, error: null });
    const t = tp();
    await geocodeProperty(t as never, "prop1", addr);
    expect(t.property.update.mock.calls[0][0].data).toMatchObject({ geocodePrecision: precision, geocodeAttempts: { increment: 1 } });
  });

  it("records the error and bumps attempts when nothing was found", async () => {
    geocodeAddress.mockResolvedValue({ result: null, error: "postcode not found" });
    const t = tp();
    await geocodeProperty(t as never, "prop1", addr);
    expect(t.property.update).toHaveBeenCalledWith({
      where: { id: "prop1" },
      data: { geocodeAttempts: { increment: 1 }, geocodeError: "postcode not found" },
    });
  });

  it("GEOCODE_RESET clears every geocode column", () => {
    expect(GEOCODE_RESET).toMatchObject({ latitude: null, geocodePrecision: null, geocodePlaceId: null, geocodeAddressHash: null, geocodeAttempts: 0 });
  });
});
