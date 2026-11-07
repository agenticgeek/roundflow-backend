import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

// BE-01 role matrix: every OpenAPI operation x ADMIN / MANAGER / TECHNICIAN / anonymous, against the REAL app
// (real routers, real requireRole / requireTechnician / ADMIN-only guards). Only authentication, the tenant lookup
// and the databases are faked. A route that is not in ROLE_MATRIX fails the first test.

const rowProxy = (): Record<string, unknown> => ({ id: "x", profileId: "p-x", active: true, status: "ACTIVE" });
function modelProxy(): unknown {
  return new Proxy(
    {},
    {
      get: (_t, method: string) => {
        if (method === "then") return undefined;
        return async () => {
          if (method === "findMany" || method === "groupBy") return [];
          if (method === "count") return 0;
          if (method === "aggregate") return { _sum: {}, _count: 0 };
          return rowProxy();
        };
      },
    }
  );
}
function clientProxy(): unknown {
  const models = new Map<string, unknown>();
  const client: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === "then") return undefined;
        if (prop === "$transaction") return async (arg: unknown) => (typeof arg === "function" ? (arg as (c: unknown) => unknown)(client) : Promise.all(arg as unknown[]));
        if (prop.startsWith("$")) return async () => [];
        if (!models.has(prop)) models.set(prop, modelProxy());
        return models.get(prop);
      },
    }
  );
  return client;
}

const roleOf = (req: { headers: Record<string, string | string[] | undefined> }) => String(req.headers["x-test-role"] ?? "");

vi.mock("../middleware/requireAuth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!roleOf(req)) return res.status(401).json({ error: "Unauthorized" });
    req.user = { supabaseUserId: "sb-1", email: "u@example.com" };
    next();
  },
}));
vi.mock("../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: "p-x", tenantId: "tenant-1", role: roleOf(req), name: "U" };
    req.tenantSchemaName = "t_0123456789abcdef0123";
    req.tenantPrisma = (globalThis as any).__matrixClient;
    next();
  },
}));
vi.mock("../lib/prisma", () => ({ prisma: (globalThis as any).__matrixClient ?? new Proxy({}, { get: (_t, p) => (globalThis as any).__matrixClient?.[p as string] }) }));
vi.mock("../lib/tenant-prisma-manager", async (orig) => ({
  ...((await orig()) as object),
  getTenantPrismaForSchema: () => (globalThis as any).__matrixClient,
}));

import { createApp } from "../server/bootstrap";
import { openApiDocument } from "../swagger";
import { ADMIN_ONLY_ROUTES } from "../lib/permissions";
import { NOT_SERVED, ROLE_MATRIX, type AccessClass } from "./role-matrix.data";

const HTTP = ["get", "post", "put", "patch", "delete"];
const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;
const operations = Object.entries(paths).flatMap(([p, item]) =>
  Object.keys(item)
    .filter((m) => HTTP.includes(m))
    .map((m) => ({ key: `${m.toUpperCase()} ${p}`, method: m, path: p }))
    .filter((o) => !NOT_SERVED.has(o.key))
);

const ROLES = ["ADMIN", "MANAGER", "TECHNICIAN"] as const;
function allowed(cls: AccessClass, role: (typeof ROLES)[number]): boolean {
  switch (cls) {
    case "PUBLIC":
    case "AUTHENTICATED":
    case "TENANT_MEMBER":
      return true;
    case "BUSINESS":
      return role === "ADMIN" || role === "MANAGER";
    case "ADMIN":
      return role === "ADMIN";
    case "TECHNICIAN":
      return role === "TECHNICIAN";
  }
}

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  (globalThis as any).__matrixClient = clientProxy();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", () => Promise.reject(new Error("network disabled in the role matrix test")));
  app = createApp({
    allowedOrigins: [],
    readiness: { ready: true },
    env: { RATE_LIMIT_DISABLED: "true" },
    pingDb: async () => 1,
  });
});

async function call(method: string, path: string, role?: string) {
  const url = path.replace(/\{[^}]+\}/g, "sample-id");
  let r = (request(app) as any)[method](url);
  if (role) r = r.set("x-test-role", role);
  if (method !== "get") r = r.send({});
  return r as Promise<{ status: number; body: any }>;
}

// An allowed role may still get a handler-level 4xx/5xx from the fake data; what it must NOT get is an access denial.
const isRoleDenial = (res: { status: number; body: any }) =>
  res.status === 403 &&
  (res.body?.error === "Insufficient permissions" || ["ADMIN_ONLY", "TECHNICIAN_ONLY"].includes(res.body?.code));
const isAccessDenial = (res: { status: number; body: any }) => res.status === 401 || isRoleDenial(res);
describe("role matrix (BE-01)", () => {
  it("has an explicit entry for every OpenAPI operation, and no stale entries", () => {
    const keys = new Set(operations.map((o) => o.key));
    expect(operations.filter((o) => !(o.key in ROLE_MATRIX)).map((o) => o.key)).toEqual([]);
    expect(Object.keys(ROLE_MATRIX).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("the ADMIN class is exactly ADMIN_ONLY_ROUTES", () => {
    const fromTable = Object.entries(ROLE_MATRIX)
      .filter(([, c]) => c === "ADMIN")
      .map(([k]) => k.replace(/\{[^}]+\}/g, ":id"))
      .sort();
    expect(fromTable).toEqual(ADMIN_ONLY_ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  });

  it.each(operations.map((o) => [o.key, o] as const))("%s", async (_key, op) => {
    const cls = ROLE_MATRIX[op.key];
    const failures: string[] = [];

    const anon = await call(op.method, op.path);
    if (cls === "PUBLIC") {
      // Webhooks answer 401 for a missing provider secret; the point is that no ROLE guard stands in the way.
      if (isRoleDenial(anon)) failures.push(`anonymous denied (${anon.status})`);
    } else if (anon.status !== 401) {
      failures.push(`anonymous expected 401, got ${anon.status}`);
    }

    for (const role of ROLES) {
      const res = await call(op.method, op.path, role);
      if (allowed(cls, role)) {
        if (cls === "PUBLIC" ? isRoleDenial(res) : isAccessDenial(res)) failures.push(`${role} expected to pass the access guard, got ${res.status} ${JSON.stringify(res.body)}`);
      } else if (res.status !== 403) {
        failures.push(`${role} expected 403, got ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  }, 20_000);

  it("a MANAGER cannot invite an ADMIN (conditional row of POST /invites) but can invite other roles", async () => {
    const send = (role: string, invitee: string) =>
      (request(app) as any).post("/invites").set("x-test-role", role).send({ email: "new@example.com", role: invitee }) as Promise<{ status: number; body: any }>;
    const denied = await send("MANAGER", "ADMIN");
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("ADMIN_ONLY");
    expect(isAccessDenial(await send("MANAGER", "MANAGER"))).toBe(false);
    expect((await send("ADMIN", "ADMIN")).body.code).not.toBe("ADMIN_ONLY");
  });
});
