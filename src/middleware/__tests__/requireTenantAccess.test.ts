import { it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const findUnique = vi.fn();
const lruCtorCalls: unknown[] = [];

vi.mock("../../lib/prisma", () => ({
  prisma: { profile: { findUnique } },
}));
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: vi.fn(() => ({ marker: "tenant-prisma" })),
}));
// Records the options the middleware constructs its LRUCache with, while
// delegating to the real implementation so cache-hit/negative-cache/
// isolation behavior below is exercised against real cache semantics.
vi.mock("lru-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lru-cache")>();
  class RecordingLRUCache<K extends {}, V extends {}> extends actual.LRUCache<K, V> {
    constructor(options: ConstructorParameters<typeof actual.LRUCache<K, V>>[0]) {
      lruCtorCalls.push(options);
      super(options);
    }
  }
  return { ...actual, LRUCache: RecordingLRUCache };
});

function makeReq(supabaseUserId: string): Request {
  return { user: { supabaseUserId, email: "x@example.com" } } as unknown as Request;
}

function makeRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

// requireTenantAccess keeps its profile cache as module-level state, so each
// test re-imports the module fresh (vi.resetModules) to avoid leaking a
// cached profile across test cases.
async function freshMiddleware() {
  const mod = await import("../requireTenantAccess.js");
  return mod.requireTenantAccess;
}

beforeEach(() => {
  vi.resetModules();
  findUnique.mockReset();
  lruCtorCalls.length = 0;
});

const PROFILE = { supabaseUserId: "user1", role: "ADMIN", tenant: { schemaName: "t_abc" } };

it("cache hit: two requests for the same user hit the DB only once", async () => {
  findUnique.mockResolvedValue(PROFILE);
  const requireTenantAccess = await freshMiddleware();

  const next1 = vi.fn();
  await requireTenantAccess(makeReq("user1"), makeRes(), next1 as NextFunction);
  const next2 = vi.fn();
  await requireTenantAccess(makeReq("user1"), makeRes(), next2 as NextFunction);

  expect(next1).toHaveBeenCalledTimes(1);
  expect(next2).toHaveBeenCalledTimes(1);
  expect(findUnique).toHaveBeenCalledTimes(1);
});

it("negative-cache guard: a 403 (no profile) is never cached — a profile created afterwards is seen immediately", async () => {
  findUnique.mockResolvedValueOnce(null); // first call: no profile yet
  const requireTenantAccess = await freshMiddleware();

  const res1 = makeRes();
  await requireTenantAccess(makeReq("user1"), res1, vi.fn() as unknown as NextFunction);
  expect(res1.status).toHaveBeenCalledWith(403);

  // Profile now exists (e.g. signup completed on another ECS task).
  findUnique.mockResolvedValueOnce(PROFILE);
  const next2 = vi.fn();
  const res2 = makeRes();
  await requireTenantAccess(makeReq("user1"), res2, next2 as NextFunction);

  expect(res2.status).not.toHaveBeenCalledWith(403);
  expect(next2).toHaveBeenCalledTimes(1);
  // Both calls hit the DB — the 403 result must never have been cached.
  expect(findUnique).toHaveBeenCalledTimes(2);
});

it("per-key cache isolation: a cached profile for one user is never served to another", async () => {
  findUnique.mockImplementation(({ where }: { where: { supabaseUserId: string } }) =>
    Promise.resolve(
      where.supabaseUserId === "user1"
        ? PROFILE
        : { supabaseUserId: "user2", role: "TECHNICIAN", tenant: { schemaName: "t_xyz" } }
    )
  );
  const requireTenantAccess = await freshMiddleware();

  const req1 = makeReq("user1");
  await requireTenantAccess(req1, makeRes(), vi.fn() as unknown as NextFunction);
  const req2 = makeReq("user2");
  await requireTenantAccess(req2, makeRes(), vi.fn() as unknown as NextFunction);

  expect(req1.profile).toMatchObject({ supabaseUserId: "user1" });
  expect(req2.profile).toMatchObject({ supabaseUserId: "user2" });
  expect(findUnique).toHaveBeenCalledTimes(2);
});

// TTL behavior itself is lru-cache's responsibility (well-tested upstream);
// what this middleware must get right is the *configuration* — a short,
// bounded staleness window, per the ECS-safety requirement that a role
// change can't stay stale indefinitely on a given task. Simulating real
// time passage against lru-cache's internal performance.now()-based clock
// under vitest's fake timers is unreliable (the debounced clock does not
// reliably advance), so this asserts the configured value directly instead.
it("profile cache TTL is configured to 30s, bounding role-change staleness", async () => {
  await freshMiddleware();

  expect(lruCtorCalls).toHaveLength(1);
  expect(lruCtorCalls[0]).toMatchObject({ ttl: 30_000 });
});
