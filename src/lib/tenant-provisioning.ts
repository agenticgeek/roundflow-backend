import { Client } from "pg";
import fs from "fs";
import path from "path";

function migrationsDir(): string {
  const fromDist = path.join(process.cwd(), "dist", "prisma-tenant", "migrations");
  if (fs.existsSync(fromDist)) return fromDist;
  return path.join(process.cwd(), "prisma", "tenant", "migrations");
}

function collectMigrationSQL(): string {
  const dir = migrationsDir();
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  return entries
    .map((name) => {
      const file = path.join(dir, name, "migration.sql");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function isAlreadyProvisioned(client: Client, schemaName: string): Promise<boolean> {
  // Check for BusinessSettings — the last table created by the migration.
  // Only true when the full migration committed successfully.
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'BusinessSettings'
     ) AS exists`,
    [schemaName]
  );
  return result.rows[0]?.exists === true;
}

// Create the Postgres schema and run all tenant migration SQL files in order.
// Uses a direct (non-pooled) connection so SET search_path persists across
// the whole session.
//
// Atomicity: migration SQL runs inside BEGIN/COMMIT. If anything fails the
// entire block rolls back, leaving the schema empty. The next call will see
// BusinessSettings is absent, drop and recreate the schema, and retry — safe
// because an empty schema has no data to lose.
//
// Idempotent: if BusinessSettings already exists, returns immediately.
export async function provisionTenantSchema(schemaName: string): Promise<void> {
  const client = new Client({
    connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  });
  await client.connect();
  try {
    if (await isAlreadyProvisioned(client, schemaName)) return;

    // Only drop if the schema is completely empty — that means a previous
    // attempt created the schema but the migration transaction rolled back,
    // leaving no tables. If tables exist but BusinessSettings is absent,
    // the schema has live data in an unexpected state; refuse to touch it.
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
    await client.query(`SET search_path TO "${schemaName}"`);

    const sql = collectMigrationSQL();
    if (sql) {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}
