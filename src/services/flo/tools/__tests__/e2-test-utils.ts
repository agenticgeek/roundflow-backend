import { expect } from "vitest";
import type { ToolOutput } from "../../types";
import { WRITE_METHODS, type FakePrisma } from "./fake-prisma";

// Shared assertions for the E2 tool tests: no secrets / notes / bodies leak and nothing is written.

export const CANARY = "CANARY-SECRET-9f2c";
/** Seeded into every fake row: fields the real tables hold that must never reach the provider. */
export const SECRETS = {
  bankSortCode: CANARY, bankAccountNumber: CANARY, accountNumber: CANARY, apiKey: CANARY, stripeAccessToken: CANARY, ghlAccessToken: CANARY,
  ghlWebhookSecret: CANARY, gocardlessAccessToken: CANARY, gocardlessMandateId: CANARY, stripeCustomerId: CANARY, passwordHash: CANARY, webhookSecret: CANARY,
  body: CANARY, note: CANARY, notes: CANARY, accessNotes: CANARY, riskNotes: CANARY, deliveryError: CANARY, externalId: CANARY, message: CANARY,
};
const FORBIDDEN_KEY = /bank|sortcode|accountnumber|token|secret|apikey|password|webhook|mandate|stripe(Id|Customer|Receipt)|^(body|note|notes|accessNotes|riskNotes|deliveryError|externalId|message)$/i;

export const keysDeep = (o: unknown, out: string[] = []): string[] => {
  if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
};

/** Rows have exactly the declared columns, no secret-ish keys, the canary never appears, no query asks for a secret, no write happened. */
export function expectSafe(out: ToolOutput, fp: FakePrisma): void {
  const keys = out.columns.map((c) => c.key);
  expect(keys.length).toBeGreaterThan(0);
  for (const row of out.rows) expect(Object.keys(row)).toEqual(keys);
  expect(keys.filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
  expect(Object.keys(out.totals ?? {}).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
  expect(JSON.stringify(out)).not.toContain(CANARY);
  expect(fp.calls.flatMap((c) => keysDeep(c.args)).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
  expect(fp.calls.filter((c) => (WRITE_METHODS as readonly string[]).some((m) => c.path.endsWith(`.${m}`) || c.path === m))).toEqual([]);
}
