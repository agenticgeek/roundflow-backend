import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: (...a: unknown[]) => tenantFindMany(...a) } } }));
const clients: Record<string, unknown> = {};
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (s: string) => clients[s],
  withTenantClient: (s: string, fn: (c: unknown) => Promise<unknown>) => Promise.resolve().then(() => fn(clients[s])),
}));

import { purgeFloConversations, runFloPurge } from "../floPurge";

const mkTp = (impl: () => Promise<{ count: number }>) => ({ floConversation: { deleteMany: vi.fn(impl) } });

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(clients)) delete clients[k];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("purgeFloConversations", () => {
  it("deletes conversations last updated before the cutoff and reports the count", async () => {
    const tp = mkTp(async () => ({ count: 4 }));
    const cutoff = new Date("2026-08-12T00:00:00Z");
    await expect(purgeFloConversations(tp as never, cutoff)).resolves.toBe(4);
    expect(tp.floConversation.deleteMany).toHaveBeenCalledWith({ where: { updatedAt: { lt: cutoff } } });
  });
});

describe("runFloPurge", () => {
  const now = new Date("2026-11-10T03:00:00Z");

  it("purges every tenant with a 90-day cutoff by default (retention boundary)", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t1" }, { schemaName: "t2" }]);
    const a = mkTp(async () => ({ count: 2 }));
    const b = mkTp(async () => ({ count: 5 }));
    clients.t1 = a;
    clients.t2 = b;
    expect(await runFloPurge(now, {} as NodeJS.ProcessEnv)).toEqual({ deleted: 7, failedTenants: 0 });
    // 90 days before 2026-11-10T03:00Z is 2026-08-12T03:00Z: a conversation updated exactly then is kept (lt, not lte).
    const cutoff = new Date("2026-08-12T03:00:00.000Z");
    expect(a.floConversation.deleteMany).toHaveBeenCalledWith({ where: { updatedAt: { lt: cutoff } } });
    expect(b.floConversation.deleteMany).toHaveBeenCalledWith({ where: { updatedAt: { lt: cutoff } } });
  });

  it("honours FLO_RETENTION_DAYS", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t1" }]);
    const a = mkTp(async () => ({ count: 0 }));
    clients.t1 = a;
    await runFloPurge(now, { FLO_RETENTION_DAYS: "30" } as unknown as NodeJS.ProcessEnv);
    expect(a.floConversation.deleteMany).toHaveBeenCalledWith({ where: { updatedAt: { lt: new Date("2026-10-11T03:00:00.000Z") } } });
  });

  it("one tenant failing does not stop the rest, and nothing sensitive is logged", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t1" }, { schemaName: "t2" }, { schemaName: "t3" }]);
    clients.t1 = mkTp(async () => ({ count: 1 }));
    clients.t2 = mkTp(async () => {
      throw new Error("boom password=hunter2");
    });
    clients.t3 = mkTp(async () => ({ count: 3 }));
    expect(await runFloPurge(now)).toEqual({ deleted: 4, failedTenants: 1 });
    expect(console.error).toHaveBeenCalledWith("[floPurge] tenant failed:", "Error");
  });

  it("logs 'unknown' for a non-Error rejection and handles zero tenants", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t1" }]);
    clients.t1 = mkTp(async () => {
      throw "plain string";
    });
    expect(await runFloPurge()).toEqual({ deleted: 0, failedTenants: 1 });
    expect(console.error).toHaveBeenCalledWith("[floPurge] tenant failed:", "unknown");
    tenantFindMany.mockResolvedValue([]);
    expect(await runFloPurge()).toEqual({ deleted: 0, failedTenants: 0 });
  });
});
