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
// Idempotent: if the schema is already fully provisioned (BusinessSettings
// table exists) the function returns immediately without touching anything.
export async function provisionTenantSchema(schemaName: string): Promise<void> {
  const client = new Client({
    connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  });
  await client.connect();
  try {
    const alreadyDone = await isAlreadyProvisioned(client, schemaName);
    if (alreadyDone) return;

    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}"`);
    const sql = collectMigrationSQL();
    if (sql) await client.query(sql);
  } finally {
    await client.end();
  }
}
