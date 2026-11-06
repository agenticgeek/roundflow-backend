// BE-09: every outbound HTTP call carries a timeout so a hung provider cannot pin a request, a cron run or a
// worker slot forever. `OUTBOUND_TIMEOUT_MS` overrides the default (15 s); PDF rendering gets a longer budget.

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 15_000;
export const PDF_OUTBOUND_TIMEOUT_MS = 60_000;

export function outboundTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OUTBOUND_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_OUTBOUND_TIMEOUT_MS;
}

/** AbortSignal that fires after `ms` (default: OUTBOUND_TIMEOUT_MS or 15 s). */
export function outboundSignal(ms: number = outboundTimeoutMs()): AbortSignal {
  return AbortSignal.timeout(ms);
}
