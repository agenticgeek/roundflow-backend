import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Flo migration is additive and idempotent (plan 3.7): safe to run twice, never drops or rewrites anything.
const dir = path.join(process.cwd(), "prisma", "tenant", "migrations", "20261110100000_flo_ai");
const sql = fs.readFileSync(path.join(dir, "migration.sql"), "utf8");
const schema = fs.readFileSync(path.join(process.cwd(), "prisma", "tenant", "schema.prisma"), "utf8");

describe("20261110100000_flo_ai migration", () => {
  it("is additive: no drops, truncates, deletes or alters of existing tables", () => {
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|DELETE FROM|\bUPDATE\s+"/i);
    for (const alter of sql.match(/ALTER TABLE\s+"?(\w+)"?/gi) ?? []) expect(alter).toMatch(/FloMessage/);
  });

  it("is idempotent: every CREATE TABLE/INDEX has IF NOT EXISTS, enums and the FK are guarded", () => {
    for (const m of sql.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^\n]*/g) ?? []) expect(m).toContain("IF NOT EXISTS");
    expect(sql.match(/CREATE TYPE/g)).toHaveLength(2);
    expect(sql.match(/EXCEPTION WHEN duplicate_object THEN NULL/g)).toHaveLength(3); // two enums + the FK
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2);
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(3);
  });

  it("matches the Prisma schema (tables, enums, indexes)", () => {
    for (const name of ["FloConversation", "FloMessage"]) {
      expect(schema).toContain(`model ${name} {`);
      expect(sql).toContain(`"${name}"`);
    }
    for (const e of ["FloRole", "FloMessageStatus"]) {
      expect(schema).toContain(`enum ${e} {`);
      expect(sql).toContain(`CREATE TYPE "${e}"`);
    }
    for (const col of ["profileId", "conversationId", "inputTokens", "outputTokens", "cachedTokens", "durationMs", "declineReason", "errorCode", "toolCalls", "warnings"]) {
      expect(schema).toContain(col);
      expect(sql).toContain(`"${col}"`);
    }
    expect(schema).toContain("@@index([profileId, updatedAt])");
    expect(schema).toContain("@@index([conversationId, createdAt])");
    expect(sql).toContain('"FloConversation_profileId_updatedAt_idx"');
    expect(sql).toContain('"FloMessage_conversationId_createdAt_idx"');
  });

  it("stores no secrets: no token, key or password column", () => {
    expect(sql).not.toMatch(/"[a-zA-Z]*(secret|apiKey|password)[a-zA-Z]*"|"(access|refresh|auth)?[Tt]oken"/i);
  });
});
