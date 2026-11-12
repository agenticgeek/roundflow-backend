import type { RequestHandler } from "express";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { createIdempotency, IDEMPOTENCY_TTL_DAYS as TTL_DAYS } from "../lib/idempotency";

// Offline-replay dedup for /mobile/visits/:id/* writes (A8). The app queues actions while offline and replays
// them with the same X-Idempotency-Key, so a request that already succeeded must not run twice. Since Wave 2B-1
// (BE-17) the key row is inserted FIRST, so concurrent replays also execute once: see src/lib/idempotency.ts for the
// full state table (replay, 409 IDEMPOTENCY_IN_PROGRESS, 403 IDEMPOTENCY_KEY_CONFLICT, 409 IDEMPOTENCY_KEY_REUSED).
//
// - No header: the request runs normally.
// - Only 2xx responses are stored, so a request that failed validation (or with a 5xx) can be retried with the same key.
//
// Must run after requireTechnician (needs req.technician).

export const IDEMPOTENCY_HEADER = "x-idempotency-key";
export const IDEMPOTENCY_TTL_DAYS = TTL_DAYS;

export function idempotency(): RequestHandler {
  return createIdempotency({
    headers: [IDEMPOTENCY_HEADER],
    owner: (req) => ({ technicianId: req.technician!.id }),
  });
}

// Nightly purge (7-day TTL). Returns the number of records deleted.
export async function purgeIdempotencyRecords(tp: TenantPrismaClient, olderThan: Date): Promise<number> {
  const { count } = await tp.idempotencyRecord.deleteMany({ where: { createdAt: { lt: olderThan } } });
  return count;
}
