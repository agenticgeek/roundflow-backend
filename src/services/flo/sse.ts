import type { Response } from "express";
import type { FloEvent } from "./answer";

// SSE writer (plan 3.6). One JSON `data:` line per event, a `: ping` comment every 15 s so Railway and browsers keep the
// connection open, and the headers that stop proxies buffering the stream. The response stays open until the event
// source finishes. A client disconnect aborts the signal handed to the source (provider call and tools stop; the
// service still persists the ABORTED message) while the source is drained to its end.

export const HEARTBEAT_MS = 15_000;

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const PING = ": ping\n\n";

export interface SseOptions {
  heartbeatMs?: number;
  /** Extra response headers (e.g. Idempotent-Replay). */
  headers?: Record<string, string>;
}

export async function streamEvents(res: Response, run: (signal: AbortSignal) => AsyncIterable<FloEvent>, opts: SseOptions = {}): Promise<void> {
  const controller = new AbortController();
  res.status(200);
  res.set({ ...SSE_HEADERS, ...opts.headers });
  res.flushHeaders();

  const write = (chunk: string): void => {
    if (!res.writableEnded && !res.destroyed) res.write(chunk);
  };
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onClose);
  write(PING);
  const heartbeat = setInterval(() => write(PING), opts.heartbeatMs ?? HEARTBEAT_MS);
  try {
    for await (const ev of run(controller.signal)) write(frame(ev.event, ev.data));
  } catch (err) {
    console.error("[flo] stream failed:", err instanceof Error ? err.name : "unknown");
    write(frame("error", { code: "FLO_INTERNAL_ERROR", message: "Something went wrong on our side. Try again.", retryable: true }));
  } finally {
    clearInterval(heartbeat);
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
}
