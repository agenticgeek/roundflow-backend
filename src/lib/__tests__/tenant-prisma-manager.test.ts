import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const disconnectMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../generated/tenant-client", () => {
  class FakePrismaClient {
    public opts: unknown;
    public $disconnect = disconnectMock;
    constructor(opts: unknown) {
      this.opts = opts;
    }
  }
  return { PrismaClient: FakePrismaClient };
});

describe("getTenantPrismaForSchema", () => {
  beforeEach(() => {
    delete (globalThis as { tenantClientCache?: unknown }).tenantClientCache;
    vi.resetModules();
    disconnectMock.mockClear();
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    delete process.env.DIRECT_URL;
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it("returns the same cached instance for the same schema", async () => {
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const a = getTenantPrismaForSchema("tenant_a");
    const b = getTenantPrismaForSchema("tenant_a");
    expect(a).toBe(b);
  });

  it("returns distinct instances for different schemas", async () => {
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const a = getTenantPrismaForSchema("tenant_a");
    const b = getTenantPrismaForSchema("tenant_b");
    expect(a).not.toBe(b);
  });

  it("reuses the clientCache across module re-evaluation via globalThis", async () => {
    const mod1 = await import("../tenant-prisma-manager.js");
    const first = mod1.getTenantPrismaForSchema("tenant_reload");

    vi.resetModules();
    const mod2 = await import("../tenant-prisma-manager.js");
    const second = mod2.getTenantPrismaForSchema("tenant_reload");

    expect(second).toBe(first);
  });

  it("$disconnects evicted clients once the LRU cap is exceeded", async () => {
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    for (let i = 0; i < 16; i++) {
      getTenantPrismaForSchema(`tenant_${i}`);
    }
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it("prefers DATABASE_URL (pooled) over DIRECT_URL when both are set", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@pooler:6543/db?pgbouncer=true";
    process.env.DIRECT_URL = "postgres://user:pass@direct:5432/db";
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const client = getTenantPrismaForSchema("tenant_pooled") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    expect(client.opts.datasources.db.url).toContain("pooler:6543");
    expect(client.opts.datasources.db.url).not.toContain("direct:5432");
  });

  it("falls back to DIRECT_URL when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    process.env.DIRECT_URL = "postgres://user:pass@direct:5432/db";
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const client = getTenantPrismaForSchema("tenant_direct") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    expect(client.opts.datasources.db.url).toContain("direct:5432");
  });

  it("appends connection_limit/pool_timeout/schema with '?' when the base URL has no query string", async () => {
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const client = getTenantPrismaForSchema("tenant_plain") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    const url = client.opts.datasources.db.url;
    expect(url).toBe(
      "postgres://user:pass@localhost:5432/db?connection_limit=3&pool_timeout=10&schema=tenant_plain",
    );
  });

  it("appends connection_limit/pool_timeout/schema with '&' when the base URL already has a query string", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@pooler:6543/db?pgbouncer=true";
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const client = getTenantPrismaForSchema("tenant_query") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    const url = client.opts.datasources.db.url;
    expect(url).toBe(
      "postgres://user:pass@pooler:6543/db?pgbouncer=true&connection_limit=3&pool_timeout=10&schema=tenant_query",
    );
  });
});
