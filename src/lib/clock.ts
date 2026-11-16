import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "./app-error";

// Test clock (business closures, option A). Lets e2e set "now" per request via
// the X-Test-Now header. INERT unless ALLOW_TEST_CLOCK=1 and NODE_ENV is not
// production; the env is read at call time so nothing is decided at import.

const storage = new AsyncLocalStorage<{ at: Date }>();

export function testClockEnabled(): boolean {
  return process.env.ALLOW_TEST_CLOCK === "1" && process.env.NODE_ENV !== "production";
}

/** The request-scoped test time when one is set, else the real clock. */
export function now(): Date {
  // Defence in depth: even if a store were somehow set, production never reads it.
  const at = testClockEnabled() ? storage.getStore()?.at : undefined;
  // A copy: callers mutate (setUTCHours) and must not corrupt the request clock.
  return at ? new Date(at.getTime()) : new Date();
}

export function runWithClock<T>(at: Date, fn: () => T): T {
  return storage.run({ at }, fn);
}

/** Honours `X-Test-Now` (ISO instant) only while the test clock is enabled. */
export function testClockMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!testClockEnabled()) return next();
  const raw = req.header("x-test-now");
  if (raw === undefined) return next();
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    return next(new AppError(400, "X-Test-Now must be an ISO 8601 instant", "INVALID_TEST_NOW"));
  }
  runWithClock(at, next);
}
