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
    for (let i = 0; i < 101; i++) {
      getTenantPrismaForSchema(`tenant_${i}`);
    }
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });
});
