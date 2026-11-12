import type { Request, RequestHandler, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { getRequestId } from "./request-id";

// BE-09: rate limiting. In-memory per process (one counter per instance); that is enough to blunt signup /
// invite-token / webhook floods and runaway clients. Multi-instance shared counters are Wave 2 scale-out work.
// Everything is configurable through env; `RATE_LIMIT_DISABLED=true` turns the whole thing off (tests, local).

export interface LimitSpec {
  windowMs: number;
  limit: number;
}

export interface RateLimitConfig {
  disabled: boolean;
  global: LimitSpec;
  signup: LimitSpec;
  invite: LimitSpec;
  webhook: LimitSpec;
  /** /settings/email/*: domain verification and test email call SES, so they are capped per IP. */
  emailAdmin: LimitSpec;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function rateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    disabled: env.RATE_LIMIT_DISABLED === "true",
    global: { windowMs: MINUTE, limit: positiveInt(env.RATE_LIMIT_GLOBAL_PER_MIN, 600) },
    signup: { windowMs: HOUR, limit: positiveInt(env.RATE_LIMIT_SIGNUP_PER_HOUR, 10) },
    invite: { windowMs: MINUTE, limit: positiveInt(env.RATE_LIMIT_INVITE_PER_MIN, 20) },
    webhook: { windowMs: MINUTE, limit: positiveInt(env.RATE_LIMIT_WEBHOOK_PER_MIN, 300) },
    emailAdmin: { windowMs: HOUR, limit: positiveInt(env.RATE_LIMIT_EMAIL_ADMIN_PER_HOUR, 60) },
  };
}

export interface LimiterOptions extends LimitSpec {
  disabled?: boolean;
  skip?: (req: Request) => boolean;
  /** Counter key per request (default: the client IP). Flo keys on the signed-in profile id. */
  keyGenerator?: (req: Request) => string;
}

/** A limiter that answers 429 `{ error, code: "RATE_LIMITED", requestId? }` with `Retry-After` (seconds). */
export function createLimiter({ windowMs, limit, disabled, skip, keyGenerator }: LimiterOptions): RequestHandler {
  if (disabled) return (_req, _res, next) => next();
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (req: Request, res: Response) => {
      const resetTime = (req as Request & { rateLimit: { resetTime: Date } }).rateLimit.resetTime;
      const seconds = Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
      res.set("Retry-After", String(seconds));
      const requestId = getRequestId(res);
      res.status(429).json({
        error: "Too many requests. Please slow down and try again shortly.",
        code: "RATE_LIMITED",
        ...(requestId ? { requestId } : {}),
      });
    },
  });
}
