import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { findMany: (...args: unknown[]) => tenantFindMany(...args) } },
}));

const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...args: unknown[]) => getTenantPrismaForSchema(...args),
}));

const geocodePostcodesBulk = vi.fn();
vi.mock("../../integrations/geocoding/client", () => ({
  geocodePostcodesBulk: (...args: unknown[]) => geocodePostcodesBulk(...args),
}));

import { runGeocodeBackfill } from "../geocodeBackfill";

type Property = { id: string; postcode: string; geocodeAttempts: number };

function makeTp(properties: Property[]) {
  return {
    property: {
      findMany: vi.fn().mockResolvedValue(properties),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runGeocodeBackfill", () => {
  it("does nothing when there are no tenants", async () => {
    tenantFindMany.mockResolvedValue([]);
    await runGeocodeBackfill();
    expect(getTenantPrismaForSchema).not.toHaveBeenCalled();
  });

  it("queries all tenants (not filtered by GHL connection)", async () => {
    tenantFindMany.mockResolvedValue([]);
    await runGeocodeBackfill();
    expect(tenantFindMany).toHaveBeenCalledWith({ select: { schemaName: true } });
  });

  it("does nothing for a tenant with no pending properties", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp([]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runGeocodeBackfill();

    expect(tp.property.findMany).toHaveBeenCalledWith({
      where: { latitude: null, geocodeAttempts: { lt: 5 } },
      select: { id: true, postcode: true, geocodeAttempts: true },
      take: 500,
    });
    expect(geocodePostcodesBulk).not.toHaveBeenCalled();
    expect(tp.property.update).not.toHaveBeenCalled();
  });

  it("writes latitude/longitude and clears geocodeError on a successful match", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const property: Property = { id: "p1", postcode: "SW1A 1AA", geocodeAttempts: 0 };
    const tp = makeTp([property]);
    getTenantPrismaForSchema.mockReturnValue(tp);
    geocodePostcodesBulk.mockResolvedValue(new Map([["SW1A 1AA", { latitude: 51.5, longitude: -0.14 }]]));

    await runGeocodeBackfill();

    expect(geocodePostcodesBulk).toHaveBeenCalledWith(["SW1A 1AA"]);
    expect(tp.property.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { latitude: 51.5, longitude: -0.14, geocodedAt: expect.any(Date), geocodeError: null },
    });
  });

  it("bumps geocodeAttempts and records geocodeError when a postcode has no match", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const property: Property = { id: "p1", postcode: "ZZ99 9ZZ", geocodeAttempts: 1 };
    const tp = makeTp([property]);
    getTenantPrismaForSchema.mockReturnValue(tp);
    geocodePostcodesBulk.mockResolvedValue(new Map([["ZZ99 9ZZ", null]]));

    await runGeocodeBackfill();

    expect(tp.property.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { geocodeAttempts: 2, geocodeError: "postcode not found" },
    });
  });

  it("logs when a not-found property reaches MAX_ATTEMPTS", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const property: Property = { id: "p1", postcode: "ZZ99 9ZZ", geocodeAttempts: 4 };
    const tp = makeTp([property]);
    getTenantPrismaForSchema.mockReturnValue(tp);
    geocodePostcodesBulk.mockResolvedValue(new Map([["ZZ99 9ZZ", null]]));

    await runGeocodeBackfill();

    expect(tp.property.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { geocodeAttempts: 5, geocodeError: "postcode not found" },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("property p1 dead after 5 attempts: postcode not found")
    );
    errorSpy.mockRestore();
  });

  it("bumps geocodeAttempts for every pending property when the bulk lookup itself fails", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const properties: Property[] = [
      { id: "p1", postcode: "SW1A 1AA", geocodeAttempts: 0 },
      { id: "p2", postcode: "EC1A 1BB", geocodeAttempts: 4 },
    ];
    const tp = makeTp(properties);
    getTenantPrismaForSchema.mockReturnValue(tp);
    geocodePostcodesBulk.mockRejectedValue(new Error("network down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runGeocodeBackfill();

    expect(tp.property.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { geocodeAttempts: 1, geocodeError: "Error: network down" },
    });
    expect(tp.property.update).toHaveBeenCalledWith({
      where: { id: "p2" },
      data: { geocodeAttempts: 5, geocodeError: "Error: network down" },
    });
    errorSpy.mockRestore();
  });

  it("processes multiple tenants independently", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }, { schemaName: "t_2" }]);
    const tp1 = makeTp([{ id: "p1", postcode: "SW1A 1AA", geocodeAttempts: 0 }]);
    const tp2 = makeTp([{ id: "p2", postcode: "EC1A 1BB", geocodeAttempts: 0 }]);
    getTenantPrismaForSchema.mockImplementation((schemaName: string) => (schemaName === "t_1" ? tp1 : tp2));
    geocodePostcodesBulk.mockResolvedValue(new Map());

    await runGeocodeBackfill();

    expect(tp1.property.findMany).toHaveBeenCalledTimes(1);
    expect(tp2.property.findMany).toHaveBeenCalledTimes(1);
  });
});
