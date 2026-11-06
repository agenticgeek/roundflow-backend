// BE-12: retry schedule for IntegrationOutbox rows (GHL sends, invoice.send). After the Nth failed attempt the row
// waits OUTBOX_BACKOFF_MS[N-1] (written to `runAfter`, which the worker already honours) before the next try; after
// OUTBOX_MAX_ATTEMPTS failures the row is `dead` and the office is notified. Total patience is about 7.7 hours
// (30 s, 2 min, 10 min, 1 h, 6 h) instead of the old 2.5 minutes.

export const OUTBOX_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
export const OUTBOX_MAX_ATTEMPTS = OUTBOX_BACKOFF_MS.length + 1;

/** Delay before the next try, given how many attempts have failed so far (1-based). */
export function outboxBackoffMs(failedAttempts: number): number {
  return OUTBOX_BACKOFF_MS[Math.min(Math.max(failedAttempts, 1), OUTBOX_BACKOFF_MS.length) - 1];
}
