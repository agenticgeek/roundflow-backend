import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { AppError } from "./app-error";
import { getRequestId } from "./request-id";

// Own properties every AppError carries that are already represented in the
// body (status line, `error`, `code`) or must never leak (`stack`).
const RESERVED = new Set(["statusCode", "code", "name", "message", "stack"]);

/** JSON body for an AppError: `{ error, code? }` plus any extra own fields a
 *  subclass adds (e.g. AllocationError.fields, NoMatchingRoundError.suggestions
 *  / proposedName), so routes no longer hand-roll those responses. */
export function appErrorBody(err: AppError): Record<string, unknown> {
  const body: Record<string, unknown> = { error: err.message };
  if (err.code) body.code = err.code;
  for (const [key, value] of Object.entries(err)) {
    if (!RESERVED.has(key) && value !== undefined) body[key] = value;
  }
  return body;
}

// Prisma connectivity failures: can't reach / timed out / connection closed
// (P1001, P1002, P1017), pool timeout (P2024) and client start-up failures.
// Matched by name + code so errors from either generated client are covered.
const DB_UNAVAILABLE_CODES = new Set(["P1001", "P1002", "P1017", "P2024"]);

export function isDatabaseUnavailable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown; errorCode?: unknown };
  if (e.name === "PrismaClientInitializationError") return true;
  const code = typeof e.code === "string" ? e.code : typeof e.errorCode === "string" ? e.errorCode : "";
  return typeof e.name === "string" && e.name.startsWith("PrismaClient") && DB_UNAVAILABLE_CODES.has(code);
}

/** Sends an error body, adding `requestId` (BE-09) whenever the request-id middleware ran. */
function sendError(res: Response, status: number, body: Record<string, unknown>) {
  const requestId = getRequestId(res);
  return res.status(status).json(requestId ? { ...body, requestId } : body);
}

// Centralised error handler. Must be last and take 4 args so Express treats it
// as error-handling middleware. Route handlers forward errors via next(err).
// Typed AppErrors carry their own status + message; anything else is a 500.
// Every body gets `requestId`; AppErrors may add `fields: [{ path, code, message }]`.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return sendError(res, err.statusCode, appErrorBody(err));
  }
  // express.json() body-parser errors. Oversized body → 413 (it used to fall through to a 500).
  if ((err as { type?: unknown } | null)?.type === "entity.too.large") {
    return sendError(res, 413, { error: "Request body is too large.", code: "PAYLOAD_TOO_LARGE" });
  }
  // express.json() body-parser SyntaxError (invalid JSON, null bytes, non-object strict-mode
  // rejection). The middleware sets err.status=400 and err.body on the thrown SyntaxError.
  if (err instanceof SyntaxError && (err as unknown as Record<string, unknown>).status === 400) {
    return sendError(res, 400, { error: "Invalid JSON in request body." });
  }
  // Prisma FK constraint violation — a referenced record still exists. Map to 409
  // so callers know the operation is blocked by a dependency, not a server bug.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
    return sendError(res, 409, { error: "Cannot delete: record is referenced by other data." });
  }
  if (isDatabaseUnavailable(err)) {
    console.error(err);
    res.set("Retry-After", "5");
    return sendError(res, 503, {
      error: "The service is temporarily unavailable. Please try again in a moment.",
      code: "DATABASE_UNAVAILABLE",
    });
  }
  console.error(err);
  sendError(res, 500, { error: "Internal Server Error" });
}
