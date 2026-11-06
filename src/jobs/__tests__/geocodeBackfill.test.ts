import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { findMany: (...args: unknown[]) => tenantFindMany(...args) } },
}));

const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...args: unknown[]) => getTenantPrismaForSchema(...args),
}));

const geocodeProperty = vi.fn();
vi.mock("../../services/property-geocoding", () => ({
  geocodeProperty: (...args: unknown[]) => geocodeProperty(...args),
}));

const isConfigured = vi.fn();
const quotaRemaining = vi.fn();
vi.mock("../../integrations/geocoding/client", () => ({
  isGoogleGeocodingConfigured: () => isConfigured(),
  geocodeQuotaRemaining: () => quotaRemaining(),
}));

import { runGeocodeBackfill } from "../geocodeBackfill";
import { parseGeocodeCliArgs } from "../geocodeBackfillCli";

type Row = { id: string; addressLine: string; postcode: string };
const row = (id: string): Row => ({ id, addressLine: `${id} Street`, postcode: "AB1 2CD" });

// findMany returns the given pages in order, then [].
function makeTp(pages: Row[][]) {
  const findMany = vi.fn();
  pages.forEach((p) => findMany.mockResolvedValueOnce(p));
  findMany.mockResolvedValue([]);
  return { property: { findMany } };
}

beforeEach(() => {
  vi.clearAllMocks();
  isConfigured.mockReturnValue(true);
  quotaRemaining.mockReturnValue(1000);
  geocodeProperty.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runGeocodeBackfill", () => {
  it("does nothing when there are no tenants", async () => {
    tenantFindMany.mockResolvedValue([]);
    const s = await runGeocodeBackfill();
    expect(s).toMatchObject({ tenants: 0, scanned: 0, geocoded: 0, dryRun: false });
    expect(getTenantPrismaForSchema).not.toHaveBeenCalled();
    expect(tenantFindMany).toHaveBeenCalledWith({ select: { schemaName: true } });
  });

  it("with the Google key selects null/fallback/approximate precision or missing hash, default 200 per run", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp([]);
    getTenantPrismaForSchema.mockReturnValue(tp);
    await runGeocodeBackfill();
    expect(tp.property.findMany).toHaveBeenCalledWith({
      where: {
        geocodeAttempts: { lt: 5 },
        OR: [{ geocodePrecision: null }, { geocodePrecision: { in: ["POSTCODE_FALLBACK", "APPROXIMATE"] } }, { geocodeAddressHash: null }],
      },
      select: { id: true, addressLine: true, postcode: true },
      orderBy: { id: "asc" },
      take: 50,
    });
    expect(geocodeProperty).not.toHaveBeenCalled();
  });

  it("without the key keeps the old behaviour: only properties with no coordinates", async () => {
    isConfigured.mockReturnValue(false);
    quotaRemaining.mockReturnValue(0); // quota is irrelevant without Google
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp([[row("p1")]]);
    getTenantPrismaForSchema.mockReturnValue(tp);
    const s = await runGeocodeBackfill();
    expect(tp.property.findMany.mock.calls[0][0].where).toEqual({ latitude: null, geocodeAttempts: { lt: 5 } });
    expect(geocodeProperty).toHaveBeenCalledWith(tp, "p1", { addressLine: "p1 Street", postcode: "AB1 2CD" });
    expect(s.geocoded).toBe(1);
  });

  it("geocodes each pending property with its full address and pages with a cursor", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp([[row("p1"), row("p2")], [row("p3")]]);
    getTenantPrismaForSchema.mockReturnValue(tp);
    const s = await runGeocodeBackfill();
    expect(geocodeProperty).toHaveBeenCalledTimes(3);
    expect(tp.property.findMany.mock.calls[1][0].where.id).toEqual({ gt: "p2" });
    expect(s).toMatchObject({ tenants: 1, scanned: 3, geocoded: 3, quotaExhausted: false });
  });

  it("dry run counts candidates but never geocodes or writes", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp([[row("p1"), row("p2")]]);
    getTenantPrismaForSchema.mockReturnValue(tp);
    const s = await runGeocodeBackfill({ dryRun: true });
    expect(geocodeProperty).not.toHaveBeenCalled();
    expect(s).toMatchObject({ scanned: 2, geocoded: 0, dryRun: true });
  });

  it("stops at the per-run limit across tenants and shrinks the batch", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }, { schemaName: "t_2" }]);
    const tp1 = makeTp([[row("a"), row("b")]]);
    const tp2 = makeTp([[row("c")]]);
    getTenantPrismaForSchema.mockImplementation((n: string) => (n === "t_1" ? tp1 : tp2));
    const s = await runGeocodeBackfill({ limit: 2 });
    expect(tp1.property.findMany.mock.calls[0][0].take).toBe(2);
    expect(tp2.property.findMany).not.toHaveBeenCalled();
    expect(s).toMatchObject({ tenants: 1, scanned: 2 });
  });

  it("stops when the daily quota is spent", async () => {
    quotaRemaining.mockReturnValueOnce(1).mockReturnValue(0);
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }, { schemaName: "t_2" }]);
    const tp1 = makeTp([[row("a"), row("b")]]);
    getTenantPrismaForSchema.mockReturnValue(tp1);
    const s = await runGeocodeBackfill();
    expect(geocodeProperty).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ scanned: 1, geocoded: 1, quotaExhausted: true, tenants: 1 });
  });

  it("isolates a failing tenant and a failing property update", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }, { schemaName: "t_2" }]);
    const bad = { property: { findMany: vi.fn().mockRejectedValue(new Error("db down")) } };
    const ok = makeTp([[row("p1")]]);
    getTenantPrismaForSchema.mockImplementation((n: string) => (n === "t_1" ? bad : ok));
    geocodeProperty.mockRejectedValue(new Error("update failed"));
    const s = await runGeocodeBackfill();
    expect(s).toMatchObject({ tenants: 2, failedTenants: 1, scanned: 1, geocoded: 0 });
  });
});

describe("parseGeocodeCliArgs", () => {
  it("reads --dry-run and --limit, defaulting to 200", () => {
    expect(parseGeocodeCliArgs([])).toEqual({ dryRun: false, limit: 200 });
    expect(parseGeocodeCliArgs(["--dry-run", "--limit=50"])).toEqual({ dryRun: true, limit: 50 });
    expect(parseGeocodeCliArgs(["--limit=abc"]).limit).toBe(200);
    expect(parseGeocodeCliArgs(["--limit=0"]).limit).toBe(200);
  });
});
