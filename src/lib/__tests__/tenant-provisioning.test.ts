import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pg is mocked: no connection is ever opened. `rules` decides each query's rows.
type Rule = (sql: string, params?: unknown[]) => { rows: unknown[] } | undefined;
const state = vi.hoisted(() => ({ queries: [] as string[], rule: undefined as unknown, connects: 0, ends: 0 }));

vi.mock("pg", () => ({
  Client: class {
    async connect() {
      state.connects++;
    }
    async end() {
      state.ends++;
    }
    async query(sql: string, params?: unknown[]) {
      state.queries.push(sql);
      const out = (state.rule as Rule)(sql, params);
      if (out === undefined) return { rows: [] };
      return out;
    }
  },
}));

import fsDefault from "fs";
import { migrateAllTenantSchemas, provisionTenantSchema } from "../tenant-provisioning";

const A = "t_aaaaaaaaaaaaaaaaaaaa";
const B = "t_bbbbbbbbbbbbbbbbbbbb";

beforeEach(() => {
  // Deterministic migration source regardless of a local ./dist build: default to prisma/tenant/migrations.
  const realExists = fsDefault.existsSync.bind(fsDefault);
  vi.spyOn(fsDefault, "existsSync").mockImplementation((p) => (String(p).includes("dist") ? false : realExists(p)));
  state.queries = [];
  state.connects = 0;
  state.ends = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("provisionTenantSchema", () => {
  it("returns immediately when BusinessSettings already exists", async () => {
    state.rule = (sql: string) => (sql.includes("information_schema.tables") ? { rows: [{ exists: true }] } : undefined);
    await provisionTenantSchema(A);
    expect(state.queries.some((q) => q.startsWith("CREATE SCHEMA"))).toBe(false);
  });

  it("refuses a half-provisioned schema", async () => {
    state.rule = (sql: string) =>
      sql.includes("SELECT EXISTS") ? { rows: [{ exists: false }] } : sql.includes("COUNT(*)") ? { rows: [{ count: "3" }] } : undefined;
    await expect(provisionTenantSchema(A)).rejects.toThrow(/not fully provisioned/);
  });

  it("creates the schema and applies every migration inside a transaction each", async () => {
    state.rule = (sql: string) =>
      sql.includes("SELECT EXISTS") ? { rows: [{ exists: false }] } : sql.includes("COUNT(*)") ? { rows: [{ count: "0" }] } : undefined;
    await provisionTenantSchema(A);
    expect(state.queries).toContain(`CREATE SCHEMA "${A}"`);
    expect(state.queries).toContain(`SET LOCAL search_path TO "${A}"`);
    expect(state.queries.filter((q) => q === "COMMIT").length).toBeGreaterThan(10);
  });

  it("rolls back and rethrows when a migration fails", async () => {
    state.rule = (sql: string) => {
      if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: false }] };
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
      if (sql.includes("CREATE TYPE") || sql.includes("CREATE TABLE \"")) throw new Error("boom");
      return undefined;
    };
    await expect(provisionTenantSchema(A)).rejects.toThrow("boom");
    expect(state.queries).toContain("ROLLBACK");
  });

  it("rejects an invalid schema name before touching SQL", async () => {
    state.rule = () => undefined;
    await expect(provisionTenantSchema('x"; DROP SCHEMA public; --')).rejects.toThrow("Invalid tenant schema name");
    expect(state.queries.some((q) => q.includes("DROP SCHEMA"))).toBe(false);
  });
});

describe("migrateAllTenantSchemas", () => {
  const listRule = (schemas: string[], extra: Rule): Rule => (sql, params) => {
    if (sql.includes('FROM public."Tenant"')) return { rows: schemas.map((schemaName) => ({ schemaName })) };
    return extra(sql, params);
  };

  it("reports no failures when there are no tenants", async () => {
    state.rule = listRule([], () => undefined);
    await expect(migrateAllTenantSchemas()).resolves.toEqual({ failed: [] });
  });

  it("baselines a tenant without tracking, skips an up-to-date one and lists the failing one", async () => {
    state.rule = listRule([A, B, "t_cccccccccccccccccccc"], (sql: string, params?: unknown[]) => {
      const forSchema = (n: string) => sql.includes(n) || (params ?? []).includes(n);
      if (sql.includes("information_schema.tables") && sql.includes("SELECT EXISTS")) {
        // A has no _migrations table; B and C do.
        return { rows: [{ exists: (params as string[])[0] !== A } ] };
      }
      if (sql.startsWith("SELECT name FROM") && forSchema(B)) {
        return { rows: ((): { name: string }[] => {
          // everything applied: ask the migrations dir via the INSERT-free path
          return [{ name: "__ALL__" }];
        })() };
      }
      return undefined;
    });
    // Tenant A is baselined; B reports one unknown applied name, so every real migration is "pending" and the
    // first applyMigration for B fails -> B is listed. C (no rows) also applies migrations successfully? Force fail.
    let failFor: string | undefined = B;
    const base = state.rule as Rule;
    state.rule = (sql: string, params?: unknown[]) => {
      if (sql.startsWith("SET LOCAL search_path") && failFor && sql.includes(failFor)) throw new Error("migration failed");
      return base(sql, params);
    };
    const result = await migrateAllTenantSchemas();
    expect(result.failed).toContain(B);
    expect(result.failed).not.toContain(A);
    expect(state.queries.some((q) => q.includes('"_migrations"') && q.includes("ON CONFLICT"))).toBe(true);
    failFor = undefined;
  });

  it("logs 'up to date' and applies nothing when all migrations are recorded", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const names = fs
      .readdirSync(path.join(process.cwd(), "prisma", "tenant", "migrations"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    state.rule = listRule([A], (sql) => {
      if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: true }] };
      if (sql.startsWith("SELECT name FROM")) return { rows: names.map((name) => ({ name })) };
      return undefined;
    });
    await expect(migrateAllTenantSchemas()).resolves.toEqual({ failed: [] });
    expect(state.queries.some((q) => q.startsWith("SET LOCAL"))).toBe(false);
  });

  it("an invalid stored schema name is a per-tenant failure, never executed", async () => {
    state.rule = listRule(["bad;name"], () => ({ rows: [{ exists: true }] }));
    const result = await migrateAllTenantSchemas();
    expect(result.failed).toEqual(["bad;name"]);
    expect(state.queries.some((q) => q.includes("bad;name"))).toBe(false);
  });
});

describe("migration sources and baseline failure", () => {
  it("prefers the compiled dist/prisma-tenant/migrations folder when it exists", async () => {
    const fs = fsDefault;
    const real = fs.existsSync;
    const exists = vi.spyOn(fs, "existsSync").mockImplementation((p) => (String(p).includes("dist") ? true : real(p)));
    const readdir = vi.spyOn(fs, "readdirSync").mockImplementation((() => []) as never);
    try {
      state.rule = (sql: string) =>
        sql.includes("SELECT EXISTS") ? { rows: [{ exists: false }] } : sql.includes("COUNT(*)") ? { rows: [{ count: "0" }] } : undefined;
      await provisionTenantSchema(A);
      expect(readdir).toHaveBeenCalledWith(expect.stringContaining("dist"), { withFileTypes: true });
      expect(state.queries.some((q) => q.startsWith("SET LOCAL"))).toBe(false); // no migrations in the (mocked) dist folder
    } finally {
      exists.mockRestore();
      readdir.mockRestore();
    }
  });

  it("a failing baseline rolls back and the tenant is reported as failed", async () => {
    state.rule = (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM public."Tenant"')) return { rows: [{ schemaName: A }] };
      if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: false }] }; // no _migrations table -> baseline
      if (sql.includes("ON CONFLICT")) throw new Error("insert failed");
      void params;
      return undefined;
    };
    const result = await migrateAllTenantSchemas();
    expect(result.failed).toEqual([A]);
    expect(state.queries).toContain("ROLLBACK");
  });
});

describe("collecting migrations", () => {
  it("skips migration folders without a migration.sql or with an empty one", async () => {
    const realExists = fsDefault.existsSync;
    const entries = ["20260101_none", "20260102_empty", "20260103_real"].map((name) => ({ name, isDirectory: () => true }));
    vi.spyOn(fsDefault, "readdirSync").mockImplementation((() => entries) as never);
    vi.spyOn(fsDefault, "existsSync").mockImplementation((p) => {
      const s = String(p);
      if (s.includes("dist")) return false;
      return s.includes("20260101_none") ? false : s.includes("migrations") && s.endsWith("migration.sql") ? true : realExists(p);
    });
    vi.spyOn(fsDefault, "readFileSync").mockImplementation(((p: string) => (String(p).includes("20260102_empty") ? "  \n" : "SELECT 1;")) as never);

    state.rule = (sql: string) =>
      sql.includes("SELECT EXISTS") ? { rows: [{ exists: false }] } : sql.includes("COUNT(*)") ? { rows: [{ count: "0" }] } : undefined;
    await provisionTenantSchema(A);

    const applied = state.queries.filter((q) => q.includes("INSERT INTO") && q.includes("_migrations"));
    expect(applied).toHaveLength(1); // only 20260103_real was applied
  });
});

describe("connection string", () => {
  it("falls back to DATABASE_URL when DIRECT_URL is not set", async () => {
    const saved = process.env.DIRECT_URL;
    delete process.env.DIRECT_URL;
    try {
      state.rule = (sql: string) => (sql.includes("information_schema.tables") ? { rows: [{ exists: true }] } : undefined);
      await expect(provisionTenantSchema(A)).resolves.toBeUndefined();
      expect(state.connects).toBe(1);
    } finally {
      process.env.DIRECT_URL = saved;
    }
  });
});
