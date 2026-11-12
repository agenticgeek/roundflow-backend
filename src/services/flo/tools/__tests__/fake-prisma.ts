import type { TenantPrismaClient } from "../../../../lib/tenant-prisma-manager";
import type { ToolContext } from "../../types";

// A fake tenant Prisma client for Flo tool tests. Reads return a configured value (or an empty default). ANY other
// method, including every write and raw-write, throws, so a tool that tried to change data would fail its test.

export type Handler = unknown | ((args: any) => unknown); // eslint-disable-line @typescript-eslint/no-explicit-any

const READ_DEFAULTS: Record<string, unknown> = {
  findMany: [],
  groupBy: [],
  count: 0,
  findFirst: null,
  findUnique: null,
  aggregate: { _sum: {}, _count: 0 },
};

export const WRITE_METHODS = [
  "create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany",
  "$executeRaw", "$executeRawUnsafe", "$queryRawUnsafe", "$transaction",
] as const;

export interface FakePrisma {
  tp: TenantPrismaClient;
  calls: Array<{ path: string; args: unknown }>;
}

/** handlers: "visit.findMany" -> value or (args) => value. "$queryRaw" is allowed (read-only SQL). */
export function fakePrisma(handlers: Record<string, Handler> = {}, opts: { timezone?: string | null } = {}): FakePrisma {
  const calls: FakePrisma["calls"] = [];
  const settings = opts.timezone === null ? null : { timezone: opts.timezone ?? "Europe/London", currency: "gbp", defaultWorkingDays: [], businessName: "Test Windows" };
  const all: Record<string, Handler> = { "businessSettings.findFirst": settings, ...handlers };

  const run = (path: string, args: unknown[]) => {
    calls.push({ path, args: args[0] });
    const h = all[path];
    if (h === undefined) {
      if (path === "$queryRaw") return Promise.resolve([]);
      const method = path.split(".")[1];
      if (!(method in READ_DEFAULTS)) throw new Error(`Unexpected call to ${path}`);
      return Promise.resolve(READ_DEFAULTS[method]);
    }
    return Promise.resolve(typeof h === "function" ? (h as (a: unknown) => unknown)(args[0]) : h);
  };

  const model = (name: string) =>
    new Proxy({}, {
      get(_t, method: string) {
        if ((WRITE_METHODS as readonly string[]).includes(method)) {
          return () => {
            throw new Error(`WRITE BLOCKED: ${name}.${method}`);
          };
        }
        return (...args: unknown[]) => run(`${name}.${method}`, args);
      },
    });

  const tp = new Proxy({}, {
    get(_t, prop: string) {
      if ((WRITE_METHODS as readonly string[]).includes(prop)) {
        return () => {
          throw new Error(`WRITE BLOCKED: ${prop}`);
        };
      }
      if (prop === "$queryRaw") return () => run("$queryRaw", []);
      if (prop === "then") return undefined;
      return model(prop);
    },
  }) as unknown as TenantPrismaClient;
  return { tp, calls };
}

export function ctxFor(tp: TenantPrismaClient, now = "2026-11-10T09:00:00.000Z"): ToolContext {
  return { scope: "ADMIN", tenantPrisma: tp, profileId: "profile-1", now: new Date(now) };
}

/** Decimal-like value: the code calls Number() / toNumber() on prices. */
export const dec = (n: number) => ({ toNumber: () => n, valueOf: () => n, toString: () => String(n) });
