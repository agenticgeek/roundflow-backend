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
    const a = getTenantPrismaForSchema("t_aaaaaaaaaaaaaaaaaaaa");
    const b = getTenantPrismaForSchema("t_aaaaaaaaaaaaaaaaaaaa");
    expect(a).toBe(b);
  });

  it("returns distinct instances for different schemas", async () => {
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const a = getTenantPrismaForSchema("t_aaaaaaaaaaaaaaaaaaaa");
    const b = getTenantPrismaForSchema("t_bbbbbbbbbbbbbbbbbbbb");
    expect(a).not.toBe(b);
  });

  it("reuses the clientCache across module re-evaluation via globalThis", async () => {
    const mod1 = await import("../tenant-prisma-manager.js");
    const first = mod1.getTenantPrismaForSchema("t_00000000000000000001");

    vi.resetModules();
    const mod2 = await import("../tenant-prisma-manager.js");
    const second = mod2.getTenantPrismaForSchema("t_00000000000000000001");

    expect(second).toBe(first);
  });

  it("$disconnects evicted clients once the LRU cap is exceeded", async () => {
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    for (let i = 0; i < 16; i++) {
      getTenantPrismaForSchema(`t_${String(i).padStart(20, "0")}`);
    }
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it("prefers DATABASE_URL (pooled) over DIRECT_URL when both are set", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@pooler:6543/db?pgbouncer=true";
    process.env.DIRECT_URL = "postgres://user:pass@direct:5432/db";
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const client = getTenantPrismaForSchema("t_00000000000000000002") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    expect(client.opts.datasources.db.url).toContain("pooler:6543");
    expect(client.opts.datasources.db.url).not.toContain("direct:5432");
  });

  it("falls back to DIRECT_URL when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    process.env.DIRECT_URL = "postgres://user:pass@direct:5432/db";
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const client = getTenantPrismaForSchema("t_00000000000000000003") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    expect(client.opts.datasources.db.url).toContain("direct:5432");
  });

  it("appends connection_limit/pool_timeout/schema with '?' when the base URL has no query string", async () => {
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const client = getTenantPrismaForSchema("t_00000000000000000004") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    const url = client.opts.datasources.db.url;
    expect(url).toBe(
      "postgres://user:pass@localhost:5432/db?connection_limit=3&pool_timeout=10&schema=t_00000000000000000004",
    );
  });

  it("appends connection_limit/pool_timeout/schema with '&' when the base URL already has a query string", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@pooler:6543/db?pgbouncer=true";
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    const client = getTenantPrismaForSchema("t_00000000000000000005") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    const url = client.opts.datasources.db.url;
    expect(url).toBe(
      "postgres://user:pass@pooler:6543/db?pgbouncer=true&connection_limit=3&pool_timeout=10&schema=t_00000000000000000005",
    );
  });
});

describe("getSchemaNameForClient", () => {
  beforeEach(() => {
    delete (globalThis as { tenantClientCache?: unknown }).tenantClientCache;
    delete (globalThis as { tenantSchemaByClient?: unknown }).tenantSchemaByClient;
    vi.resetModules();
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
  });

  it("maps a client back to its schema name, undefined for unknown objects", async () => {
    const { getTenantPrismaForSchema, getSchemaNameForClient } = await import("../tenant-prisma-manager.js");
    const client = getTenantPrismaForSchema("t_abcabcabcabcabcabcab");
    expect(getSchemaNameForClient(client)).toBe("t_abcabcabcabcabcabcab");
    expect(getSchemaNameForClient({})).toBeUndefined();
  });
});

describe("LRU eviction when $disconnect fails", () => {
  it("swallows the rejection of an evicted client's $disconnect", async () => {
    delete (globalThis as { tenantClientCache?: unknown }).tenantClientCache;
    vi.resetModules();
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    disconnectMock.mockReset();
    disconnectMock.mockRejectedValue(new Error("already closed"));
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    for (let i = 0; i < 16; i++) getTenantPrismaForSchema(`t_${String(i).padStart(20, "0")}`);
    await new Promise((r) => setImmediate(r));
    expect(disconnectMock).toHaveBeenCalledTimes(1);
    disconnectMock.mockReset();
    disconnectMock.mockResolvedValue(undefined);
  });
});

describe("schema-name guard + shutdown (BE-19 / BE-09)", () => {
  beforeEach(() => {
    delete (globalThis as { tenantClientCache?: unknown }).tenantClientCache;
    vi.resetModules();
    disconnectMock.mockClear();
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
  });

  it("refuses a schema name that is not t_<20 hex> before building the URL", async () => {
    const { getTenantPrismaForSchema } = await import("../tenant-prisma-manager.js");
    expect(() => getTenantPrismaForSchema("public&sslmode=disable")).toThrow("Invalid tenant schema name");
  });

  it("disconnectAllTenantClients closes every cached client and tolerates a failing one", async () => {
    const { getTenantPrismaForSchema, disconnectAllTenantClients } = await import("../tenant-prisma-manager.js");
    getTenantPrismaForSchema("t_00000000000000000001");
    getTenantPrismaForSchema("t_00000000000000000002");
    disconnectMock.mockClear();
    disconnectMock.mockRejectedValueOnce(new Error("already closed"));
    await expect(disconnectAllTenantClients()).resolves.toBeUndefined();
    expect(disconnectMock).toHaveBeenCalledTimes(2);
  });
});

describe("production mode", () => {
  it("does not stash the client cache on globalThis (no hot reload in production)", async () => {
    delete (globalThis as { tenantClientCache?: unknown }).tenantClientCache;
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    try {
      await import("../tenant-prisma-manager.js");
      expect((globalThis as { tenantClientCache?: unknown }).tenantClientCache).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
