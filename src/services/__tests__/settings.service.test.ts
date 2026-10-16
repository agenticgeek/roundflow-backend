import { it, expect, vi } from "vitest";
import {
  createSettingsService,
  getCachedBusinessSettings,
  invalidateCachedBusinessSettings,
} from "../settings.service";

function makePrisma() {
  return {
    businessSettings: { findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    service: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    serviceArea: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    technician: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    messageTemplate: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    round: { count: vi.fn() },
    property: { count: vi.fn() },
    profile: { findUnique: vi.fn() },
  } as unknown as Parameters<typeof createSettingsService>[0];
}

it("createSettingsService returns an object", () => {
  expect(createSettingsService(makePrisma(), "schema_ctor_a")).toBeDefined();
});

it("updateRoundSettings is a function", () => {
  expect(typeof createSettingsService(makePrisma(), "schema_ctor_b").updateRoundSettings).toBe("function");
});

it("updateRoundSettings does not write preCleanReminderTimings when omitted", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});
  await createSettingsService(prisma, "schema_round_a").updateRoundSettings({ defaultCycleLength: 28 });
  const written = (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(written.update.preCleanReminderTimings).toBeUndefined();
});

it("updateRoundSettings writes preCleanReminderTimings to the database", async () => {
  const prisma = makePrisma();
  const timings = ["EVENING_BEFORE", "TWO_HOURS_BEFORE"];
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});
  await createSettingsService(prisma, "schema_round_b").updateRoundSettings({
    preCleanReminderTimings: timings,
  });
  const written = (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(written.update.preCleanReminderTimings).toEqual(timings);
});

// ---------------------------------------------------------------------------
// Step 6 — per-tenant BusinessSettings cache
//
// The cache (`settingsCache` inside settings.service.ts) is module-level
// state shared across every test in this file. To avoid one test's cached
// entry bleeding into another, each cache-related test below uses its own
// distinct schemaName (e.g. "schema_cache_hit", "schema_cache_write") rather
// than resetting/mocking the module-level cache — this keeps the tests
// exercising the *real* lru-cache instance (same spirit as
// requireTenantAccess.test.ts's RecordingLRUCache approach) while remaining
// fully isolated from each other.
// ---------------------------------------------------------------------------

it("getSettings: repeated calls within the TTL window hit Prisma only once (cache hit)", async () => {
  const prisma = makePrisma();
  const settings = { id: "s1", businessName: "Acme" };
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(settings);
  const svc = createSettingsService(prisma, "schema_cache_hit");

  const first = await svc.getSettings();
  const second = await svc.getSettings();
  const third = await svc.getSettings();

  expect(first).toEqual(settings);
  expect(second).toEqual(settings);
  expect(third).toEqual(settings);
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(1);
});

it("writeSettings (via updateBusinessProfile): invalidates the cache so the next getSettings() refetches", async () => {
  const prisma = makePrisma();
  const stale = { id: "s1", businessName: "Old Name" };
  const fresh = { id: "s1", businessName: "New Name" };
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(stale)
    .mockResolvedValueOnce(fresh);
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(fresh);
  const svc = createSettingsService(prisma, "schema_cache_write");

  const before = await svc.getSettings();
  expect(before).toEqual(stale);

  await svc.updateBusinessProfile({ businessName: "New Name" });

  const after = await svc.getSettings();
  expect(after).toEqual(fresh);
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(2);
});

it("writeSettings (via updateRoundSettings): also invalidates the cache", async () => {
  const prisma = makePrisma();
  const stale = { id: "s1", defaultCycleLength: 14 };
  const fresh = { id: "s1", defaultCycleLength: 28 };
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(stale)
    .mockResolvedValueOnce(fresh);
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(fresh);
  const svc = createSettingsService(prisma, "schema_cache_write_round");

  await svc.getSettings();
  await svc.updateRoundSettings({ defaultCycleLength: 28 });
  const after = await svc.getSettings();

  expect(after).toEqual(fresh);
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(2);
});

it("cache is keyed per tenant schema: two instances with different schemaNames do not share or invalidate each other's entries", async () => {
  const prismaA = makePrisma();
  const prismaB = makePrisma();
  const settingsA = { id: "a1", businessName: "Tenant A" };
  const settingsB = { id: "b1", businessName: "Tenant B" };
  (prismaA.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(settingsA);
  (prismaB.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(settingsB);
  (prismaA.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ ...settingsA, businessName: "Tenant A Updated" });

  const svcA = createSettingsService(prismaA, "schema_tenant_a");
  const svcB = createSettingsService(prismaB, "schema_tenant_b");

  // Prime both caches.
  await svcA.getSettings();
  await svcB.getSettings();
  expect(prismaA.businessSettings.findFirst).toHaveBeenCalledTimes(1);
  expect(prismaB.businessSettings.findFirst).toHaveBeenCalledTimes(1);

  // A's cache hit does not touch B's underlying client at all.
  await svcA.getSettings();
  expect(prismaA.businessSettings.findFirst).toHaveBeenCalledTimes(1);
  expect(prismaB.businessSettings.findFirst).toHaveBeenCalledTimes(1);

  // A's write invalidates only A's cache entry — B's cached value is untouched.
  await svcA.updateBusinessProfile({ businessName: "Tenant A Updated" });
  const bAfterAWrite = await svcB.getSettings();
  expect(bAfterAWrite).toEqual(settingsB);
  expect(prismaB.businessSettings.findFirst).toHaveBeenCalledTimes(1); // still cached, no refetch
});

it("getSettings: a null (not-yet-set-up) result is never cached — every call hits Prisma again", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  const svc = createSettingsService(prisma, "schema_cache_null");

  const first = await svc.getSettings();
  const second = await svc.getSettings();

  expect(first).toBeNull();
  expect(second).toBeNull();
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(2);
});

// ---------------------------------------------------------------------------
// getCachedBusinessSettings — the WeakMap(prisma instance)-keyed cache used
// by direct call sites (customer.service.ts, invoice.service.ts,
// today.service.ts) that only have a TenantPrismaClient, not a
// SettingsService/schemaName. Each test uses its own `makePrisma()` instance
// as the cache key, so there's no cross-test bleed to guard against here
// (unlike the schema-string-keyed settingsCache above).
// ---------------------------------------------------------------------------

it("getCachedBusinessSettings: repeated calls on the same prisma instance hit Prisma only once", async () => {
  const prisma = makePrisma();
  const settings = { id: "s1", businessName: "Acme" };
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(settings);

  const first = await getCachedBusinessSettings(prisma);
  const second = await getCachedBusinessSettings(prisma);
  const third = await getCachedBusinessSettings(prisma);

  expect(first).toEqual(settings);
  expect(second).toEqual(settings);
  expect(third).toEqual(settings);
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(1);
});

it("getCachedBusinessSettings: different prisma instances do not share a cache entry", async () => {
  const prismaA = makePrisma();
  const prismaB = makePrisma();
  const settingsA = { id: "a", businessName: "A Co" };
  const settingsB = { id: "b", businessName: "B Co" };
  (prismaA.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(settingsA);
  (prismaB.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(settingsB);

  const a = await getCachedBusinessSettings(prismaA);
  const b = await getCachedBusinessSettings(prismaB);

  expect(a).toEqual(settingsA);
  expect(b).toEqual(settingsB);
  expect(prismaA.businessSettings.findFirst).toHaveBeenCalledTimes(1);
  expect(prismaB.businessSettings.findFirst).toHaveBeenCalledTimes(1);
});

it("getCachedBusinessSettings: a null result is never cached", async () => {
  const prisma = makePrisma();
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  const first = await getCachedBusinessSettings(prisma);
  const second = await getCachedBusinessSettings(prisma);

  expect(first).toBeNull();
  expect(second).toBeNull();
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(2);
});

it("getCachedBusinessSettings: a write through SettingsService invalidates the direct cache for that same prisma instance", async () => {
  const prisma = makePrisma();
  const stale = { id: "s1", businessName: "Old Name" };
  const fresh = { id: "s1", businessName: "New Name" };
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(stale);
  (prisma.businessSettings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(fresh);

  const before = await getCachedBusinessSettings(prisma);
  expect(before).toEqual(stale);

  await createSettingsService(prisma, "schema_direct_invalidate").updateBusinessProfile({ businessName: "New Name" });

  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(fresh);
  const after = await getCachedBusinessSettings(prisma);
  expect(after).toEqual(fresh);
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(2);
});

// ---------------------------------------------------------------------------
// Cache unification regression — SettingsService.getSettings() and
// getCachedBusinessSettings() used to be TWO SEPARATE caches (one keyed by
// schema name, one keyed by prisma instance) holding the identical
// BusinessSettings row. A request path that hit both within the same TTL
// window did 2 DB reads instead of 1, since a hit in one was invisible to
// the other. These tests assert they now share the SAME entry — not just
// that each independently caches, and not just that invalidation clears
// both (which could be true even with two separate caches).
// ---------------------------------------------------------------------------

it("getSettings() and getCachedBusinessSettings() on the same prisma instance share one cache entry (priming via getCachedBusinessSettings)", async () => {
  const prisma = makePrisma();
  const settings = { id: "s1", businessName: "Shared" };
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(settings);

  // Prime via the "direct" entry point.
  await getCachedBusinessSettings(prisma);
  // Read via SettingsService on the SAME prisma instance — must be a cache hit.
  const viaService = await createSettingsService(prisma, "schema_unify_a").getSettings();

  expect(viaService).toEqual(settings);
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(1);
});

it("getSettings() and getCachedBusinessSettings() on the same prisma instance share one cache entry (priming via SettingsService)", async () => {
  const prisma = makePrisma();
  const settings = { id: "s1", businessName: "Shared" };
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(settings);

  // Prime via SettingsService.
  await createSettingsService(prisma, "schema_unify_b").getSettings();
  // Read via the "direct" entry point on the SAME prisma instance — must be a cache hit.
  const viaDirect = await getCachedBusinessSettings(prisma);

  expect(viaDirect).toEqual(settings);
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(1);
});

it("invalidateCachedBusinessSettings() forces the next read (through either entry point) to refetch", async () => {
  const prisma = makePrisma();
  const stale = { id: "s1", businessName: "Stale" };
  const fresh = { id: "s1", businessName: "Fresh" };
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(stale);

  await getCachedBusinessSettings(prisma); // warms the cache

  invalidateCachedBusinessSettings(prisma); // simulates a direct write site (e.g. routes/settings.ts) invalidating

  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fresh);
  const result = await createSettingsService(prisma, "schema_unify_c").getSettings();

  expect(result).toEqual(fresh);
  expect(prisma.businessSettings.findFirst).toHaveBeenCalledTimes(2);
});
