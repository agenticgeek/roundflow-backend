import { Client } from "pg";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Migration tracking — every tenant schema carries a "_migrations" table that
// records which migration directories have been applied. This lets the startup
// migrator apply only the pending ones to each existing tenant, and lets new
// tenant provisioning stay consistent from day one.
// ---------------------------------------------------------------------------

interface Migration {
  name: string;
  sql: string;
}

function migrationsDir(): string {
  const fromDist = path.join(process.cwd(), "dist", "prisma-tenant", "migrations");
  if (fs.existsSync(fromDist)) return fromDist;
  return path.join(process.cwd(), "prisma", "tenant", "migrations");
}

function collectMigrations(): Migration[] {
  const dir = migrationsDir();
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .flatMap((name) => {
      const file = path.join(dir, name, "migration.sql");
      if (!fs.existsSync(file)) return [];
      const sql = fs.readFileSync(file, "utf8").trim();
      return sql ? [{ name, sql }] : [];
    });
}

function dbClient(): Client {
  return new Client({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
}

// ---------------------------------------------------------------------------
// Schema-level helpers
// ---------------------------------------------------------------------------

async function tableExists(
  client: Client,
  schemaName: string,
  tableName: string
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2
     ) AS exists`,
    [schemaName, tableName]
  );
  return result.rows[0]?.exists === true;
}

async function createMigrationsTable(client: Client, schemaName: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."_migrations" (
      name TEXT PRIMARY KEY,
      "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(client: Client, schemaName: string): Promise<Set<string>> {
  const result = await client.query<{ name: string }>(
    `SELECT name FROM "${schemaName}"."_migrations"`
  );
  return new Set(result.rows.map((r) => r.name));
}

// Apply a single migration inside its own transaction, then record it.
// SET LOCAL search_path scopes the path to this transaction only.
async function applyMigration(
  client: Client,
  schemaName: string,
  migration: Migration
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO "${schemaName}"`);
    await client.query(migration.sql);
    await client.query(`INSERT INTO "${schemaName}"."_migrations" (name) VALUES ($1)`, [
      migration.name,
    ]);
    await client.query("COMMIT");
    console.log(`[migration] ${schemaName}: applied ${migration.name}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// For tenants provisioned before tracking existed: create _migrations and mark
// all known migrations as applied without re-running them. Called only once per
// tenant (the next startup sees _migrations present and falls through to the
// normal pending-check path).
async function baselineMigrations(
  client: Client,
  schemaName: string,
  migrations: Migration[]
): Promise<void> {
  await client.query("BEGIN");
  try {
    await createMigrationsTable(client, schemaName);
    for (const m of migrations) {
      await client.query(
        `INSERT INTO "${schemaName}"."_migrations" (name) VALUES ($1) ON CONFLICT DO NOTHING`,
        [m.name]
      );
    }
    await client.query("COMMIT");
    console.log(`[migration] ${schemaName}: baselined ${migrations.length} migration(s)`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Create the Postgres schema and run all tenant migrations in order, recording
// each one. Used when provisioning a brand-new tenant.
//
// Idempotent: if BusinessSettings already exists the schema is fully
// provisioned and the call returns immediately.
export async function provisionTenantSchema(schemaName: string): Promise<void> {
  const migrations = collectMigrations();
  const client = dbClient();
  await client.connect();
  try {
    if (await tableExists(client, schemaName, "BusinessSettings")) return;

    // If tables exist but BusinessSettings is absent the schema is in an
    // unexpected state — refuse to touch it.
    const tableCount = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = $1`,
      [schemaName]
    );
    if (Number(tableCount.rows[0].count) > 0) {
      throw new Error(
        `Schema "${schemaName}" has tables but is not fully provisioned. Manual intervention required.`
      );
    }

    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await client.query(`CREATE SCHEMA "${schemaName}"`);

    // Create tracking table first so every migration is recorded as it lands.
    await createMigrationsTable(client, schemaName);

    for (const m of migrations) {
      await applyMigration(client, schemaName, m);
    }
  } finally {
    await client.end();
  }
}

// Run on server startup: iterate every tenant schema and apply any migrations
// that have not yet been recorded in its _migrations table.
//
// Tenants provisioned before tracking was introduced are baselined — all
// known migrations are marked applied without re-running them (they were
// already applied during initial provisioning or manually thereafter).
//
// Individual tenant failures are logged but do not abort the loop so that
// one broken schema cannot prevent the rest of the app from starting.
export async function migrateAllTenantSchemas(): Promise<void> {
  const migrations = collectMigrations();

  // Pull the list of tenant schemas from the public schema.
  const listClient = dbClient();
  await listClient.connect();
  let schemas: string[] = [];
  try {
    const result = await listClient.query<{ schemaName: string }>(
      `SELECT "schemaName" FROM public."Tenant" ORDER BY "createdAt"`
    );
    schemas = result.rows.map((r) => r.schemaName);
  } finally {
    await listClient.end();
  }

  if (schemas.length === 0) {
    console.log("[migration] no tenant schemas found — skipping");
    return;
  }

  console.log(`[migration] checking ${schemas.length} tenant schema(s)…`);

  for (const schemaName of schemas) {
    const client = dbClient();
    await client.connect();
    try {
      const hasTracking = await tableExists(client, schemaName, "_migrations");

      if (!hasTracking) {
        // Pre-tracking tenant — baseline without re-applying.
        await baselineMigrations(client, schemaName, migrations);
        continue;
      }

      const applied = await getAppliedMigrations(client, schemaName);
      const pending = migrations.filter((m) => !applied.has(m.name));

      if (pending.length === 0) {
        console.log(`[migration] ${schemaName}: up to date`);
        continue;
      }

      for (const m of pending) {
        await applyMigration(client, schemaName, m);
      }
    } catch (err) {
      console.error(`[migration] ${schemaName}: FAILED —`, err);
    } finally {
      await client.end();
    }
  }
}
