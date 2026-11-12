import { beforeEach, describe, expect, it, vi } from "vitest";

// BUG-010: cron jobs used Promise.allSettled over every tenant, creating one Prisma client (3 connections) per
// tenant at once and evicting clients that were still in use. forEachTenant bounds concurrency, and the manager
// never disconnects a client that is in use.

const live = { constructed: 0, disconnected: 0, peakOpen: 0 };
vi.mock("../../generated/tenant-client", () => {
  class FakePrismaClient {
    constructor() {
      live.constructed++;
      live.peakOpen = Math.max(live.peakOpen, live.constructed - live.disconnected);
    }
    async $disconnect() {
      live.disconnected++;
    }
  }
  return { PrismaClient: FakePrismaClient };
});

const schema = (i: number) => `t_${i.toString(16).padStart(20, "0")}`;
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  delete (globalThis as { tenantClientCache?: unknown }).tenantClientCache;
  vi.resetModules();
  live.constructed = 0;
  live.disconnected = 0;
  live.peakOpen = 0;
  process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
  delete process.env.TENANT_JOB_CONCURRENCY;
});

describe("withTenantClient", () => {
  it("does not disconnect an evicted client until its last user is done", async () => {
    const m = await import("../tenant-prisma-manager.js");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = m.withTenantClient(schema(0), async () => {
      await gate;
    });
    for (let i = 1; i <= 20; i++) m.getTenantPrismaForSchema(schema(i)); // evicts schema(0) from the 15-entry LRU
    await tick();
    expect(live.disconnected).toBeGreaterThan(0); // others were disposed...
    const disconnectedBefore = live.disconnected;
    release();
    await running;
    await tick();
    expect(live.disconnected).toBe(disconnectedBefore + 1); // ...and the in-use one only after it finished
  });

  it("passes the cached client, rethrows errors and still releases", async () => {
    const m = await import("../tenant-prisma-manager.js");
    const a = m.getTenantPrismaForSchema(schema(1));
    await expect(m.withTenantClient(schema(1), async (c) => { expect(c).toBe(a); throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(m.withTenantClient(schema(1), async () => 7)).resolves.toBe(7);
  });

  it("two overlapping users of one client keep it alive until both finish", async () => {
    const m = await import("../tenant-prisma-manager.js");
    let r1!: () => void;
    let r2!: () => void;
    const p1 = m.withTenantClient(schema(0), () => new Promise<void>((r) => (r1 = r)));
    const p2 = m.withTenantClient(schema(0), () => new Promise<void>((r) => (r2 = r)));
    for (let i = 1; i <= 20; i++) m.getTenantPrismaForSchema(schema(i));
    await tick();
    const before = live.disconnected;
    r1();
    await p1;
    await tick();
    expect(live.disconnected).toBe(before);
    r2();
    await p2;
    await tick();
    expect(live.disconnected).toBe(before + 1);
  });
});

describe("forEachTenant", () => {
  it("300 tenants: concurrency and open clients stay bounded, every tenant is processed once", async () => {
    const { forEachTenant, TENANT_JOB_CONCURRENCY } = await import("../tenant-jobs.js");
    const tenants = Array.from({ length: 300 }, (_, i) => ({ schemaName: schema(i) }));
    let active = 0;
    let peakActive = 0;
    const seen = new Set<string>();
    const results = await forEachTenant(tenants, async (_tp, t) => {
      active++;
      peakActive = Math.max(peakActive, active);
      seen.add(t.schemaName);
      await tick();
      active--;
      return t.schemaName;
    });
    expect(results).toHaveLength(300);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(seen.size).toBe(300);
    expect(peakActive).toBeLessThanOrEqual(TENANT_JOB_CONCURRENCY);
    expect(live.constructed).toBe(300);
    // LRU cap (15) + clients still finishing when evicted can never exceed concurrency
    expect(live.peakOpen).toBeLessThanOrEqual(15 + TENANT_JOB_CONCURRENCY + 1);
  });

  it("one tenant failing does not stop the others and is reported as rejected", async () => {
    const { forEachTenant } = await import("../tenant-jobs.js");
    const res = await forEachTenant([{ schemaName: schema(1) }, { schemaName: schema(2) }, { schemaName: "not-a-schema" }], async (_tp, t) => {
      if (t.schemaName === schema(1)) throw new Error("tenant 1 failed");
      return "ok";
    });
    expect(res.map((r) => r.status)).toEqual(["rejected", "fulfilled", "rejected"]);
  });

  it("honours an explicit concurrency (and clamps nonsense to 1)", async () => {
    const { forEachTenant } = await import("../tenant-jobs.js");
    let active = 0;
    let peak = 0;
    const run = async (c: number) => {
      peak = 0;
      await forEachTenant(Array.from({ length: 10 }, (_, i) => ({ schemaName: schema(i) })), async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      }, c);
      return peak;
    };
    expect(await run(2)).toBe(2);
    expect(await run(0)).toBe(1);
    expect(await run(Number.NaN)).toBe(1);
  });

  it("TENANT_JOB_CONCURRENCY env overrides the default (1..8)", async () => {
    process.env.TENANT_JOB_CONCURRENCY = "2";
    expect((await import("../tenant-jobs.js")).TENANT_JOB_CONCURRENCY).toBe(2);
    vi.resetModules();
    process.env.TENANT_JOB_CONCURRENCY = "99";
    expect((await import("../tenant-jobs.js")).TENANT_JOB_CONCURRENCY).toBe(8);
    vi.resetModules();
    process.env.TENANT_JOB_CONCURRENCY = "x";
    expect((await import("../tenant-jobs.js")).TENANT_JOB_CONCURRENCY).toBe(4);
  });

  it("an empty tenant list resolves to []", async () => {
    const { forEachTenant } = await import("../tenant-jobs.js");
    expect(await forEachTenant([], async () => 1)).toEqual([]);
  });
});
