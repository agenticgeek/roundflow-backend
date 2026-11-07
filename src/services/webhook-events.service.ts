import { Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";

// BE-03: webhooks must not lose events. Chosen design (documented in ARCHITECTURE_LATEST.md section 20):
// process-then-ack with a durable per-event status.
//
//   1. Verify the signature, then INSERT a WebhookEvent row (status RECEIVED, payload stored). The unique
//      (source, externalId) key dedupes concurrent deliveries.
//   2. Run the handler (the effect: payment state, invoice, notifications).
//   3. Success: status DONE, payload dropped. Failure: status FAILED + attempts + lastError, and the HTTP response is
//      5xx so the provider redelivers. A redelivery of a FAILED / RECEIVED event runs the handler again.
//   4. The webhook retry sweep (jobs/webhookRetry.ts, every 2 minutes) re-runs FAILED rows and RECEIVED rows that
//      were abandoned (process crash between steps 1 and 3) with exponential backoff, up to WEBHOOK_MAX_ATTEMPTS.
//
// Handlers are idempotent (state-machine guarded, conditional updates), so running one twice is safe.

export const WEBHOOK_MAX_ATTEMPTS = 8;
const SWEEP_MIN_AGE_MS = 60_000;
const SWEEP_BATCH = 50;
const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];

export type WebhookSource = "stripe" | "gocardless" | "ghl" | "ses";
export type RecordState = "new" | "retry" | "duplicate";
export type ProcessState = "done" | "failed" | "duplicate";

/** Delay before attempt number `attempts + 1` may run: 1 min, 5 min, 30 min, 2 h, then 6 h. */
export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
}

/** Inserts the dedup row. "duplicate" = already DONE (skip); "retry" = known but unfinished (process again). */
export async function recordWebhookEvent(
  tp: TenantPrismaClient,
  source: string,
  externalId: string,
  payload: unknown
): Promise<RecordState> {
  try {
    await tp.webhookEvent.create({
      data: { source, externalId, status: "RECEIVED", payload: payload as Prisma.InputJsonValue },
    });
    return "new";
  } catch (err) {
    // Only a unique-constraint violation means "seen before". Anything else (transient DB failure) is rethrown so
    // the caller answers 5xx and the provider redelivers: nothing was recorded, nothing was lost.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const row = await tp.webhookEvent.findUnique({
      where: { source_externalId: { source, externalId } },
      select: { status: true },
    });
    return row && row.status !== "DONE" ? "retry" : "duplicate";
  }
}

/** Record + run + mark. Never throws for a handler failure (returns "failed"); throws only if bookkeeping fails. */
export async function processWebhookEvent(
  tp: TenantPrismaClient,
  source: string,
  externalId: string,
  payload: unknown,
  handler: () => Promise<void>,
  opts: { priorAttempts?: number } = {}
): Promise<ProcessState> {
  const state = await recordWebhookEvent(tp, source, externalId, payload);
  if (state === "duplicate") return "duplicate";
  const where = { source, externalId };
  try {
    await handler();
  } catch (err) {
    const lastError = String(err).slice(0, 500);
    await tp.webhookEvent.updateMany({
      where,
      data: { status: "FAILED", lastError, attempts: { increment: 1 } },
    });
    const attempts = (opts.priorAttempts ?? 0) + 1;
    if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
      console.error(`[webhook] ${source} event ${externalId} failed ${attempts} times, giving up:`, err);
    } else {
      console.error(`[webhook] ${source} event ${externalId} failed (will be retried):`, err);
    }
    return "failed";
  }
  await tp.webhookEvent.updateMany({ where, data: { status: "DONE", lastError: null, payload: Prisma.DbNull } });
  return "done";
}

export type SweepHandlers = Partial<Record<string, (payload: unknown) => Promise<void>>>;
export interface SweepResult {
  retried: number;
  done: number;
  failed: number;
  skipped: number;
}

/** One tenant's retry pass: re-runs FAILED / abandoned RECEIVED events that are past their backoff. */
export async function sweepWebhookEvents(tp: TenantPrismaClient, handlers: SweepHandlers, now = new Date()): Promise<SweepResult> {
  const rows = await tp.webhookEvent.findMany({
    where: {
      status: { in: ["FAILED", "RECEIVED"] },
      attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
      updatedAt: { lt: new Date(now.getTime() - SWEEP_MIN_AGE_MS) },
    },
    orderBy: { updatedAt: "asc" },
    take: SWEEP_BATCH,
  });

  const result: SweepResult = { retried: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const handler = handlers[row.source];
    if (row.payload === null || !handler) {
      // Nothing to replay with: park it so the sweep stops selecting it, and leave the error for the operator.
      await tp.webhookEvent.updateMany({
        where: { source: row.source, externalId: row.externalId },
        data: { status: "FAILED", attempts: WEBHOOK_MAX_ATTEMPTS, lastError: "No stored payload or handler: cannot be retried" },
      });
      result.skipped++;
      continue;
    }
    if (now.getTime() - row.updatedAt.getTime() < backoffMs(row.attempts)) {
      result.skipped++;
      continue;
    }
    result.retried++;
    const outcome = await processWebhookEvent(tp, row.source, row.externalId, row.payload, () => handler(row.payload), {
      priorAttempts: row.attempts,
    });
    if (outcome === "done") result.done++;
    else if (outcome === "failed") result.failed++;
  }
  return result;
}
