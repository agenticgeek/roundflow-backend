import { it, expect, vi, beforeEach } from "vitest";

const { findMany, getTenant, purge } = vi.hoisted(() => ({
  findMany: vi.fn(),
  getTenant: vi.fn((s: string) => ({ schema: s })),
  purge: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany } } }));
vi.mock("../../lib/tenant-prisma-manager", () => ({ getTenantPrismaForSchema: getTenant }));
vi.mock("../../mobile/idempotency", () => ({ IDEMPOTENCY_TTL_DAYS: 7, purgeIdempotencyRecords: purge }));

import { runIdempotencyPurge } from "../idempotencyPurge";

beforeEach(() => vi.clearAllMocks());

it("purges every tenant with a 7-day cutoff and survives a tenant failure", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  findMany.mockResolvedValue([{ schemaName: "t1" }, { schemaName: "t2" }, { schemaName: "t3" }]);
  purge.mockResolvedValueOnce(2).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(3);
  const now = new Date("2026-10-30T00:00:00.000Z");

  expect(await runIdempotencyPurge(now)).toEqual({ deleted: 5 });
  expect(purge).toHaveBeenCalledWith({ schema: "t1" }, new Date("2026-10-23T00:00:00.000Z"));
  expect(err).toHaveBeenCalledWith("[idempotencyPurge] tenant t2 failed:", expect.any(Error));
  err.mockRestore();
});

it("defaults now to the current time", async () => {
  findMany.mockResolvedValue([]);
  expect(await runIdempotencyPurge()).toEqual({ deleted: 0 });
});
